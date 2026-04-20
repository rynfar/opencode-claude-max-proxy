/**
 * Persistent-mode turn dispatcher (design §D1, §D4, §D5, §D6, §D11).
 *
 * Server.ts calls `dispatchPersistentTurn` at each of its `query()` call
 * sites when `ProxyConfig.persistentSessions` is true and the request is
 * not an undo/fork. The dispatcher decides:
 *
 *   - Find the existing `SessionRuntime` for this `profileSessionId`, OR
 *   - Cold-reattach via `resume` if `sessionStore` has the session but the
 *     live-query map doesn't, OR
 *   - Start a fresh runtime for a brand-new session.
 *
 * On top of that it handles:
 *   - Options drift (D4): in-place `setModel`/`applyFlagSettings`, or
 *     close+reopen on reopen-critical hash mismatch.
 *   - Request shape: plain user messages `push()` into the input queue;
 *     user messages carrying `tool_result` blocks whose `tool_use_id`
 *     matches a pending deferred handler resolve the handler's promise
 *     with the real content instead of pushing.
 *   - Cache_control stripping (D10): content is sanitized before push.
 *
 * Keeping this as its own module means server.ts stays mostly an HTTP /
 * SSE orchestrator — it hands us a request envelope and consumes the
 * events we yield.
 */

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { stripCacheControl } from "../contentSanitizer"
import {
  classifyPassthroughRequest,
  type SessionRuntime,
  type SessionRuntimeManager,
  type ReopenCriticalOptions,
} from "./runtime"
import {
  classifyOptionsDrift,
  snapshotOptions,
  type InPlaceOptions,
  type InPlaceUpdate,
  type RuntimeOptionsSnapshot,
} from "./optionsClassifier"

// --- Types -----------------------------------------------------------------

export interface PersistentTurnRequest {
  profileSessionId: string
  /** Last user message's content from `body.messages` — the delta to push. */
  userContent: unknown
  /** Reopen-critical options hash input (for §D4 drift detection). */
  reopenCritical: ReopenCriticalOptions
  /** In-place-updatable options (model, effort, thinking). */
  inPlace: InPlaceOptions
  /** Whether the incoming request is an undo / fork (§D6). */
  isUndo: boolean
  undoRollbackUuid?: string
  /** Claude SDK session id from session/cache.ts when cold-reattach is needed. */
  resumeSessionIdFromCache?: string
  /**
   * Optional per-turn mutex-acquisition timeout (ms). Requests that queue
   * behind another turn longer than this get a `MutexAcquireTimeoutError`
   * surfaced to the caller; server.ts translates that into HTTP 429 +
   * Retry-After (§5.10).
   */
  mutexWaitMs?: number
}

export class MutexAcquireTimeoutError extends Error {
  readonly profileSessionId: string
  readonly timeoutMs: number
  constructor(profileSessionId: string, timeoutMs: number) {
    super(`persistent-session mutex acquire for ${profileSessionId} timed out after ${timeoutMs}ms`)
    this.name = "MutexAcquireTimeoutError"
    this.profileSessionId = profileSessionId
    this.timeoutMs = timeoutMs
  }
}

export interface CreateRuntimeArgs {
  profileSessionId: string
  reopenCritical: ReopenCriticalOptions
  inPlace: InPlaceOptions
  resumeSessionId?: string
  forkSession?: boolean
  resumeSessionAt?: string
}

/**
 * Factory the caller (server.ts) provides. Constructs the passthrough MCP
 * with deferred handlers bound to the runtime, starts `query()` with an
 * input queue, and returns a `SessionRuntime` wrapping the whole thing.
 * The dispatcher does not know how to construct SDK queries — it only
 * orchestrates runtimes.
 */
export type CreateRuntimeFn = (args: CreateRuntimeArgs) => Promise<SessionRuntime>

/**
 * Side-channel information the dispatcher needs from per-runtime state.
 * Stored in a WeakMap keyed by runtime so we don't pollute the shared
 * `SessionRuntime` interface with dispatcher-specific bookkeeping.
 *
 * **Single-owner contract:** the dispatcher is the ONLY writer — see
 * `attachStateOnCreate` below, called on every cold-reattach / create /
 * reopen. Factories (e.g. `makePersistentCreateRuntime`) MUST NOT call
 * `attachDispatchState` themselves.
 */
interface RuntimeDispatchState {
  snapshot: RuntimeOptionsSnapshot
}

const runtimeDispatchState = new WeakMap<SessionRuntime, RuntimeDispatchState>()

/**
 * Test/utility hook to attach dispatch state manually. Production code
 * never calls this directly — the dispatcher owns attachment.
 */
