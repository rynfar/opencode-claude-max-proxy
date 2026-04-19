/**
 * SessionRuntime — owns one live SDK query() per logical session.
 *
 * Keeps the query alive across HTTP turns using streaming-input mode so that
 * the SDK's in-memory prefix stays byte-continuous and Anthropic's prompt
 * cache hits on resumed turns. See
 * `openspec/changes/persistent-sdk-sessions/design.md` for the rationale and
 * `openspec/changes/persistent-sdk-sessions/spike-notes.md` for the empirical
 * terminator (`event.type === "result"`).
 *
 * This module is side-effect free at import time; the manager is constructed
 * by `server.ts` when the persistent-sessions feature flag is on.
 */

import { createHash } from "node:crypto"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { LRUMap } from "../../utils/lruMap"

// --- AsyncQueue: single-writer AsyncIterable backing the SDK input stream ---

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void
  close(): void
  readonly closed: boolean
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffer: T[] = []
  const waiters: Array<(value: IteratorResult<T>) => void> = []
  let closed = false

  return {
    get closed() { return closed },
    push(value: T): void {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false })
      else buffer.push(value)
    },
    close(): void {
      if (closed) return
      closed = true
      while (waiters.length) waiters.shift()!({ value: undefined as unknown as T, done: true })
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => new Promise((resolve) => {
          if (buffer.length) resolve({ value: buffer.shift()!, done: false })
          else if (closed) resolve({ value: undefined as unknown as T, done: true })
          else waiters.push(resolve)
        }),
      }
    },
  }
}

// --- Mutex: serializes turns within a single SessionRuntime ---

export interface Mutex {
  acquire(timeoutMs?: number): Promise<() => void>
  readonly locked: boolean
}

export function createMutex(): Mutex {
  let locked = false
  const queue: Array<(release: () => void) => void> = []

  const release = () => {
    if (!locked && queue.length === 0) return
    const next = queue.shift()
    if (next) next(release)
    else locked = false
  }

  return {
    get locked() { return locked },
    acquire(timeoutMs?: number): Promise<() => void> {
      return new Promise((resolve, reject) => {
        const timer = timeoutMs != null
          ? setTimeout(() => {
              const idx = queue.indexOf(resolver)
              if (idx !== -1) queue.splice(idx, 1)
              reject(new Error(`Mutex acquire timed out after ${timeoutMs}ms`))
            }, timeoutMs)
          : null

        const resolver = (r: () => void) => {
          if (timer) clearTimeout(timer)
          resolve(r)
        }

        if (!locked) {
          locked = true
          resolver(release)
        } else {
          queue.push(resolver)
        }
      })
    },
  }
}

// --- Options-hash helpers ---

/**
 * The subset of SDK options that cannot be changed mid-session. If any of
 * these differ between turns, the runtime MUST close and reopen with
 * `resume` (see design.md D4).
 */
export interface ReopenCriticalOptions {
  cwd?: string
  systemPrompt?: unknown
  mcpServerNames?: readonly string[]
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
  settingSources?: readonly string[]
  passthroughToolNames?: readonly string[]
}

