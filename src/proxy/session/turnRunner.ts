/**
 * Turn runner — the single entry point server.ts uses in place of
 * direct `query(buildQueryOptions(...))` at each of the 4 call sites.
 *
 * Decides at request time whether to:
 *   - Take the legacy path (`query({ prompt, options })`) when
 *     `config.persistentSessions === false` or the request is an undo/fork
 *     (§D6 says undo always builds a fresh runtime via forkSession). This
 *     is bit-identical to today's behaviour — no observable change when
 *     the flag is off.
 *   - Take the persistent path via `dispatchPersistentTurn`, which holds
 *     one live `query()` per `profileSessionId` and pushes turns into a
 *     streaming-input queue.
 *
 * Kept in its own module so server.ts orchestration stays thin and the
 * branch logic is unit-testable in isolation.
 */

import { query as sdkQuery, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ProxyConfig } from "../types"
import { buildQueryOptions, type QueryContext } from "../query"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "../passthroughTools"
import { claudeLog } from "../../logger"
import {
  type SessionRuntimeManager,
  type ReopenCriticalOptions,
  hashReopenCriticalOptions,
  markRuntimeContinuation,
} from "./runtime"
import {
  dispatchPersistentTurn,
  type PersistentTurnRequest,
} from "./persistentDispatch"
import {
  makePersistentCreateRuntime,
  type PassthroughSpec,
  type RuntimeRef,
  type PersistentWiringDeps,
} from "./persistentWiring"
import type { InPlaceOptions } from "./optionsClassifier"

// --- Types -----------------------------------------------------------------

export interface TurnContext extends QueryContext {
  /**
   * Logical-session id scoping the runtime in the manager. May be
   * undefined for agents that don't carry a session identifier (in which
   * case persistent mode is a no-op regardless of the feature flag).
   */
  profileSessionId: string | undefined
  /** Last-user-message content — what persistent mode pushes into the queue. */
  userContent: unknown
  /**
   * Passthrough tool spec used to construct the deferred-handler MCP
   * server when persistent + passthrough is on. Omit (or undefined) for
   * non-passthrough sessions.
   */
  passthroughSpec?: PassthroughSpec | null
}

export interface TurnRunnerDeps {
  config: ProxyConfig
  manager: SessionRuntimeManager
  /**
   * Called when the persistent path observes `session_id` on the first
   * `result` event — server.ts hooks this into `storeSession(...)` so
   * `session/cache.ts` stays consistent with disk.
   */
  onSessionIdCaptured?: (profileSessionId: string, claudeSessionId: string) => void
}

// --- Helpers ---------------------------------------------------------------

/**
 * Extract the reopen-critical option slice from a fully-built `Options`
 * object. Drift detection operates on this subset (§D4).
 */
function extractReopenCritical(options: Options, passthroughSpec: PassthroughSpec | null | undefined): ReopenCriticalOptions {
  const systemPrompt = typeof options.systemPrompt === "string"
    ? options.systemPrompt
    : options.systemPrompt ?? null
  const mcpServerNames = options.mcpServers ? Object.keys(options.mcpServers as Record<string, unknown>) : undefined
  const allowedTools = options.allowedTools as readonly string[] | undefined
  const disallowedTools = options.disallowedTools as readonly string[] | undefined
  const settingSources = options.settingSources as readonly string[] | undefined
  const passthroughToolNames = passthroughSpec?.tools.map((t) => t.name) ?? undefined
  return {
    cwd: options.cwd,
    systemPrompt,
    mcpServerNames,
    allowedTools,
    disallowedTools,
    settingSources,
    passthroughToolNames,
  }
}

function extractInPlace(options: Options): InPlaceOptions {
  return {
    model: typeof options.model === "string" ? options.model : undefined,
    effort: (options as { effort?: string }).effort as InPlaceOptions["effort"],
    thinking: (options as { thinking?: InPlaceOptions["thinking"] }).thinking,
    taskBudget: (options as { taskBudget?: InPlaceOptions["taskBudget"] }).taskBudget,
  }
}

// --- Main API --------------------------------------------------------------

/**
 * Run one turn. Returns an AsyncIterable of SDK events identical in shape
 * to what `query()` yields today. Server.ts iterates this the same way it
 * iterates `query(...)` — there is no additional framing.
 */
export function startTurn(ctx: TurnContext, deps: TurnRunnerDeps): AsyncIterable<SDKMessage> {
  // §8.1 — adapter-scoped override. When the adapter defines
  // `usesPersistentSessions` and returns a non-undefined value, it takes
  // precedence over the global `config.persistentSessions`.
  const adapterOverride = ctx.adapter.usesPersistentSessions?.()
  const flagOn = adapterOverride !== undefined ? adapterOverride : !!deps.config.persistentSessions
  if (flagOn && !ctx.isUndo && typeof ctx.profileSessionId === "string" && ctx.profileSessionId.length > 0) {
    return runPersistent(ctx as TurnContext & { profileSessionId: string }, deps)
  }
  claudeLog("persistent.turn", {
    mode: "resume",
    profileSessionId: ctx.profileSessionId ?? null,
    stream: ctx.stream,
    reason: !flagOn ? "flag_off" : ctx.isUndo ? "undo" : "no_session_id",
  })
  const { prompt, options } = buildQueryOptions(ctx)
  return sdkQuery({ prompt, options })
}