export function attachDispatchState(runtime: SessionRuntime, snapshot: RuntimeOptionsSnapshot): void {
  runtimeDispatchState.set(runtime, { snapshot })
}

export function getDispatchState(runtime: SessionRuntime): RuntimeDispatchState | undefined {
  return runtimeDispatchState.get(runtime)
}

// --- Sub-steps (exported for testing) --------------------------------------

/**
 * Apply a list of in-place updates to the live query before pushing this
 * turn's user message. Per §D4, each update is awaited in order so the
 * model sees the new setting starting with the next turn.
 */
export async function applyInPlaceUpdates(
  runtime: SessionRuntime,
  updates: InPlaceUpdate[],
): Promise<void> {
  for (const u of updates) {
    switch (u.kind) {
      case "setModel":
        await runtime.query.setModel(u.model)
        break
      case "applyFlagSettings":
        await runtime.query.applyFlagSettings(u.settings as never)
        break
    }
  }
}

/**
 * Resolve every `tool_result` block in `resolveList` against the runtime's
 * pending-execution registry. Returns the number of entries resolved.
 */
export function resolvePendingFromRequest(
  runtime: SessionRuntime,
  resolveList: Array<{ toolUseId: string; content: string }>,
): number {
  let resolved = 0
  for (const r of resolveList) {
    if (runtime.resolvePendingExecution(r.toolUseId, r.content)) resolved++
  }
  return resolved
}

/**
 * Buffer every `tool_result` block in `prebindList` into the runtime's
 * prebound-result buffer. The matching MCP handler hasn't fired yet — when
 * it registers via `registerPendingExecution`, it will drain the buffer
 * and resolve immediately. Returns the number of entries buffered.
 */
export function prebindFromRequest(
  runtime: SessionRuntime,
  prebindList: Array<{ toolUseId: string; content: string }>,
): number {
  let buffered = 0
  for (const p of prebindList) {
    runtime.prebindPendingResult(p.toolUseId, p.content)
    buffered++
  }
  return buffered
}

/**
 * Build the `SDKUserMessage` to push into the runtime's input queue.
 * Strips cache_control per §D10, honors plain-string content, and wraps
 * single-image/tool_result blocks into a content array.
 */
export function buildPushMessage(content: unknown): SDKUserMessage {
  const cleaned = stripCacheControl(content)
  return {
    type: "user",
    message: { role: "user", content: cleaned as SDKUserMessage["message"]["content"] },
    parent_tool_use_id: null,
  }
}

// --- Main dispatcher -------------------------------------------------------

export interface DispatchDeps {
  manager: SessionRuntimeManager
  createRuntime: CreateRuntimeFn
}

/**
 * Handle a single persistent-mode turn. Yields SDK events for the caller
 * to translate into SSE / non-stream response format.
 *
 * The caller (server.ts) is responsible for everything OUTSIDE the
 * runtime turn: request parsing, lineage verification, adapter detection,
 * SSE framing, session cache updates, telemetry. The dispatcher's surface
 * is only about "the turn itself through the runtime."
 */