/** Stable-stringify + SHA-256 truncated to 16 chars. */
export function hashReopenCriticalOptions(options: ReopenCriticalOptions): string {
  const normalized = stableStringify({
    cwd: options.cwd ?? null,
    systemPrompt: options.systemPrompt ?? null,
    mcpServerNames: sortedOrNull(options.mcpServerNames),
    allowedTools: sortedOrNull(options.allowedTools),
    disallowedTools: sortedOrNull(options.disallowedTools),
    settingSources: sortedOrNull(options.settingSources),
    passthroughToolNames: sortedOrNull(options.passthroughToolNames),
  })
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

function sortedOrNull(xs: readonly string[] | undefined): string[] | null {
  if (!xs || xs.length === 0) return null
  return [...xs].sort()
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

// --- Per-turn terminator (from spike-notes) ---

/** The SDK event type that signals the end of a single turn. */
export const TURN_TERMINATOR_EVENT = "result" as const

export function isTurnTerminator(message: SDKMessage): boolean {
  return (message as { type?: unknown }).type === TURN_TERMINATOR_EVENT
}

// --- Pending tool executions (passthrough deferred-handler pattern) ---

/**
 * An in-flight client-executed tool call. The passthrough MCP handler
 * created this entry and is awaiting its `resolve`; meridian resolves with
 * the real `tool_result` content on the client's next HTTP request (see
 * design.md §D11 and the §1d spike scenarios).
 */
export interface PendingExecution {
  toolUseId: string
  createdAt: number
  resolve: (content: string) => void
  reject: (err: unknown) => void
}

/**
 * Partition of incoming user-message content blocks into two groups:
 * `resolve` — `tool_result` blocks whose `tool_use_id` matches an existing
 * pending execution (to be resolved, NOT pushed as input); `pushContent` —
 * the remainder (to be pushed as an `SDKUserMessage`). Mixed messages keep
 * their non-tool_result blocks in `pushContent` so text or images still
 * reach the SDK.
 */
export interface PassthroughClassification {
  resolve: Array<{ toolUseId: string; content: string }>
  pushContent: unknown[] | null
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  // Anthropic tool_result content is `string | ContentBlockParam[]`; for the
  // block form we flatten text blocks into a single string.
  const parts: string[] = []
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    const block = b as { type?: unknown; text?: unknown }
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n")
}

/**
 * Partition a user-message content array. Blocks of `type: "tool_result"` whose
 * `tool_use_id` is in `pendingToolUseIds` are diverted to the `resolve` list;
 * everything else stays in `pushContent`. If `pushContent` would be an empty
 * array (all blocks diverted), it becomes `null` to signal "no push needed".
 */
export function classifyPassthroughRequest(
  content: unknown,
  pendingToolUseIds: ReadonlySet<string>,
): PassthroughClassification {
  if (!Array.isArray(content)) {
    return { resolve: [], pushContent: content === undefined ? null : [] }
  }
  const resolve: Array<{ toolUseId: string; content: string }> = []
  const remainder: unknown[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") { remainder.push(block); continue }
    const b = block as { type?: unknown; tool_use_id?: unknown; content?: unknown }
    if (b.type === "tool_result" && typeof b.tool_use_id === "string" && pendingToolUseIds.has(b.tool_use_id)) {
      resolve.push({ toolUseId: b.tool_use_id, content: extractToolResultText(b.content) })
      continue
    }
    remainder.push(block)
  }
  return {
    resolve,
    pushContent: remainder.length === 0 ? null : remainder,
  }
}

// --- SessionRuntime ---

export interface SessionRuntimeInit {
  profileSessionId: string
  optionsHash: string
  query: Query
  inputQueue: AsyncQueue<SDKUserMessage>
  onCrash?: (err: unknown) => void
  /** Current time source — overridable in tests. */
  now?: () => number
}

export interface SessionRuntime {
  readonly profileSessionId: string
  readonly optionsHash: string
  readonly inputQueue: AsyncQueue<SDKUserMessage>
  readonly query: Query
  /** Claude SDK session id captured from the first `result` event. */
  claudeSessionId: string | null
  lastActivity: number
  /** True once close() has been called or the query has terminated. */
  closed: boolean
  /** Serializes pushTurn calls — only one turn per runtime at a time. */
  acquireTurn(timeoutMs?: number): Promise<() => void>
  /**
   * Read events for the current turn until the turn terminator is observed.
   * The caller MUST hold the mutex (via acquireTurn) before calling this.
   * Yields every event including the terminator.
   */
  consumeTurn(): AsyncIterable<SDKMessage>
  close(): Promise<void>

  // --- Passthrough deferred-handler registry (design §D11) ---

  /** Register a pending entry that a later client request will resolve. */
  registerPendingExecution(toolUseId: string): Promise<string>
  /** Resolve a pending entry with real tool_result content from the client. */
  resolvePendingExecution(toolUseId: string, content: string): boolean
  /** Reject a pending entry (timeout, shutdown, explicit cancel). */
  rejectPendingExecution(toolUseId: string, err: unknown): boolean
  /** Reject every currently-pending entry — used by shutdown / eviction. */
  rejectAllPending(err: unknown): number
  /** Read-only snapshot of pending tool_use_ids; used by request classifier. */
  readonly pendingToolUseIds: ReadonlySet<string>
  /** How many pending handlers are currently awaiting. */
  readonly pendingCount: number
}

export function createSessionRuntime(init: SessionRuntimeInit): SessionRuntime {
  const mutex = createMutex()
  let closed = false
  let claudeSessionId: string | null = null
  // Cache the async iterator ONCE so consumeTurn can resume reading between
  // turns. Using `for await (const m of query)` inside consumeTurn breaks the
  // runtime on early exit (`return`) because the for-await protocol invokes
  // `iterator.return()` to clean up, which marks the iterator as done and
  // causes subsequent next() calls to yield `{done: true}`. Manual iteration
  // via `.next()` preserves the query across turns.
  const queryIter: AsyncIterator<SDKMessage, void> = (init.query as AsyncIterator<SDKMessage, void>)
  const now = init.now ?? (() => Date.now())

  // Pending deferred handlers for passthrough tool execution.
  const pending = new Map<string, PendingExecution>()

  const runtime: SessionRuntime = {
    profileSessionId: init.profileSessionId,
    optionsHash: init.optionsHash,
    inputQueue: init.inputQueue,
    query: init.query,
    get claudeSessionId() { return claudeSessionId },
    set claudeSessionId(v: string | null) { claudeSessionId = v },
    lastActivity: Date.now(),
    get closed() { return closed },
    set closed(v: boolean) { closed = v },
    async acquireTurn(timeoutMs?: number) {
      if (closed) throw new Error(`SessionRuntime ${init.profileSessionId} is closed`)
      const release = await mutex.acquire(timeoutMs)
      return release
    },
    async *consumeTurn(): AsyncIterable<SDKMessage> {
      try {
        while (true) {
          const step: IteratorResult<SDKMessage, void> = await queryIter.next()
          if (step.done) {
            throw new Error(`SessionRuntime ${init.profileSessionId} query ended before turn terminator`)
          }
          const message = step.value
          runtime.lastActivity = Date.now()
          const sid = (message as { session_id?: unknown }).session_id
          if (typeof sid === "string" && !claudeSessionId) claudeSessionId = sid
          yield message
          if (isTurnTerminator(message)) return
        }
      } catch (err) {
        if (!closed) init.onCrash?.(err)
        throw err
      }
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      // Reject every pending handler so the SDK unblocks and the subprocess
      // can terminate cleanly.
      for (const [, entry] of pending) {
        try { entry.reject(new Error("SessionRuntime closed")) } catch { /* ignore */ }
      }
      pending.clear()
      try { init.query.close() } catch { /* ignore */ }
      init.inputQueue.close()
    },

    async registerPendingExecution(toolUseId: string): Promise<string> {
      if (closed) {
        throw new Error(`SessionRuntime ${init.profileSessionId} is closed`)
      }
      return await new Promise<string>((resolve, reject) => {
        pending.set(toolUseId, {
          toolUseId,
          createdAt: now(),
          resolve: (content: string) => {
            pending.delete(toolUseId)
            resolve(content)
          },
          reject: (err: unknown) => {
            pending.delete(toolUseId)
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        })
      })
    },

    resolvePendingExecution(toolUseId: string, content: string): boolean {
      const entry = pending.get(toolUseId)
      if (!entry) return false
      entry.resolve(content)
      return true
    },

    rejectPendingExecution(toolUseId: string, err: unknown): boolean {
      const entry = pending.get(toolUseId)
      if (!entry) return false
      entry.reject(err)
      return true
    },

    rejectAllPending(err: unknown): number {
      const count = pending.size
      for (const [, entry] of pending) {
        try { entry.reject(err) } catch { /* ignore */ }
      }
      pending.clear()
      return count
    },

    get pendingToolUseIds(): ReadonlySet<string> {
      return new Set(pending.keys())
    },

    get pendingCount(): number {
      return pending.size
    },
  }
  return runtime
}

// --- SessionRuntimeManager ---

export interface SessionRuntimeManagerConfig {
  idleMs: number
  maxLive: number
  now?: () => number
}

export interface SessionRuntimeManager {
  get(profileSessionId: string): SessionRuntime | undefined
  put(runtime: SessionRuntime): void
  drop(profileSessionId: string): Promise<void>
  size: number
  sweepIdle(): Promise<number>
  closeAll(timeoutMs?: number): Promise<void>
}

export function createSessionRuntimeManager(config: SessionRuntimeManagerConfig): SessionRuntimeManager {
  const now = config.now ?? (() => Date.now())

  const map = new LRUMap<string, SessionRuntime>(config.maxLive, (_key, evicted) => {
    void evicted.close()
  })

  const manager: SessionRuntimeManager = {
    get(profileSessionId: string): SessionRuntime | undefined {
      const r = map.get(profileSessionId)
      if (!r) return undefined
      if (r.closed) {
        map.delete(profileSessionId)
        return undefined
      }
      return r
    },
    put(runtime: SessionRuntime): void {
      map.set(runtime.profileSessionId, runtime)
    },
    async drop(profileSessionId: string): Promise<void> {
      const r = map.get(profileSessionId)
      if (!r) return
      map.delete(profileSessionId)
      await r.close()
    },
    get size(): number { return map.size },
    async sweepIdle(): Promise<number> {
      const cutoff = now() - config.idleMs
      const toEvict: string[] = []
      for (const [key, runtime] of map.entries()) {
        if (runtime.lastActivity < cutoff) toEvict.push(key)
      }
      for (const key of toEvict) {
        const r = map.get(key)
        if (!r) continue
        map.delete(key)
        await r.close()
      }
      return toEvict.length
    },
    async closeAll(timeoutMs = 10_000): Promise<void> {
      const all = [...map.values()]
      map.clear()
      await Promise.race([
        Promise.all(all.map((r) => r.close())),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    },
  }
  return manager
}