async function* runPersistent(ctx: TurnContext & { profileSessionId: string }, deps: TurnRunnerDeps): AsyncIterable<SDKMessage> {
  const passthroughSpec: PassthroughSpec | null = ctx.passthroughSpec ?? null

  const wiringDeps: PersistentWiringDeps = {
    pendingExecutionTimeoutMs: deps.config.persistentPendingExecutionTimeoutMs,
    startQuery: ({ inputQueue, options }) => sdkQuery({ prompt: inputQueue as AsyncIterable<SDKUserMessage>, options }) as Query,
    buildOptions: ({ reopenCritical, inPlace, resumeSessionId, forkSession, resumeSessionAt, passthroughMcpBinding, sdkHooksBinding }) => {
      // Re-run buildQueryOptions with a ctx that reflects the
      // dispatcher-chosen resume / fork semantics. In-place model/effort
      // overrides from drift detection are applied via setModel() /
      // applyFlagSettings() by the dispatcher — no need to re-bake them here.
      void reopenCritical
      const adjustedCtx: QueryContext = {
        ...ctx,
        prompt: "", // streaming-input replaces this; the SDK ignores prompt when the queue is provided
        resumeSessionId,
        isUndo: !!forkSession,
        undoRollbackUuid: resumeSessionAt,
        passthroughMcp: passthroughMcpBinding
          ? ({
              server: (passthroughMcpBinding.mcpServers as Record<string, unknown>)?.[PASSTHROUGH_MCP_NAME] ?? undefined,
              toolNames: passthroughMcpBinding.allowedTools,
              hasDeferredTools: passthroughMcpBinding.hasDeferredTools,
              coreToolNames: passthroughSpec?.coreToolNames ? [...passthroughSpec.coreToolNames] : [],
            } as unknown as QueryContext["passthroughMcp"])
          : undefined,
        hasDeferredTools: passthroughMcpBinding?.hasDeferredTools ?? false,
        sdkHooks: sdkHooksBinding?.hooks ?? ctx.sdkHooks,
        // inPlace values (model/effort/thinking/taskBudget) are carried through from ctx
        // directly; the classifier emits setModel/applyFlagSettings for drift detection.
        model: inPlace.model ?? ctx.model,
        effort: (inPlace.effort as QueryContext["effort"]) ?? ctx.effort,
        thinking: (inPlace.thinking as QueryContext["thinking"]) ?? ctx.thinking,
        taskBudget: (inPlace.taskBudget as QueryContext["taskBudget"]) ?? ctx.taskBudget,
      }
      const built = buildQueryOptions(adjustedCtx).options
      // Persistent mode reuses one SDK query across many HTTP turns, so
      // a finite per-query maxTurns cap would truncate the runtime's
      // entire lifetime — a cap of N limits the runtime to at most N
      // SDK-internal turns across ALL HTTP turns it serves. Unlike the
      // legacy request-per-process path, we can't re-derive per-HTTP-turn
      // budgets here because the SDK's internal turn counter is
      // monotonic across handler-resolutions.
      //
      // Strip maxTurns entirely so the SDK applies its own internal
      // default (unbounded in current versions). Per-HTTP-turn cost is
      // still bounded by (a) the client's usage pattern, (b) the
      // persistentPendingExecutionTimeoutMs for stuck passthrough tools,
      // and (c) Anthropic's maxBudgetUsd / rate limits.
      //
      // Matches the SDK type signature: `maxTurns?: number`.
      const { maxTurns: _dropped, ...unbounded } = built
      return unbounded
    },
    getPassthroughSpec: () => passthroughSpec,
    buildPassthroughBinding: passthroughSpec
      ? (spec: PassthroughSpec, runtimeRef: RuntimeRef) => {
          const mcp = createPassthroughMcpServer(
            spec.tools as never,
            spec.coreToolNames,
            {
              deferredMode: {
                dequeueToolUseId: (toolName: string) => runtimeRef.current?.dequeueToolUseId(toolName),
                registerPendingExecution: async (toolUseId: string) => {
                  const rt = runtimeRef.current
                  if (!rt) throw new Error("persistent runtime not bound")
                  return rt.registerPendingExecution(toolUseId)
                },
              },
            },
          )
          return {
            mcpServers: { [PASSTHROUGH_MCP_NAME]: mcp.server } as Options["mcpServers"],
            allowedTools: mcp.toolNames,
            hasDeferredTools: mcp.hasDeferredTools,
          }
        }
      : undefined,
  }

  const createRuntime = makePersistentCreateRuntime(wiringDeps)

  // Build a fresh Options once just to feed the drift classifier — the
  // wiring deps will rebuild per turn inside the dispatcher.
  const { options } = buildQueryOptions(ctx)
  const reopenCritical = extractReopenCritical(options, passthroughSpec)
  // Hash the critical options so the dispatcher can check drift cheaply
  // and so §2.1 cache-trace can attribute reopens.
  const optionsHashReopenCritical = hashReopenCriticalOptions(reopenCritical)
  const inPlace = extractInPlace(options)

  // §7.1/§2.1 — emit a per-turn tag that downstream trace tooling can
  // pick up. `mode: "persistent"` distinguishes this code path from the
  // legacy `resume`-based one.
  claudeLog("persistent.turn", {
    mode: "persistent",
    profileSessionId: ctx.profileSessionId,
    optionsHashReopenCritical,
    stream: ctx.stream,
  })

  const req: PersistentTurnRequest = {
    profileSessionId: ctx.profileSessionId,
    userContent: ctx.userContent,
    reopenCritical,
    inPlace,
    isUndo: ctx.isUndo,
    undoRollbackUuid: ctx.undoRollbackUuid,
    resumeSessionIdFromCache: ctx.resumeSessionId,
    mutexWaitMs: deps.config.persistentSessionMutexWaitMs,
  }

  let firstSessionIdSeen = false
  let sawToolUse = false

  // §5.12d continuation-after-pending SSE framing. For multi-tool-parallel
  // passthrough messages, the SDK emits ONE `assistant` rebuild event per
  // tool_use block (not one per message), and the MCP handler for the
  // first tool fires between the first tool's `content_block_stop` and
  // the second tool's `content_block_start` — several hundred ms *before*
  // the message finishes streaming. If the early-exit were keyed on
  // `assistant`+pendingCount, it would fire mid-message, leaving the
  // second tool_use's content_block_* events un-yielded and producing a
  // partial tool_use block on the client (the "Validation failed: must
  // have required property 'command'" cascade observed in scenario O).
  //
  // Gate the early-exit on the `message_stop` stream_event instead. By
  // the time message_stop lands, ALL content blocks for every tool_use
  // in the message have streamed out, regardless of whether their MCP
  // handlers have registered + blocked. Then we check pendingCount to
  // decide whether to pause (handlers blocked → client must execute
  // tools and return) or keep consuming (no handlers blocked → text-only
  // turn or ToolSearch-only turn continues naturally).

  for await (const event of dispatchPersistentTurn(req, { manager: deps.manager, createRuntime })) {
    // Capture the SDK session id on the first result event so server.ts
    // can persist it via storeSession(...).
    const sid = (event as { session_id?: unknown }).session_id
    if (!firstSessionIdSeen && typeof sid === "string" && deps.onSessionIdCaptured) {
      firstSessionIdSeen = true
      deps.onSessionIdCaptured(ctx.profileSessionId, sid)
    }

    // Track tool_use blocks in assistant messages so we can tell whether
    // the just-finished message had any tools in it. Set on the per-block
    // `assistant` rebuild events; does NOT fire the pause on its own.
    if ((event as { type?: string }).type === "assistant") {
      const content = (event as { message?: { content?: unknown } }).message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
            sawToolUse = true
            break
          }
        }
      }
    }

    // Detect stream `message_stop` — the signal that the current assistant
    // message has fully finished streaming its content blocks to the
    // client. Use optional chaining in case an event arrives without an
    // `event` sub-object.
    const isStreamMessageStop =
      (event as { type?: string }).type === "stream_event" &&
      ((event as { event?: { type?: string } }).event?.type === "message_stop")

    yield event

    // Early-exit — only after message_stop. Waiting for message_stop
    // ensures the client has received every content_block_start / delta /
    // stop for every tool_use in the message. If handlers are blocked
    // (pendingCount > 0), pause the turn so the client can execute the
    // tools and return the results on the next HTTP request; otherwise
    // continue iterating (the SDK may still emit more message_starts on
    // the same logical turn, e.g. after an internal ToolSearch resolve).
    if (isStreamMessageStop) {
      const runtime = deps.manager.get(ctx.profileSessionId)
      if (sawToolUse && runtime && runtime.pendingCount > 0) {
        // Mark the runtime so the NEXT HTTP turn's SSE layer knows to
        // prepend a synthetic message_start before the SDK's mid-message
        // continuation events. Only relevant for streaming turns;
        // non-streaming turns buffer the whole response server-side so
        // SSE framing doesn't apply.
        if (ctx.stream) markRuntimeContinuation(runtime)
        yield makePendingPauseResult(runtime.claudeSessionId, ctx.stream)
        return
      }
    }
  }
}

function makePendingPauseResult(sessionId: string | null, streaming: boolean): SDKMessage {
  // Shape matches SDKResultSuccess but uses a distinctive subtype so
  // telemetry can distinguish deferred-handler pauses from natural turn
  // ends. The existing server.ts translator treats any `type === "result"`
  // event as a turn end — the subtype doesn't matter for framing.
  void streaming
  return {
    type: "result",
    subtype: "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 0,
    result: "",
    stop_reason: "tool_use",
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "",
    session_id: sessionId ?? "",
  } as unknown as SDKMessage
}