export async function* dispatchPersistentTurn(
  req: PersistentTurnRequest,
  deps: DispatchDeps,
): AsyncGenerator<SDKMessage, void> {
  let runtime = await acquireOrCreateRuntime(req, deps)

  // --- Options drift check ---
  // Dispatch state is attached by `acquireOrCreateRuntime` for every cold
  // path, so it MUST be present here. A missing snapshot means either the
  // runtime was created outside the dispatcher (bug) or the test harness
  // constructed a runtime without the create path (test bug). Surface
  // loudly — silent no-op would make drift detection invisibly broken.
  const state = runtimeDispatchState.get(runtime)
  if (!state) {
    throw new Error(
      `dispatchPersistentTurn: runtime for ${req.profileSessionId} is missing ` +
      `dispatch state; runtimes must be created via the dispatcher's ` +
      `acquireOrCreateRuntime path or attachDispatchState must be called ` +
      `explicitly in tests`,
    )
  }
  const drift = classifyOptionsDrift(
    { reopenCritical: req.reopenCritical, inPlace: req.inPlace },
    state.snapshot,
  )
  if (drift.hashMismatch) {
    // Close the old runtime and cold-reattach with the new options.
    await deps.manager.drop(req.profileSessionId)
    runtime = await createAndAttach(deps, {
      profileSessionId: req.profileSessionId,
      reopenCritical: req.reopenCritical,
      inPlace: req.inPlace,
      resumeSessionId: runtime.claudeSessionId ?? req.resumeSessionIdFromCache,
    })
    deps.manager.put(runtime)
    deps.manager.emitLifecycle("reopen", req.profileSessionId)
  } else if (drift.inPlaceUpdates.length > 0) {
    await applyInPlaceUpdates(runtime, drift.inPlaceUpdates)
    // Refresh the snapshot so the next turn compares against the just-applied
    // in-place settings rather than the original create-time snapshot.
    runtimeDispatchState.set(runtime, {
      snapshot: snapshotOptions(req.reopenCritical, req.inPlace),
    })
  }

  // --- Acquire turn mutex ---
  let release: () => void
  try {
    release = await runtime.acquireTurn(req.mutexWaitMs)
  } catch (err) {
    // Mutex.acquire rejects with a generic Error on timeout; surface as a
    // typed error so server.ts can translate to HTTP 429 (§5.10).
    if (err instanceof Error && /Mutex acquire timed out/.test(err.message) && req.mutexWaitMs !== undefined) {
      throw new MutexAcquireTimeoutError(req.profileSessionId, req.mutexWaitMs)
    }
    throw err
  }
  try {
    // --- Classify request content: resolve pending OR push ---
    const classification = classifyPassthroughRequest(
      req.userContent,
      runtime.pendingToolUseIds,
    )

    if (classification.resolve.length > 0) {
      resolvePendingFromRequest(runtime, classification.resolve)
    }
    if (classification.prebind.length > 0) {
      prebindFromRequest(runtime, classification.prebind)
    }

    if (classification.pushContent !== null) {
      runtime.inputQueue.push(buildPushMessage(classification.pushContent))
    } else if (classification.resolve.length === 0 && classification.prebind.length === 0) {
      // Nothing to resolve, prebind, or push — push the raw content
      // as-is. Safety net; path shouldn't normally trigger.
      runtime.inputQueue.push(buildPushMessage(req.userContent))
    }
    // NOTE: when only resolves/prebinds fired (pushContent === null), we
    // deliberately do NOT push anything. The pending-handler resolutions +
    // prebound buffer cover every incoming tool_result: the first handler
    // unblocks from `resolve`; later-firing handlers (parallel tool_use in
    // one assistant message fire sequentially under the SDK) drain their
    // content from the prebound buffer when they call
    // `registerPendingExecution`. Pushing a user message with orphaned
    // tool_results would deadlock the SDK — it stays blocked in the MCP
    // handler chain and never consumes the queue (validated in
    // spike/e-f-repro.ts).

    // --- Yield events until the turn terminator ---
    for await (const event of runtime.consumeTurn()) {
      yield event
    }
  } finally {
    release()
  }
}

// --- Acquisition strategy --------------------------------------------------

async function acquireOrCreateRuntime(
  req: PersistentTurnRequest,
  deps: DispatchDeps,
): Promise<SessionRuntime> {
  // Undo/fork always builds a fresh runtime (§D6): close the warm one if
  // present, start a new query with forkSession: true, resumeSessionAt.
  if (req.isUndo) {
    const existing = deps.manager.get(req.profileSessionId)
    if (existing) await deps.manager.drop(req.profileSessionId)
    const runtime = await createAndAttach(deps, {
      profileSessionId: req.profileSessionId,
      reopenCritical: req.reopenCritical,
      inPlace: req.inPlace,
      resumeSessionId: req.resumeSessionIdFromCache,
      forkSession: true,
      resumeSessionAt: req.undoRollbackUuid,
    })
    deps.manager.put(runtime)
    return runtime
  }

  const warm = deps.manager.get(req.profileSessionId)
  if (warm) return warm

  // Cold reattach (§D5): if session/cache.ts knows the Claude SDK session id
  // but we don't have a live runtime for it, start a new query with resume.
  const runtime = await createAndAttach(deps, {
    profileSessionId: req.profileSessionId,
    reopenCritical: req.reopenCritical,
    inPlace: req.inPlace,
    resumeSessionId: req.resumeSessionIdFromCache,
  })
  deps.manager.put(runtime)
  return runtime
}

/**
 * Wrapper around `deps.createRuntime` that attaches the dispatch-state
 * snapshot immediately after creation. Centralising attachment here keeps
 * the contract (dispatcher = single writer) enforceable.
 */
async function createAndAttach(
  deps: DispatchDeps,
  args: CreateRuntimeArgs,
): Promise<SessionRuntime> {
  const runtime = await deps.createRuntime(args)
  runtimeDispatchState.set(runtime, {
    snapshot: snapshotOptions(args.reopenCritical, args.inPlace),
  })
  return runtime
}
