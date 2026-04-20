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
  /** Current buffered depth — useful for telemetry. */
  readonly depth: number
}

export interface AsyncQueueOptions {
  /**
   * Soft high-water mark. When buffered depth crosses this threshold,
   * `onHighWater` fires with the current depth so the caller can emit
   * telemetry. Pushes continue to succeed.
   */
  highWaterMark?: number
  /**
   * Hard cap. Pushes beyond this throw `AsyncQueueOverflowError`. The
   * caller is expected to translate the throw into HTTP 503 or equivalent
   * backpressure at the request boundary. Default `Infinity` (unbounded).
   */
  hardCap?: number
  /**
   * Invoked whenever a push crosses `highWaterMark` upward. No-op by
   * default. `depth` is the post-push buffered size.
   */
  onHighWater?: (depth: number) => void
}

export class AsyncQueueOverflowError extends Error {
  readonly depth: number
  readonly hardCap: number
  constructor(depth: number, hardCap: number) {
    super(`AsyncQueue push rejected: depth ${depth} would exceed hardCap ${hardCap}`)
    this.name = "AsyncQueueOverflowError"
    this.depth = depth
    this.hardCap = hardCap
  }
}

export function createAsyncQueue<T>(opts: AsyncQueueOptions = {}): AsyncQueue<T> {
  const buffer: T[] = []
  const waiters: Array<(value: IteratorResult<T>) => void> = []
  let closed = false
  const highWaterMark = opts.highWaterMark ?? Infinity
  const hardCap = opts.hardCap ?? Infinity
  const onHighWater = opts.onHighWater
  let aboveHighWater = false

  return {
    get closed() { return closed },
    get depth() { return buffer.length },
    push(value: T): void {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) {
        waiter({ value, done: false })
        return
      }
      if (buffer.length >= hardCap) {
        throw new AsyncQueueOverflowError(buffer.length + 1, hardCap)
      }
      buffer.push(value)
      if (buffer.length > highWaterMark) {
        if (!aboveHighWater) {
          aboveHighWater = true
          try { onHighWater?.(buffer.length) } catch { /* swallow telemetry errors */ }
        }
      } else {
        aboveHighWater = false
      }
    },
    close(): void {
      if (closed) return
      closed = true
      while (waiters.length) waiters.shift()!({ value: undefined as unknown as T, done: true })
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => new Promise((resolve) => {
          if (buffer.length) {
            const value = buffer.shift()!
            if (buffer.length <= highWaterMark) aboveHighWater = false
            resolve({ value, done: false })
          } else if (closed) {
            resolve({ value: undefined as unknown as T, done: true })
          } else {
            waiters.push(resolve)
          }
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

// --- Continuation-after-pending marker (§5.12d SSE framing) ---

/**
 * Per-runtime state set by the turn runner when it emits a `tool_use`
 * pending-pause synthetic result and read by the server SSE layer at the
 * start of the NEXT HTTP turn. Persistent mode splits a single SDK
 * message across two HTTP responses (request 1 emits tool_use blocks
 * and closes; request 2 delivers the tool_result and the SDK continues
 * the SAME message). Without this marker, request 2's first stream
 * events are mid-message `content_block_*` — no preceding `message_start`
 * — and strict SSE clients (Pi) reject the sequence.
 *
 * The runtime doesn't interpret the flag itself; it's a side-channel
 * that crosses the `turnRunner → server.ts SSE` boundary. Kept in a
 * WeakMap so the `SessionRuntime` interface stays tight and the marker
 * disappears automatically when the runtime is GC'd.
 */
const continuationFlags = new WeakMap<SessionRuntime, boolean>()

export function markRuntimeContinuation(runtime: SessionRuntime): void {
  continuationFlags.set(runtime, true)
}

export function consumeRuntimeContinuation(runtime: SessionRuntime): boolean {
  const flagged = continuationFlags.get(runtime) === true
  if (flagged) continuationFlags.delete(runtime)
  return flagged
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
    // Non-array content: `null` / `undefined` → nothing to push; string or
    // single-object block → wrap in a one-element array so the payload
    // survives. No `tool_result` matching happens here because `tool_result`
    // correlation requires the canonical content-block array shape.
    if (content === undefined || content === null) {
      return { resolve: [], pushContent: null }
    }
    return { resolve: [], pushContent: [content] }
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
  /**
   * Legacy options-hash field. Kept for test fixtures and back-compat but
   * unused by the dispatcher — drift detection goes through
   * `attachDispatchState`/`getDispatchState` on a per-runtime WeakMap. Safe
   * to omit.
   */
  optionsHash?: string
  query: Query
  inputQueue: AsyncQueue<SDKUserMessage>
  onCrash?: (err: unknown) => void
  /** Current time source — overridable in tests. */
  now?: () => number
  /**
   * Idle timeout (ms) for pending deferred-handler promises. When a client
   * abandons a tool call (never returns with tool_result), the handler
   * rejects after this interval so the SDK unblocks + runtime can be
   * recovered or evicted (§5.12f). Default `Infinity` (no timeout).
   */
  pendingExecutionTimeoutMs?: number
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
  /** True when a turn currently holds the per-runtime mutex. */
  readonly turnInFlight: boolean
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

  /**
   * PreToolUse → MCP handler coordination FIFO.
   *
   * The PreToolUse hook fires before the SDK invokes the corresponding MCP
   * handler and has access to `tool_use_id`; the MCP handler (via the
   * `@modelcontextprotocol/sdk` signature) does NOT. The hook enqueues the
   * id onto a per-tool-name queue; the handler dequeues the head of its
   * queue to correlate. FIFO ordering is preserved because the SDK fires
   * handlers sequentially and PreToolUse always fires strictly before the
   * handler it corresponds to.
   */
  enqueueToolUseId(toolName: string, toolUseId: string): void
  dequeueToolUseId(toolName: string): string | undefined
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
  // Active idle-timeout handles, keyed by tool_use_id (§5.12f).
  const pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  const pendingTimeoutMs = init.pendingExecutionTimeoutMs ?? Infinity
  // Per-tool-name FIFO of captured tool_use_ids (PreToolUse → MCP handler).
  const toolUseIdFifo = new Map<string, string[]>()

  const runtime: SessionRuntime = {
    profileSessionId: init.profileSessionId,
    optionsHash: init.optionsHash ?? "",
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
    get turnInFlight(): boolean { return mutex.locked },
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
      // Clear outstanding idle timers (§5.12f) so they don't fire post-close.
      for (const [, h] of pendingTimeouts) clearTimeout(h)
      pendingTimeouts.clear()
      try { init.query.close() } catch { /* ignore */ }
      init.inputQueue.close()
    },

    async registerPendingExecution(toolUseId: string): Promise<string> {
      if (closed) {
        throw new Error(`SessionRuntime ${init.profileSessionId} is closed`)
      }
      return await new Promise<string>((resolve, reject) => {
        const clearIdleTimer = () => {
          const h = pendingTimeouts.get(toolUseId)
          if (h) {
            clearTimeout(h)
            pendingTimeouts.delete(toolUseId)
          }
        }
        pending.set(toolUseId, {
          toolUseId,
          createdAt: now(),
          resolve: (content: string) => {
            clearIdleTimer()
            pending.delete(toolUseId)
            resolve(content)
          },
          reject: (err: unknown) => {
            clearIdleTimer()
            pending.delete(toolUseId)
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        })
        if (Number.isFinite(pendingTimeoutMs)) {
          const handle = setTimeout(() => {
            const entry = pending.get(toolUseId)
            if (!entry) return
            entry.reject(new Error(
              `pending deferred handler for tool_use_id ${toolUseId} timed out after ${pendingTimeoutMs}ms`,
            ))
          }, pendingTimeoutMs)
          if ((handle as NodeJS.Timeout).unref) (handle as NodeJS.Timeout).unref()
          pendingTimeouts.set(toolUseId, handle)
        }
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
      // Clear any outstanding idle timers so they don't fire post-close.
      for (const [, h] of pendingTimeouts) clearTimeout(h)
      pendingTimeouts.clear()
      return count
    },

    get pendingToolUseIds(): ReadonlySet<string> {
      return new Set(pending.keys())
    },

    get pendingCount(): number {
      return pending.size
    },

    enqueueToolUseId(toolName: string, toolUseId: string): void {
      const queue = toolUseIdFifo.get(toolName) ?? []
      queue.push(toolUseId)
      toolUseIdFifo.set(toolName, queue)
    },

    dequeueToolUseId(toolName: string): string | undefined {
      const queue = toolUseIdFifo.get(toolName)
      if (!queue || queue.length === 0) return undefined
      const id = queue.shift()
      if (queue.length === 0) toolUseIdFifo.delete(toolName)
      return id
    },
  }
  return runtime
}

// --- SessionRuntimeManager ---

export type RuntimeLifecycleEvent =
  | "create"
  | "reattach"
  | "reopen"
  | "evict"
  | "close"
  | "crash-recover"

export interface RuntimeLifecycleCounters {
  live: number
  creates: number
  evictions: number
  reopens: number
  crashRecovers: number
}

export interface SessionRuntimeManagerConfig {
  idleMs: number
  maxLive: number
  now?: () => number
  /**
   * Observability hook — fires on every runtime lifecycle transition
   * (create / reattach / reopen / evict / close / crash-recover). No-op by
   * default. Consumers wire this to the existing log / trace channel
   * (§7.2).
   */
  onLifecycle?: (event: RuntimeLifecycleEvent, profileSessionId: string) => void
}

export interface SessionRuntimeManager {
  get(profileSessionId: string): SessionRuntime | undefined
  put(runtime: SessionRuntime): void
  drop(profileSessionId: string): Promise<void>
  size: number
  sweepIdle(): Promise<number>
  closeAll(timeoutMs?: number): Promise<void>
  /** Telemetry snapshot of cumulative counters (§7.3). */
  readonly counters: RuntimeLifecycleCounters
  /** Emit a custom lifecycle event (used by the dispatcher for `reopen`). */
  emitLifecycle(event: RuntimeLifecycleEvent, profileSessionId: string): void
}

export function createSessionRuntimeManager(config: SessionRuntimeManagerConfig): SessionRuntimeManager {
  const now = config.now ?? (() => Date.now())
  const counters: RuntimeLifecycleCounters = {
    live: 0,
    creates: 0,
    evictions: 0,
    reopens: 0,
    crashRecovers: 0,
  }
  const emit = (event: RuntimeLifecycleEvent, profileSessionId: string) => {
    switch (event) {
      case "create": counters.creates++; break
      case "reopen": counters.reopens++; break
      case "evict": counters.evictions++; break
      case "crash-recover": counters.crashRecovers++; break
      // `reattach` + `close` don't bump creates/evictions — they're
      // transitions observable via `live` changes alone.
    }
    try { config.onLifecycle?.(event, profileSessionId) } catch { /* swallow telemetry errors */ }
  }

  const map = new LRUMap<string, SessionRuntime>(config.maxLive, (key, evicted) => {
    counters.live = Math.max(0, counters.live - 1)
    emit("evict", key)
    // Fire-and-forget close on LRU eviction; swallow errors so a throwing
    // close (e.g. SDK subprocess already dead) doesn't produce an
    // unhandled-rejection.
    evicted.close().catch(() => {})
  })

  const manager: SessionRuntimeManager = {
    get(profileSessionId: string): SessionRuntime | undefined {
      const r = map.get(profileSessionId)
      if (!r) return undefined
      if (r.closed) {
        map.delete(profileSessionId)
        counters.live = Math.max(0, counters.live - 1)
        return undefined
      }
      return r
    },
    put(runtime: SessionRuntime): void {
      const existing = map.get(runtime.profileSessionId)
      map.set(runtime.profileSessionId, runtime)
      if (!existing) {
        counters.live++
        emit("create", runtime.profileSessionId)
      } else {
        emit("reattach", runtime.profileSessionId)
      }
    },
    async drop(profileSessionId: string): Promise<void> {
      const r = map.get(profileSessionId)
      if (!r) return
      map.delete(profileSessionId)
      counters.live = Math.max(0, counters.live - 1)
      emit("close", profileSessionId)
      await r.close()
    },
    get size(): number { return map.size },
    async sweepIdle(): Promise<number> {
      const cutoff = now() - config.idleMs
      const toEvict: string[] = []
      for (const [key, runtime] of map.entries()) {
        // Skip runtimes currently serving a turn — evicting mid-turn would
        // close the SDK query out from under the holder. The next sweep
        // pass will catch it once the turn releases.
        if (runtime.turnInFlight) continue
        if (runtime.lastActivity < cutoff) toEvict.push(key)
      }
      for (const key of toEvict) {
        const r = map.get(key)
        if (!r) continue
        // Re-check turnInFlight just before dropping; a request may have
        // raced in between the scan and now.
        if (r.turnInFlight) continue
        map.delete(key)
        counters.live = Math.max(0, counters.live - 1)
        emit("evict", key)
        await r.close()
      }
      return toEvict.length
    },
    async closeAll(timeoutMs = 10_000): Promise<void> {
      const all = [...map.values()]
      map.clear()
      counters.live = 0
      for (const r of all) emit("close", r.profileSessionId)
      await Promise.race([
        Promise.all(all.map((r) => r.close())),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ])
    },
    get counters(): RuntimeLifecycleCounters {
      return { ...counters }
    },
    emitLifecycle(event: RuntimeLifecycleEvent, profileSessionId: string): void {
      emit(event, profileSessionId)
    },
  }
  return manager
}
