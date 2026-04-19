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

// --- SessionRuntime ---

export interface SessionRuntimeInit {
  profileSessionId: string
  optionsHash: string
  query: Query
  inputQueue: AsyncQueue<SDKUserMessage>
  onCrash?: (err: unknown) => void
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
      try { init.query.close() } catch { /* ignore */ }
      init.inputQueue.close()
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
