import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { rateLimitStore } from "./rateLimitStore"
import { fetchOAuthUsage } from "./oauthUsage"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { envBool } from "../env"
import type { ProxyConfig, ProxyInstance, ProxyServer } from "./types"
export type { ProxyConfig, ProxyInstance, ProxyServer }
// Public plugin-authoring types. Plugins import these to type their
// onRequest / onResponse / onTelemetry hooks against.
export type {
  Transform,
  RequestContext,
  ResponseContext,
  TelemetryContext,
  SessionContext,
  ToolUseContext,
  ToolResultContext,
  ErrorContext,
  TransformHook,
  ObserveHook,
} from "./transform"
// Public plugin-authoring runtime helpers. Plugin authors typically don't
// need these (just call your onRequest function directly in tests), but
// they're exposed for integration-style tests that want to chain multiple
// transforms through the same runner meridian uses internally.
export { runTransformHook, runObserveHook, buildPipeline, createRequestContext } from "./transform"
import { claudeLog } from "../logger"
import { exec as execCallback } from "child_process"
import { promisify } from "util"
import { randomUUID } from "crypto"
import { withClaudeLogContext } from "../logger"
import { createPassthroughMcpServer, stripMcpPrefix, normalizeToolInput, computeToolSetKey, PASSTHROUGH_MCP_NAME, PASSTHROUGH_MCP_PREFIX } from "./passthroughTools"
import { resolveAgentAlias } from "./agentMatch"
import { LRUMap } from "../utils/lruMap"

import { telemetryStore, diagnosticLog, createTelemetryRoutes, landingHtml, renderPrometheusMetrics } from "../telemetry"
import type { RequestMetric } from "../telemetry"
import { classifyError, isStaleSessionError, isRateLimitError, isExtraUsageRequiredError, isExpiredTokenError } from "./errors"
import { refreshOAuthToken } from "./tokenRefresh"
import { checkPluginConfigured } from "./setup"
import { mapModelToClaudeModel, resolveClaudeExecutableAsync, resolveSdkModelDefaults, isClosedControllerError, getClaudeAuthStatusAsync, getAuthCacheInfo, hasExtendedContext, stripExtendedContext, recordExtendedContextUnavailable } from "./models"
import { translateOpenAiToAnthropic, translateAnthropicToOpenAi, translateAnthropicSseEvent, buildModelList } from "./openai"
import { extractAdvisorModel, getLastUserMessage, stripAdvisorTools } from "./messages"
import { requireAuth, authEnabled } from "./auth"
import { detectAdapter } from "./adapters/detect"
import { buildQueryOptions, type QueryContext } from "./query"
import { runTransformHook, buildPipeline, createRequestContext } from "./transform"
import { getAdapterTransforms } from "./transforms/registry"
import { loadPlugins, getActiveTransforms } from "./plugins/loader"
import type { LoadedPlugin } from "./plugins/types"
import { resolveProfile, listProfiles, setActiveProfile, getActiveProfileId, getEffectiveProfiles, restoreActiveProfile } from "./profiles"
import { filterBetasForProfile, getBetaPolicyFromEnv } from "./betas"
import { createFileChangeHook, extractFileChangesFromMessages, formatFileChangeSummary, type FileChange } from "./fileChanges"
import { detectTokenAnomalies, formatAnomalyAlerts, type TokenSnapshot } from "./tokenHealth"
import { computeCacheHitRate, formatUsageSummary } from "./tokenUsage"
import { sanitizeTextContent } from "./sanitize"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  normalizeContextUsage,
  type LineageResult,
  type TokenUsageIteration,
  type TokenUsage,
} from "./session/lineage"
// Re-export for backwards compatibility (existing tests import from here)

import { lookupSession, storeSession, clearSessionCache, getMaxSessionsLimit, evictSession, getSessionByClaudeId } from "./session/cache"
import { lookupSessionRecovery, listStoredSessions } from "./sessionStore"
// Re-export for backwards compatibility (existing tests import from here)
export { computeLineageHash, hashMessage, computeMessageHashes }
export { clearSessionCache, getMaxSessionsLimit }
export type { LineageResult }











const exec = promisify(execCallback)

let claudeExecutable = ""

const MULTIMODAL_TYPES = new Set(["image", "document", "file"])

function hasMultimodalContent(content: any): boolean {
  if (!Array.isArray(content)) return false
  return content.some((block: any) => {
    if (!block || typeof block !== "object") return false
    if (MULTIMODAL_TYPES.has(block.type)) return true
    if (block.type === "tool_result") return hasMultimodalContent(block.content)
    return false
  })
}

function stripCacheControlDeep(content: any): any {
  if (!Array.isArray(content)) return content
  return content.map((block: any) => {
    if (!block || typeof block !== "object") return block
    const { cache_control, ...rest } = block
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return {
        ...rest,
        content: stripCacheControlDeep(block.content),
      }
    }
    return rest
  })
}

function normalizeStructuredUserContent(content: any): any {
  if (!Array.isArray(content)) return content
  const normalized: any[] = []
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (block.type === "tool_result" && Array.isArray(block.content) && hasMultimodalContent(block.content)) {
      normalized.push(...normalizeStructuredUserContent(block.content))
      continue
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      normalized.push({
        ...block,
        content: normalizeStructuredUserContent(block.content),
      })
      continue
    }
    normalized.push(block)
  }
  return normalized
}

/**
 * Flatten an assistant message's content to plain text for replay.
 *
 * Drops tool_use blocks entirely. The SDK already has them from its own
 * session state (on resume) or doesn't need them for text-only replay
 * (on rehydration). Emitting `[Tool Use: name(args)]` strings pollutes
 * the context — the model reads them as literal user input and starts
 * inventing fake tool-call patterns back (issue #111, #386).
 */
function flattenAssistantContent(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((b: any) => (b?.type === "text" && b.text ? b.text : ""))
    .filter(Boolean)
    .join("\n")
}

/**
 * Flatten a user message's content to plain text for replay.
 *
 * Unwraps tool_result blocks — emit just the raw result content so the
 * model sees a natural "here's the output" user turn instead of
 * `[Tool Result for toolu_xxx: ...]` noise (issue #111, #386).
 */
function flattenUserContent(
  content: any,
  sanitizeOpts: import("./sanitize").SanitizeOptions = {}
): string {
  if (typeof content === "string") return sanitizeTextContent(content, sanitizeOpts)
  if (!Array.isArray(content)) return String(content ?? "")
  return content
    .map((b: any) => {
      if (b?.type === "text" && b.text) return sanitizeTextContent(b.text, sanitizeOpts)
      if (b?.type === "tool_result") {
        const inner = b.content
        if (typeof inner === "string") return inner
        if (Array.isArray(inner)) {
          return inner
            .map((ib: any) => (ib?.type === "text" && ib.text ? ib.text : ""))
            .filter(Boolean)
            .join("\n")
        }
        return ""
      }
      if (b?.type === "image") return "[Image attached]"
      if (b?.type === "document") return "[Document attached]"
      if (b?.type === "file") return "[File attached]"
      return ""
    })
    .filter(Boolean)
    .join("\n")
}


/**
 * Build a prompt from all messages for a fresh (non-resume) session.
 * Used when retrying after a stale session UUID error.
 */
function buildFreshPrompt(
  messages: Array<{ role: string; content: any }>,
  sanitizeOpts: import("./sanitize").SanitizeOptions = {}
): string | AsyncIterable<any> {
  const hasMultimodal = messages.some((m) => hasMultimodalContent(m.content))

  if (hasMultimodal) {
    const structured: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> = []
    for (const m of messages) {
      if (m.role === "user") {
        structured.push({
          type: "user" as const,
          message: { role: "user" as const, content: normalizeStructuredUserContent(stripCacheControlDeep(m.content)) },
          parent_tool_use_id: null,
        })
      } else {
        // Drops tool_use blocks and skips tool-use-only assistant messages
        // (flattenAssistantContent returns "" for those).
        const assistantText = flattenAssistantContent(m.content)
        if (assistantText) {
          structured.push({
            type: "user" as const,
            message: { role: "user" as const, content: `[Assistant: ${assistantText}]` },
            parent_tool_use_id: null,
          })
        }
      }
    }
    return (async function* () { for (const msg of structured) yield msg })()
  }

  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "Human"
      const content = m.role === "assistant"
        ? flattenAssistantContent(m.content)
        : flattenUserContent(m.content, sanitizeOpts)
      return content ? `${role}: ${content}` : ""
    })
    .filter(Boolean)
    .join("\n\n") || ""
}

function logUsage(requestId: string, usage: TokenUsage): void {
  console.error(`[PROXY] ${requestId} usage: ${formatUsageSummary(usage)}`)
}

function checkTokenHealth(
  requestId: string,
  sdkSessionId: string | undefined,
  usage: TokenUsage | undefined,
  turnNumber: number,
  isResume: boolean,
  isPassthrough: boolean
): void {
  if (!usage || !sdkSessionId) return

  const cacheHitRate = computeCacheHitRate(usage) ?? 0
  const current: TokenSnapshot = {
    requestId,
    turnNumber,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheHitRate,
    isResume,
    isPassthrough,
  }

  const prevMetric = telemetryStore.getLastForSession(sdkSessionId)
  const previous: TokenSnapshot | undefined = prevMetric ? {
    requestId: prevMetric.requestId,
    turnNumber: turnNumber - 1,
    inputTokens: prevMetric.inputTokens ?? 0,
    outputTokens: prevMetric.outputTokens ?? 0,
    cacheReadInputTokens: prevMetric.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: prevMetric.cacheCreationInputTokens ?? 0,
    cacheHitRate: prevMetric.cacheHitRate ?? 0,
    isResume: prevMetric.isResume,
    isPassthrough: prevMetric.isPassthrough,
  } : undefined

  const anomalies = detectTokenAnomalies(current, previous)
  if (anomalies.length > 0) {
    const alerts = formatAnomalyAlerts(requestId, anomalies)
    for (const line of alerts) {
      console.error(line)
    }
    for (const a of anomalies) {
      diagnosticLog.log({
        level: a.severity === "critical" ? "error" : "warn",
        category: "token",
        message: `${requestId} ${a.type}: ${a.detail}`,
        requestId,
      })
    }
  }
}

export function createProxyServer(config: Partial<ProxyConfig> = {}): ProxyServer {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const serverVersion = finalConfig.version ?? "unknown"

  // Restore persisted active profile from last session
  restoreActiveProfile(finalConfig.profiles)

  // Track cumulative discovered tools per SDK session (survives across requests)
  const sessionDiscoveredTools = new Map<string, Set<string>>()

  // Cache last-seen tool definitions per agent session to prevent prompt cache
  // invalidation when clients intermittently omit tools on continuation requests.
  const sessionToolCache = new Map<string, any[]>()
  // Cache the passthrough MCP server per session. Reusing the same server
  // across turns (when the tool set is unchanged) avoids subtle prompt-cache
  // invalidation from MCP server re-creation. Key hashes tool name + schema
  // so silently-updated tool definitions force a rebuild.
  const sessionMcpCache = new LRUMap<string, { key: string; mcp: ReturnType<typeof createPassthroughMcpServer> }>(getMaxSessionsLimit())

  const pluginDir = finalConfig.pluginDir ?? join(homedir(), ".config", "meridian", "plugins")
  const pluginConfigPath = finalConfig.pluginConfigPath ?? join(homedir(), ".config", "meridian", "plugins.json")
  let loadedPlugins: LoadedPlugin[] = []
  let pluginTransforms: ReturnType<typeof getActiveTransforms> = []

  const app = new Hono()

  app.use("*", cors())

  // Optional API key auth — protects all routes except / and /health
  // when MERIDIAN_API_KEY is set. No-op when unset.
  app.use("/v1/*", requireAuth)
  app.use("/messages", requireAuth)
  app.use("/telemetry/*", requireAuth)
  app.use("/telemetry", requireAuth)
  app.use("/metrics", requireAuth)
  app.use("/profiles/*", requireAuth)
  app.use("/profiles", requireAuth)
  app.use("/plugins/*", requireAuth)
  app.use("/plugins", requireAuth)
  app.use("/auth/*", requireAuth)

  app.get("/", (c) => {
    // API clients get JSON, browsers get the landing page
    const accept = c.req.header("accept") || ""
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        status: "ok",
        service: "meridian",
        format: "anthropic",
        endpoints: ["/v1/messages", "/messages", "/v1/chat/completions", "/v1/models", "/telemetry", "/metrics", "/health"]
      })
    }
    return c.html(landingHtml)
  })

  // --- Concurrency Control ---
  // Each request spawns an SDK subprocess (cli.js, ~11MB). Spawning multiple
  // simultaneously can crash the process. Serialize SDK queries with a queue.
  const MAX_CONCURRENT_SESSIONS = parseInt((process.env.MERIDIAN_MAX_CONCURRENT ?? process.env.CLAUDE_PROXY_MAX_CONCURRENT) || "10", 10)
  let activeSessions = 0
  const sessionQueue: Array<{ resolve: () => void }> = []

  async function acquireSession(): Promise<void> {
    if (activeSessions < MAX_CONCURRENT_SESSIONS) {
      activeSessions++
      return
    }
    return new Promise<void>((resolve) => {
      sessionQueue.push({ resolve })
    })
  }

  function releaseSession(): void {
    activeSessions--
    const next = sessionQueue.shift()
    if (next) {
      activeSessions++
      next.resolve()
    }
  }

  const handleMessages = async (
    c: Context,
    requestMeta: { requestId: string; endpoint: string; queueEnteredAt: number; queueStartedAt: number }
  ) => {
    const requestStartAt = Date.now()

    return withClaudeLogContext({ requestId: requestMeta.requestId, endpoint: requestMeta.endpoint }, async () => {
      // Hoist adapter detection before try so it's available in the catch block for telemetry
      const adapter = detectAdapter(c)
      try {
        const body = await c.req.json()

        // Validate required fields
        if (!Array.isArray(body.messages)) {
          return c.json(
            { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
            400
          )
        }

        // Resolve profile: header > active > default > first configured
        const profile = resolveProfile(
          finalConfig.profiles,
          finalConfig.defaultProfile,
          c.req.header("x-meridian-profile") || undefined
        )

        const authStatus = await getClaudeAuthStatusAsync(
          profile.id !== "default" ? profile.id : undefined,
          Object.keys(profile.env).length > 0 ? profile.env : undefined
        )
        const agentMode = c.req.header("x-opencode-agent-mode") ?? null
        // Opaque tag clients can send to distinguish concurrent request flows
        // from the same conversation (e.g., pylon's main chat vs. memory-extract fork vs. subagent).
        // Logged for observability; fork-*/subagent-* values also skip fingerprint cache (see below).
        // Examples: "main", "fork-memory-extract", "subagent-scout".
        const requestSource = c.req.header("x-meridian-source")?.slice(0, 64) || undefined
        let model = mapModelToClaudeModel(body.model || "sonnet", authStatus?.subscriptionType, agentMode)
        // workingDirectory = SDK subprocess cwd (must exist on the proxy host).
        // clientWorkingDirectory = the client's local path (may not exist here);
        // used for per-project fingerprint bucketing and a system-prompt hint
        // so the model reports the user's real path. For same-host clients
        // (OpenCode, Crush) the adapter can leave extractClientWorkingDirectory
        // undefined and the two collapse to the same value.
        const workingDirectory = (process.env.MERIDIAN_WORKDIR ?? process.env.CLAUDE_PROXY_WORKDIR) || adapter.extractWorkingDirectory(body) || process.cwd()
        const clientWorkingDirectory = adapter.extractClientWorkingDirectory?.(body) || workingDirectory

        // Strip env vars that would cause the SDK subprocess to loop back through
        // the proxy instead of using its native Claude Max auth. Also strip vars
        // that cause unwanted SDK plugin/feature loading.
        const {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
          ANTHROPIC_API_KEY: _dropApiKey,
          ANTHROPIC_BASE_URL: _dropBaseUrl,
          ANTHROPIC_AUTH_TOKEN: _dropAuthToken,
          ...cleanEnv
        } = process.env

        // Pin ANTHROPIC_DEFAULT_{TYPE}_MODEL before the inherited env. The
        // Claude Agent SDK resolves the "sonnet"/"opus"/"haiku" aliases
        // (emitted by mapModelToClaudeModel) via these env vars; when unset
        // it falls back to its own bundled defaults, which lag real
        // availability and caused #419 (opus-* requests silently answering
        // as sonnet-4). Spread order: modelDefaults first, then cleanEnv,
        // so user-provided ANTHROPIC_DEFAULT_* values still win.
        const sdkModelDefaults = resolveSdkModelDefaults()

        // Overlay profile-specific env vars (e.g. CLAUDE_CONFIG_DIR for multi-account)
        const profileEnv = { ...sdkModelDefaults, ...cleanEnv, ...profile.env }

        let systemContext = ""
        if (body.system) {
          if (typeof body.system === "string") {
            systemContext = body.system
          } else if (Array.isArray(body.system)) {
            systemContext = body.system
              .filter((b: any) => b.type === "text" && b.text)
              .map((b: any) => b.text)
              .join("\n")
          }
        }

        // Run the transform pipeline — adapter transforms populate SDK configuration
        const adapterTransforms = getAdapterTransforms(adapter.name)
        const pipeline = buildPipeline(adapterTransforms, pluginTransforms)
        const pipelineCtx = runTransformHook(pipeline, "onRequest", createRequestContext({
          adapter: adapter.name,
          body,
          headers: c.req.raw.headers,
          model,
          messages: body.messages || [],
          systemContext,
          tools: body.tools,
          stream: body.stream ?? false,
          workingDirectory,
        }), adapter.name)

        // Allow transform pipeline to override streaming preference (e.g. LiteLLM requires non-streaming)
        const stream = pipelineCtx.prefersStreaming !== undefined ? pipelineCtx.prefersStreaming : (body.stream ?? false)

        // --- SDK parameter passthrough ---
        // Extract effort, thinking, taskBudget from body (standard Anthropic API fields).
        // Header overrides take precedence over body values.
        const effortHeader = c.req.header("x-opencode-effort")
        const thinkingHeader = c.req.header("x-opencode-thinking")
        const taskBudgetHeader = c.req.header("x-opencode-task-budget")
        // NOTE: anthropic-beta header filtering is delegated to `filterBetasForProfile`.
        // Default policy (`allow-safe`) strips only betas known to trigger Extra-Usage
        // billing (see BILLABLE_BETA_PREFIXES_ON_MAX in betas.ts). Free betas like
        // prompt-caching, context-1m, fine-grained-tool-streaming, and
        // interleaved-thinking pass through so the SDK's caching and 1M context
        // continue to work — blanket stripping caused ~3x TTFB and ~3x token
        // consumption on long conversations.
        //
        // Operators can override the policy at runtime via the MERIDIAN_BETA_POLICY
        // env var: `strip-all` restores the pre-fix behaviour (kill switch),
        // `allow-all` forwards everything unconditionally.
        // See: https://github.com/rynfar/meridian/issues/278
        const rawBetaHeader = c.req.header("anthropic-beta")
        const betaFilter = filterBetasForProfile(rawBetaHeader, profile.type, getBetaPolicyFromEnv())
        if (betaFilter.stripped.length > 0) {
          console.error(`[PROXY] ${requestMeta.requestId} stripped anthropic-beta(s) for Max profile: ${betaFilter.stripped.join(", ")}`)
        }

        const effort = effortHeader
          || body.effort
          || undefined
        let thinking: QueryContext['thinking'] | undefined = body.thinking || undefined
        if (thinkingHeader !== undefined) {
          try {
            thinking = JSON.parse(thinkingHeader) as QueryContext["thinking"]
          } catch (e) {
            console.error(`[PROXY] ${requestMeta.requestId} ignoring malformed x-opencode-thinking header: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        // SDK feature toggles — resolved once per request for use in thinking
        // defaults, settingSources, and buildQueryOptions below.
        const { getFeaturesForAdapter } = require("./sdkFeatures") as typeof import("./sdkFeatures")
        const sdkFeatures = getFeaturesForAdapter(adapter.name)

        // Default thinking from SDK features config when client didn't set it
        if (!thinking) {
          if (sdkFeatures.thinking === "adaptive") thinking = { type: "adaptive" }
          else if (sdkFeatures.thinking === "enabled") thinking = { type: "enabled" }
        }
        // When the thinking beta is stripped (e.g. strip-all policy), disable thinking
        // at the SDK level to prevent thinking blocks from being generated in the
        // session state. Without this, resumed sessions contain thinking blocks that
        // the API rejects when the thinking beta header is absent.
        const thinkingBetaStripped = betaFilter.stripped.some(b => b.startsWith("interleaved-thinking"))
        if (thinkingBetaStripped) {
          thinking = { type: "disabled" }
          if (betaFilter.stripped.length > 0) {
            console.error(`[PROXY] ${requestMeta.requestId} thinking disabled (thinking beta stripped by ${getBetaPolicyFromEnv()} policy)`)
          }
        }
        const parsedBudget = taskBudgetHeader ? Number.parseInt(taskBudgetHeader, 10) : NaN
        const taskBudget = Number.isFinite(parsedBudget)
          ? { total: parsedBudget }
          : body.task_budget ? { total: body.task_budget.total ?? body.task_budget } : undefined
        const betas = betaFilter.forwarded

        // Session resume: look up cached Claude SDK session and classify mutation
        const agentSessionId = adapter.getSessionId(c)
        // Scope session keys by profile to isolate resume state across accounts.
        // For agents with session IDs (OpenCode): prefix the key.
        // For agents without (Pi): pass profile-scoped workingDirectory to fingerprint lookup.
        const profileSessionId = profile.id !== "default" && agentSessionId
          ? `${profile.id}:${agentSessionId}` : agentSessionId
        // Use the client-local CWD for fingerprint bucketing so that two
        // independent client projects don't collide on the same first-user-
        // message hash even when they share an SDK cwd on the proxy host.
        const profileScopedCwd = profile.id !== "default"
          ? `${clientWorkingDirectory}::profile=${profile.id}` : clientWorkingDirectory
        // Clients that run concurrent sub-request flows in the same conversation
        // (e.g. pylon's memory-extract fork or subagent children) share the same
        // (firstUserMessage, cwd) fingerprint as the parent — so meridian's
        // fingerprint cache conflates them and bounces the parent through
        // continuous undo/modified-continuation/diverged reclassifications as
        // each flow writes different message hashes to the shared key.
        //
        // When x-meridian-source marks a request as an independent fork or
        // subagent, skip fingerprint lookup (no reclassification) and skip the
        // write at end of turn (no cache pollution). The main conversation
        // keeps its cache entry intact across forks.
        //
        // Opt-in via header value: clients that don't set the header are
        // unaffected — behavior is byte-identical to today.
        const isIndependentSession =
          requestSource?.startsWith("fork-") || requestSource?.startsWith("subagent-") || false
        let lineageResult = isIndependentSession
          ? { type: "diverged" as const }
          : lookupSession(profileSessionId, body.messages || [], profileScopedCwd)
        // NOTE: agent-specific (opencode) — when OpenCode's chat.headers plugin
        // hook doesn't fire (category-dispatched or title-generation requests),
        // the request has no session header and falls through to fingerprint
        // lookup. A new 1-message session can collide with a stored N-message
        // session and be classified as "undo." Downgrade to "diverged" to
        // prevent leaking the old session's conversation history.
        if (lineageResult.type === "undo" && adapter.name === "opencode" && !agentSessionId) {
          lineageResult = { type: "diverged" }
        }
        const isResume = lineageResult.type === "continuation" || lineageResult.type === "compaction"
        const isUndo = lineageResult.type === "undo"
        const cachedSession = lineageResult.type !== "diverged" ? lineageResult.session : undefined
        const resumeSessionId = cachedSession?.claudeSessionId
        // For undo: fork the session at the rollback point
        const undoRollbackUuid = isUndo && lineageResult.type === "undo" ? lineageResult.rollbackUuid : undefined

        // Debug: log request details
        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        const lineageType = lineageResult.type === "diverged" && !cachedSession ? "new" : lineageResult.type
        const msgCount = Array.isArray(body.messages) ? body.messages.length : 0
        const toolCount = body.tools?.length ?? 0
        const requestLogLine = `${requestMeta.requestId} adapter=${adapter.name}${requestSource ? ` source=${requestSource}` : ""} model=${model} stream=${stream} tools=${toolCount} lineage=${lineageType} session=${resumeSessionId?.slice(0, 8) || "new"}${isUndo && undoRollbackUuid ? ` rollback=${undoRollbackUuid.slice(0, 8)}` : ""}${agentMode ? ` agent=${agentMode}` : ""} active=${activeSessions}/${MAX_CONCURRENT_SESSIONS} msgCount=${msgCount}`
        console.error(`[PROXY] ${requestLogLine} msgs=${msgSummary}`)
        diagnosticLog.session(`${requestLogLine}`, requestMeta.requestId)

        // Recovery logging: when a session diverges, check if the store has a
        // previous session ID that the user can recover via `claude --resume`.
        if (lineageResult.type === "diverged" && profileSessionId && !isIndependentSession) {
          const recovery = lookupSessionRecovery(profileSessionId)
          if (recovery) {
            const prevId = recovery.previousClaudeSessionId || recovery.claudeSessionId
            const recoveryMsg = `${requestMeta.requestId} SESSION RECOVERY: previous conversation available. Run: claude --resume ${prevId}`
            console.error(`[PROXY] ${recoveryMsg}`)
            diagnosticLog.session(recoveryMsg, requestMeta.requestId)
          }
        }

        claudeLog("request.received", {
          model,
          stream,
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system)
        })

      // SDK agent definitions and system context from the transform pipeline.
      const sdkAgents = pipelineCtx.sdkAgents
      const validAgentNames = Object.keys(sdkAgents)
      if ((process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) && validAgentNames.length > 0) {
        claudeLog("debug.agents", { names: validAgentNames, count: validAgentNames.length })
      }
      systemContext = pipelineCtx.systemContext ?? systemContext



      // Adapter-scoped sanitize options (see sanitize.ts).
      const sanitizeOpts: import("./sanitize").SanitizeOptions = {
        stripSystemReminder: pipelineCtx.leaksCwdViaSystemReminder,
      }

      // When resuming, only send new messages the SDK doesn't have.
      const allMessages = body.messages || []
      let messagesToConvert: typeof allMessages

      if ((isResume || isUndo) && cachedSession) {
        if (isUndo && undoRollbackUuid) {
          // Undo with SDK rollback: the SDK will fork to the correct point,
          // so we only need to send the new user message.
          messagesToConvert = getLastUserMessage(allMessages)
        } else if (isResume) {
          const knownCount = cachedSession.messageCount || 0
          if (knownCount > 0 && knownCount < allMessages.length) {
            messagesToConvert = allMessages.slice(knownCount)
          } else {
            messagesToConvert = getLastUserMessage(allMessages)
          }
        } else {
          // Undo without UUID (legacy session) — fall back to last user message
          // to avoid the catastrophic flat text replay.
          messagesToConvert = getLastUserMessage(allMessages)
        }
      } else {
        messagesToConvert = allMessages
      }

      // Check if any messages contain multimodal content (images, documents, files)
      const hasMultimodal = messagesToConvert?.some((m: any) => hasMultimodalContent(m.content))

      // Build the prompt — either structured (multimodal) or text.
      // Structured prompts are stored as arrays so they can be replayed on retry.
      let structuredMessages: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> | undefined
      let textPrompt: string | undefined

      if (hasMultimodal) {
        // Structured messages preserve image/document/file blocks for Claude to see.
        // On resume, only send user messages (SDK has assistant context already).
        // On first request, include everything.
        structuredMessages = []

        if (isResume) {
          // Resume: only send user messages from the delta (SDK has the rest)
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structuredMessages.push({
                type: "user" as const,
                message: { role: "user" as const, content: normalizeStructuredUserContent(stripCacheControlDeep(m.content)) },
                parent_tool_use_id: null,
              })
            }
          }
        } else {
          // First request: all messages (system context now passed via appendSystemPrompt)
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structuredMessages.push({
                type: "user" as const,
                message: { role: "user" as const, content: normalizeStructuredUserContent(stripCacheControlDeep(m.content)) },
                parent_tool_use_id: null,
              })
            } else {
              // Drops tool_use blocks and skips tool-use-only assistant messages
              // (flattenAssistantContent returns "" for those).
              const assistantText = flattenAssistantContent(m.content)
              if (assistantText) {
                structuredMessages.push({
                  type: "user" as const,
                  message: { role: "user" as const, content: `[Assistant: ${assistantText}]` },
                  parent_tool_use_id: null,
                })
              }
            }
          }
        }
      } else {
        // Text prompt — convert messages to string.
        // Sanitize each text block before flattening to strip orchestration
        // wrappers (<env>, <task_metadata>, etc.) that harnesses inject.
        // `<system-reminder>` is only stripped for adapters that leak CWD
        // through it (Droid) — preserved otherwise so that harness state
        // like oh-my-opencode's background-task IDs reaches the model.
        textPrompt = messagesToConvert
          ?.map((m: { role: string; content: any }) => {
            const role = m.role === "assistant" ? "Assistant" : "Human"
            const content = m.role === "assistant"
              ? flattenAssistantContent(m.content)
              : flattenUserContent(m.content, sanitizeOpts)
            return content ? `${role}: ${content}` : ""
          })
          .filter(Boolean)
          .join("\n\n") || ""
      }

      // Create a fresh prompt value — can be called multiple times for retry
      function makePrompt(): string | AsyncIterable<any> {
        if (structuredMessages) {
          const msgs = structuredMessages
          return (async function* () { for (const msg of msgs) yield msg })()
        }
        return textPrompt!
      }

      // --- Passthrough mode ---
      // When enabled, ALL tool execution is forwarded to OpenCode instead of
      // being handled internally. This enables multi-model agent delegation
      // (e.g., oracle on GPT-5.2, explore on Gemini via oh-my-opencode).
      // Adapter can override the global passthrough env var per-agent.
      // Droid always uses internal mode; OpenCode defers to the env var.
      const passthrough = pipelineCtx.passthrough !== undefined
        ? pipelineCtx.passthrough
        : envBool("PASSTHROUGH")
      // SDK setting sources — controls CLAUDE.md and user settings loading.
      const settingSources: import("@anthropic-ai/claude-agent-sdk").SettingSource[] =
        envBool("LOAD_CONTEXT") || sdkFeatures.claudeMd === "full"
          ? ["user", "project"]
          : sdkFeatures.claudeMd === "project"
            ? ["project"]
            : pipelineCtx.settingSources ?? []

      const capturedToolUses: Array<{ id: string; name: string; input: any }> = []
      const fileChanges: FileChange[] = []

      // In passthrough mode, register OpenCode's tools as MCP tools so Claude
      // can actually call them (not just see them as text descriptions).
      // Tool cache: if the client omits tools on a continuation request but
      // previously sent them, reuse the cached set to preserve prompt cache.
      let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
      let requestTools = Array.isArray(body.tools) ? body.tools : []
      // Extract advisor model from tools and strip advisor tool definitions
      // before passing to passthrough MCP — the SDK handles advisors natively
      // via the advisorModel query option.
      const advisorModel = extractAdvisorModel(requestTools)
      if (advisorModel) {
        requestTools = stripAdvisorTools(requestTools)
      }
      if (passthrough && requestTools.length === 0 && profileSessionId) {
        const cached = sessionToolCache.get(profileSessionId)
        if (cached && cached.length > 0) {
          requestTools = cached
          console.error(`[PROXY] ${requestMeta.requestId} tools_restored: client sent 0 tools but session had ${cached.length} — reusing cached tools to preserve prompt cache`)
        }
      }
      if (passthrough && requestTools.length > 0) {
        const toolSetKey = computeToolSetKey(requestTools)
        const cachedMcp = profileSessionId ? sessionMcpCache.get(profileSessionId) : undefined
        if (cachedMcp && cachedMcp.key === toolSetKey) {
          passthroughMcp = cachedMcp.mcp
        } else {
          passthroughMcp = createPassthroughMcpServer(requestTools, pipelineCtx.coreToolNames ? [...pipelineCtx.coreToolNames] : undefined)
          if (profileSessionId) {
            sessionMcpCache.set(profileSessionId, { key: toolSetKey, mcp: passthroughMcp })
            if (cachedMcp) {
              console.error(`[PROXY] ${requestMeta.requestId} tools_changed: MCP server recreated (prompt cache likely invalidates)`)
            }
          }
        }
        if (profileSessionId) sessionToolCache.set(profileSessionId, requestTools)
      }
      const hasDeferredTools = passthroughMcp?.hasDeferredTools ?? false
      // Count deferred tools: when auto-defer is active, non-core tools are deferred
      const coreNames = pipelineCtx.coreToolNames ? [...pipelineCtx.coreToolNames] : undefined
      const coreSet = coreNames ? new Set(coreNames.map(n => n.toLowerCase())) : undefined
      const deferredToolCount = hasDeferredTools && requestTools.length > 0
        ? requestTools.filter((t: any) => t.defer_loading === true || (coreSet && !coreSet.has(String(t.name).toLowerCase()))).length
        : 0
      if (hasDeferredTools) {
        console.error(`[PROXY] ${requestMeta.requestId} deferred=${deferredToolCount}/${toolCount} tools (core: ${coreNames?.join(",") ?? "none"})`)
      }

      // In passthrough mode: block ALL tools, capture them for forwarding (agent-agnostic).
      // In normal mode: delegate hook construction to the adapter.
      // PostToolUse hook tracks file changes from MCP tools (internal mode only).
      // Catches write, edit, AND bash redirects (>, >>, tee, sed -i).
      const mcpPrefix = `mcp__${adapter.getMcpServerName()}__`
      const trackFileChanges = !(process.env.MERIDIAN_NO_FILE_CHANGES ?? process.env.CLAUDE_PROXY_NO_FILE_CHANGES)
        && pipelineCtx.shouldTrackFileChanges
      const fileChangeHook = trackFileChanges ? createFileChangeHook(fileChanges, mcpPrefix) : undefined

      // Track tools discovered via ToolSearch (deferred tools that get called)
      const discoveredTools = new Set<string>()

      const sdkHooks = passthrough
        ? {
            PreToolUse: [{
              matcher: "",  // Match ALL tools
              hooks: [async (input: any) => {
                // Let the SDK handle ToolSearch internally for deferred tool loading.
                // ToolSearch is filtered from the response stream below.
                // Return {} — NOT undefined. SDK validates hook returns with Zod and
                // rejects undefined ("expected object, received undefined"), which also
                // cascades into "Reached maximum number of turns (2)". {} is the no-op.
                if (input.tool_name === "ToolSearch") return {}
                // Track deferred tools that were discovered via ToolSearch
                const toolName = stripMcpPrefix(input.tool_name)
                if (hasDeferredTools && coreSet && !coreSet.has(toolName.toLowerCase())) {
                  discoveredTools.add(toolName)
                }
                // Normalize parameter names: the SDK system prompt references
                // built-in tools with snake_case params (file_path), but clients
                // may use camelCase (filePath). Remap when required fields are missing.
                const clientTool = requestTools.find((t: any) => t.name === toolName)
                // NOTE: agent-specific — normalize subagent_type for the client response.
                // Claude often sends PascalCase (e.g., "Explore") and aliases
                // (e.g., "general-purpose") that OpenCode rejects. We send the
                // canonical lowercase agent name that OpenCode's config declares.
                let toolInput = normalizeToolInput(input.tool_input, clientTool?.input_schema)
                if (toolName.toLowerCase() === "task" && toolInput?.subagent_type && typeof toolInput.subagent_type === "string") {
                  toolInput = { ...toolInput, subagent_type: resolveAgentAlias(toolInput.subagent_type) }
                }
                capturedToolUses.push({
                  id: input.tool_use_id,
                  name: toolName,
                  input: toolInput,
                })
                return {
                  decision: "block" as const,
                  reason: "Forwarding to client for execution",
                }
              }],
            }],
          }
        : {
            ...(pipelineCtx.sdkHooks ?? {}),
            ...(fileChangeHook ? { PostToolUse: [fileChangeHook] } : {}),
          }

        // Capture subprocess stderr for all paths — used to surface the real
        // failure message when the Claude subprocess exits with a non-zero code.
        const stderrLines: string[] = []
        const onStderr = (data: string) => {
          stderrLines.push(data.trimEnd())
          claudeLog("subprocess.stderr", { line: data.trimEnd() })
        }

        if (!stream) {
          const contentBlocks: Array<Record<string, unknown>> = []
          let assistantMessages = 0
          const upstreamStartAt = Date.now()
          let firstChunkAt: number | undefined
          let currentSessionId: string | undefined

          // Build SDK UUID map: start with previously stored UUIDs (if resuming),
          // then capture new ones from the response. Declared outside try so
          // storeSession (in the finally/after block) can access it.
          const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
            ? [...cachedSession.sdkMessageUuids]
            : new Array(allMessages.length - 1).fill(null)
          // Pad to current message count (the last user message has no UUID yet)
          while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

          claudeLog("upstream.start", { mode: "non_stream", model })
          let lastUsage: TokenUsage | undefined
          let lastStopReason: string | undefined

          try {
            // Lazy-resolve executable if not already set (e.g. when using createProxyServer directly)
            if (!claudeExecutable) {
              claudeExecutable = await resolveClaudeExecutableAsync()
            }

            // Wrap SDK call with transparent retry for recoverable errors.
            // Both stale-UUID and rate-limit retries happen inside the generator,
            // so the message-processing loop doesn't need any retry logic.
            //
            // Rate-limit retry strategy:
            //   1. Strip [1m] context (immediate, different model tier)
            //   2. Backoff retries on base model (1s, 2s — exponential)
            const MAX_RATE_LIMIT_RETRIES = 2
            const RATE_LIMIT_BASE_DELAY_MS = 1000

            const response = (async function* () {
              let rateLimitRetries = 0

              let tokenRefreshed = false
              while (true) {
                // Track whether response content was yielded.
                // The SDK emits metadata (session_id etc.) before the API call;
                // only "assistant" messages represent actual response content.
                let didYieldContent = false
                try {
                  for await (const event of query(buildQueryOptions({
                    prompt: makePrompt(), model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, hasDeferredTools,
                    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                    effort, thinking, taskBudget, betas, settingSources,
                    codeSystemPrompt: sdkFeatures.codeSystemPrompt ? true : undefined, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                    maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                    sdkDebug: sdkFeatures.sdkDebug,
                    additionalDirectories: sdkFeatures.additionalDirectories
                      ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                      : undefined,
                    advisorModel,
                  }))) {
                    // Capture Claude Max subscription quota updates emitted by
                    // the SDK as rate_limit_event. We snapshot them in a process-wide
                    // store so /v1/usage/quota can return the latest live state.
                    if ((event as any).type === "rate_limit_event") {
                      rateLimitStore.record((event as any).rate_limit_info)
                    }
                    // Only count real assistant content — not SDK error messages
                    // (which arrive as type:"assistant" with an error field set).
                    // Counting error assistants as content would prevent retries.
                    if ((event as any).type === "assistant" && !(event as any).error) {
                      didYieldContent = true
                    }
                    yield event
                  }
                  return
                } catch (error) {
                  const errMsg = error instanceof Error ? error.message : String(error)

                  // Never retry after response content was yielded — response is committed
                  if (didYieldContent) throw error

                  // Retry: stale undo UUID — evict session and start fresh (one-shot)
                  if (isStaleSessionError(error)) {
                    claudeLog("session.stale_uuid_retry", {
                      mode: "non_stream",
                      rollbackUuid: undoRollbackUuid,
                      resumeSessionId,
                    })
                    console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                    evictSession(profileSessionId, profileScopedCwd, allMessages)
                    sdkUuidMap.length = 0
                    for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                    yield* query(buildQueryOptions({
                      prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                      model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv: profileEnv, hasDeferredTools,
                      resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt ? true : undefined, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }))
                    return
                  }

                  // Extra Usage required: strip [1m] and record 1-hour cooldown.
                  // mapModelToClaudeModel will skip [1m] for the next hour so
                  // subsequent requests don't each make one extra failed attempt.
                  // After the hour expires a single probe fires; if the user has
                  // enabled Extra Usage in the meantime it succeeds and the flag clears.
                  if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(model)) {
                    const from = model
                    model = stripExtendedContext(model)
                    recordExtendedContextUnavailable()
                    claudeLog("upstream.context_fallback", {
                      mode: "non_stream",
                      from,
                      to: model,
                      reason: "extra_usage_required",
                    })
                    console.error(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${model} (skipping [1m] for 1h)`)
                    continue
                  }

                  // Expired OAuth token: refresh once and retry
                  if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
                    tokenRefreshed = true
                    const refreshed = await refreshOAuthToken()
                    if (refreshed) {
                      claudeLog("token_refresh.retrying", { mode: "non_stream" })
                      console.error(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
                      continue
                    }
                    // Refresh failed — fall through and surface the error
                  }

                  // Rate-limit retry: first strip [1m] (free, different tier), then backoff
                  if (isRateLimitError(errMsg)) {
                    if (hasExtendedContext(model)) {
                      const from = model
                      model = stripExtendedContext(model)
                      claudeLog("upstream.context_fallback", {
                        mode: "non_stream",
                        from,
                        to: model,
                        reason: "rate_limit",
                      })
                      console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                      continue
                    }
                    if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                      rateLimitRetries++
                      const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
                      claudeLog("upstream.rate_limit_backoff", {
                        mode: "non_stream",
                        model,
                        attempt: rateLimitRetries,
                        maxAttempts: MAX_RATE_LIMIT_RETRIES,
                        delayMs: delay,
                      })
                      console.error(`[PROXY] ${requestMeta.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
                      await new Promise(r => setTimeout(r, delay))
                      continue
                    }
                  }

                  throw error
                }
              }
            })()

            for await (const message of response) {
              // Capture session ID from SDK messages
              if ((message as any).session_id) {
                currentSessionId = (message as any).session_id
              }
              if (message.type === "assistant") {
                assistantMessages += 1
                // Capture SDK assistant UUID for undo rollback
                if ((message as any).uuid) {
                  sdkUuidMap.push((message as any).uuid)
                }
                if (!firstChunkAt) {
                  firstChunkAt = Date.now()
                  claudeLog("upstream.first_chunk", {
                    mode: "non_stream",
                    model,
                    ttfbMs: firstChunkAt - upstreamStartAt
                  })
                }

                // Preserve content blocks, with two passthrough-specific guards:
                //
                // 1. Stop-after-tool-use: in passthrough mode the SDK runs 2 turns
                //    (maxTurns:2 is required to avoid SDK crash). Turn 1 is the real
                //    response containing the client's tool_use blocks. Turn 2 is an
                //    SDK artefact — Claude receives a blank tool result and generates
                //    a prose summary ("The edit has been forwarded..."). That Turn 2
                //    content must NOT be forwarded; it confuses the client into
                //    showing prose instead of executing + diff-rendering the tool_use.
                //
                // 2. Strip thinking blocks: type:"thinking" / type:"redacted_thinking"
                //    contain an encrypted signature that is only valid inside Claude's
                //    native context. Non-native clients (OpenCode, GPT-compat) have no
                //    renderer for them and may misinterpret or choke on the signature.
                const isPassthroughTurn2 =
                  passthrough &&
                  assistantMessages > 1 &&
                  contentBlocks.some((b) => b.type === "tool_use")

                if (isPassthroughTurn2) {
                  // Skip all content from Turn 2 onwards in passthrough mode
                  claudeLog("passthrough.turn2_skipped", { mode: "non_stream", assistantMessages })
                } else {
                  for (const block of message.message.content) {
                    const b = block as unknown as Record<string, unknown>
                    // Filter ToolSearch from non-streaming passthrough responses
                    if (b.type === "tool_use" && (b as any).name === "ToolSearch") {
                      claudeLog("passthrough.toolsearch_filtered", { mode: "non_stream" })
                      continue
                    }
                    // Strip thinking blocks — meaningless to non-native clients
                    if (passthrough && !pipelineCtx.supportsThinking && !sdkFeatures.thinkingPassthrough && (b.type === "thinking" || b.type === "redacted_thinking")) {
                      claudeLog("passthrough.thinking_stripped", { mode: "non_stream", type: b.type })
                      continue
                    }
                    // In passthrough mode, strip MCP prefix from tool names
                    if (passthrough && b.type === "tool_use" && typeof b.name === "string") {
                      b.name = stripMcpPrefix(b.name as string)
                    }
                    contentBlocks.push(b)
                  }
                }
                // Capture token usage from the assistant message
                const msgUsage = message.message.usage as TokenUsage | undefined
                if (msgUsage) lastUsage = { ...lastUsage, ...msgUsage }
                if (typeof message.message.stop_reason === "string") {
                  lastStopReason = message.message.stop_reason
                }
              }
            }

            claudeLog("upstream.completed", {
              mode: "non_stream",
              model,
              assistantMessages,
              durationMs: Date.now() - upstreamStartAt
            })
            if (lastUsage) logUsage(requestMeta.requestId, lastUsage)
            // Accumulate discovered tools into the session-level set
            const sessId = currentSessionId || resumeSessionId
            if (sessId && discoveredTools.size > 0) {
              if (!sessionDiscoveredTools.has(sessId)) sessionDiscoveredTools.set(sessId, new Set())
              for (const t of discoveredTools) sessionDiscoveredTools.get(sessId)!.add(t)
              const newNames = [...discoveredTools].join(", ")
              const allNames = [...sessionDiscoveredTools.get(sessId)!]
              console.error(`[PROXY] ${requestMeta.requestId} discovered=${discoveredTools.size} (${newNames}) session_total=${allNames.length}`)
            }
          } catch (error) {
            const stderrOutput = stderrLines.join("\n").trim()
            if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
              error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
            }
            claudeLog("upstream.failed", {
              mode: "non_stream",
              model,
              durationMs: Date.now() - upstreamStartAt,
              error: error instanceof Error ? error.message : String(error),
              ...(stderrOutput ? { stderr: stderrOutput } : {})
            })
            throw error
          }

          // In passthrough mode, merge captured tool_use blocks from the hook.
          // The PreToolUse hook normalizes tool input (e.g., subagent_type casing,
          // parameter name mapping). If the SDK already included the tool_use in
          // its content blocks, replace the input with the normalized version.
          // If the SDK omitted it (blocked tools may not appear), add it.
          if (passthrough && capturedToolUses.length > 0) {
            const capturedById = new Map(capturedToolUses.map(tu => [tu.id, tu]))
            for (const block of contentBlocks) {
              if (block.type === "tool_use" && capturedById.has((block as any).id)) {
                const captured = capturedById.get((block as any).id)!
                ;(block as any).name = captured.name
                ;(block as any).input = captured.input
                capturedById.delete((block as any).id)
              }
            }
            // Add any remaining captured tool_use blocks not in content
            for (const tu of capturedById.values()) {
              contentBlocks.push({
                type: "tool_use",
                id: tu.id,
                name: tu.name,
                input: tu.input,
              })
            }
          }

          // Determine stop_reason: use content-based heuristic for standard cases,
          // but preserve non-standard upstream values like pause_turn (advisor flows)
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const heuristicStopReason = hasToolUse ? "tool_use" : "end_turn"
          const stopReason = lastStopReason && lastStopReason !== "end_turn" && lastStopReason !== "tool_use"
            ? lastStopReason
            : heuristicStopReason

          // Append file change summary:
          // - Internal mode: fileChanges populated by PostToolUse hook
          // - Passthrough mode: scan body.messages for executed tool_use blocks
          if (trackFileChanges) {
            if (passthrough && stopReason === "end_turn" && pipelineCtx.extractFileChangesFromToolUse) {
              const passthroughChanges = extractFileChangesFromMessages(
                body.messages || [],
                pipelineCtx.extractFileChangesFromToolUse
              )
              fileChanges.push(...passthroughChanges)
            }
            const fileChangeSummary = formatFileChangeSummary(fileChanges)
            if (fileChangeSummary) {
              const lastTextBlock = [...contentBlocks].reverse().find((b) => b.type === "text")
              if (lastTextBlock) {
                lastTextBlock.text = (lastTextBlock.text as string) + fileChangeSummary
              } else {
                contentBlocks.push({ type: "text", text: fileChangeSummary.trimStart() })
              }
              claudeLog("response.file_changes", { mode: "non_stream", count: fileChanges.length })
            }
          }

          // If no content at all, add a fallback text block
          if (contentBlocks.length === 0) {
            contentBlocks.push({
              type: "text",
              text: "I can help with that. Could you provide more details about what you'd like me to do?"
            })
            claudeLog("response.fallback_used", { mode: "non_stream", reason: "no_content_blocks" })
          }

          const totalDurationMs = Date.now() - requestStartAt

          claudeLog("response.completed", {
            mode: "non_stream",
            model,
            durationMs: totalDurationMs,
            contentBlocks: contentBlocks.length,
            hasToolUse
          })

          const nonStreamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
          checkTokenHealth(
            requestMeta.requestId,
            currentSessionId || resumeSessionId,
            lastUsage,
            allMessages.length,
            isResume,
            passthrough
          )
          telemetryStore.record({
            requestId: requestMeta.requestId,
            timestamp: Date.now(),
            adapter: adapter.name,
            requestSource,
            model,
            requestModel: body.model || undefined,
            mode: "non-stream",
            isResume,
            isPassthrough: passthrough,
            hasDeferredTools,
            deferredToolCount: hasDeferredTools ? deferredToolCount : undefined,
            toolCount,
            discoveredTools: discoveredTools.size > 0 ? [...discoveredTools] : undefined,
            sessionDiscoveredCount: sessionDiscoveredTools.get(currentSessionId || resumeSessionId || "")?.size,
            lineageType,
            messageCount: allMessages.length,
            sdkSessionId: currentSessionId || resumeSessionId,
            status: 200,
            queueWaitMs: nonStreamQueueWaitMs,
            proxyOverheadMs: upstreamStartAt - requestStartAt - nonStreamQueueWaitMs,
            ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
            upstreamDurationMs: Date.now() - upstreamStartAt,
            totalDurationMs,
            contentBlocks: contentBlocks.length,
            textEvents: 0,
            error: null,
            inputTokens: lastUsage?.input_tokens,
            outputTokens: lastUsage?.output_tokens,
            cacheReadInputTokens: lastUsage?.cache_read_input_tokens,
            cacheCreationInputTokens: lastUsage?.cache_creation_input_tokens,
            cacheHitRate: computeCacheHitRate(lastUsage),
          })

          // Store session for future resume.
          // Fork/subagent requests don't write to the cache — see lookupSession
          // block above for rationale (avoids polluting the parent's key).
              if (currentSessionId && !isIndependentSession) {
                storeSession(profileSessionId, body.messages || [], currentSessionId, profileScopedCwd, sdkUuidMap, lastUsage)
              }

              const responseSessionId = currentSessionId || resumeSessionId || `session_${Date.now()}`

              return new Response(JSON.stringify({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: body.model,
            stop_reason: stopReason,
            // Forward the usage accumulated from SDK assistant messages so
            // clients calling `messages.create()` can track cost and rate limits.
            usage: {
              input_tokens: lastUsage?.input_tokens ?? 0,
              output_tokens: lastUsage?.output_tokens ?? 0,
              cache_read_input_tokens: lastUsage?.cache_read_input_tokens,
              cache_creation_input_tokens: lastUsage?.cache_creation_input_tokens,
            },
          }), {
            headers: {
              "Content-Type": "application/json",
              "X-Claude-Session-ID": responseSessionId,
            }
          })
        }

        const encoder = new TextEncoder()
        const readable = new ReadableStream({
          async start(controller) {
            const upstreamStartAt = Date.now()
            let firstChunkAt: number | undefined
            let heartbeatCount = 0
            let streamEventsSeen = 0
            let eventsForwarded = 0
            let textEventsForwarded = 0
            let bytesSent = 0
            let streamClosed = false

            claudeLog("upstream.start", { mode: "stream", model })

            const safeEnqueue = (payload: Uint8Array, source: string): boolean => {
              if (streamClosed) return false
              try {
                controller.enqueue(payload)
                bytesSent += payload.byteLength
                return true
              } catch (error) {
                if (isClosedControllerError(error)) {
                  streamClosed = true
                  claudeLog("stream.client_closed", { source, streamEventsSeen, eventsForwarded })
                  return false
                }

                claudeLog("stream.enqueue_failed", {
                  source,
                  error: error instanceof Error ? error.message : String(error)
                })
                throw error
              }
            }

            // Build SDK UUID map for the streaming path (declared before try for storeSession access)
            const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
              ? [...cachedSession.sdkMessageUuids]
              : new Array(allMessages.length - 1).fill(null)
            while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

            let messageStartEmitted = false
            let lastUsage: TokenUsage | undefined

            try {
              let currentSessionId: string | undefined
              // Same transparent retry wrapper as the non-streaming path.
              // Rate-limit retry strategy:
              //   1. Strip [1m] context (immediate, different model tier)
              //   2. Backoff retries on base model (1s, 2s — exponential)
              const MAX_RATE_LIMIT_RETRIES = 2
              const RATE_LIMIT_BASE_DELAY_MS = 1000

              const response = (async function* () {
                let rateLimitRetries = 0
                let tokenRefreshed = false

                while (true) {
                  // Track whether client-visible SSE events were yielded.
                  // The SDK emits metadata events (session_id, internal routing)
                  // before the API call — those are NOT client-visible and must
                  // not prevent retry. Only stream_event types become SSE output.
                  let didYieldClientEvent = false
                  try {
                    for await (const event of query(buildQueryOptions({
                      prompt: makePrompt(), model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, hasDeferredTools,
                      resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                      effort, thinking, taskBudget, betas, settingSources,
                      codeSystemPrompt: sdkFeatures.codeSystemPrompt ? true : undefined, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                      maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                      sdkDebug: sdkFeatures.sdkDebug,
                      additionalDirectories: sdkFeatures.additionalDirectories
                        ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                        : undefined,
                      advisorModel,
                    }))) {
                      // Same SDK rate-limit capture as the non-stream path.
                      if ((event as any).type === "rate_limit_event") {
                        rateLimitStore.record((event as any).rate_limit_info)
                      }
                      if ((event as any).type === "stream_event") {
                        didYieldClientEvent = true
                      }
                      yield event
                    }
                    return
                  } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error)

                    // Never retry after client-visible SSE events — response is committed
                    if (didYieldClientEvent) throw error

                    // Retry: stale undo UUID — evict and start fresh (one-shot)
                    if (isStaleSessionError(error)) {
                      claudeLog("session.stale_uuid_retry", {
                        mode: "stream",
                        rollbackUuid: undoRollbackUuid,
                        resumeSessionId,
                      })
                      console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                      evictSession(profileSessionId, profileScopedCwd, allMessages)
                      sdkUuidMap.length = 0
                      for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                      yield* query(buildQueryOptions({
                        prompt: buildFreshPrompt(allMessages, sanitizeOpts),
                        model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
                        passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv: profileEnv, hasDeferredTools,
                        resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, blockedTools: pipelineCtx.blockedTools, incompatibleTools: pipelineCtx.incompatibleTools, mcpServerName: adapter.getMcpServerName(), allowedMcpTools: pipelineCtx.allowedMcpTools, onStderr,
                        effort, thinking, taskBudget, betas, settingSources,
                        codeSystemPrompt: sdkFeatures.codeSystemPrompt ? true : undefined, clientSystemPrompt: sdkFeatures.clientSystemPrompt === false ? false : undefined,
                    memory: sdkFeatures.memory, dreaming: sdkFeatures.dreaming, sharedMemory: sdkFeatures.sharedMemory,
                        maxBudgetUsd: sdkFeatures.maxBudgetUsd, fallbackModel: sdkFeatures.fallbackModel,
                        sdkDebug: sdkFeatures.sdkDebug,
                        additionalDirectories: sdkFeatures.additionalDirectories
                          ? sdkFeatures.additionalDirectories.split(",").map(d => d.trim()).filter(Boolean)
                          : undefined,
                        advisorModel,
                      }))
                      return
                    }

                    // Extra Usage required: strip [1m] and record 1-hour cooldown.
                    if (isExtraUsageRequiredError(errMsg) && hasExtendedContext(model)) {
                      const from = model
                      model = stripExtendedContext(model)
                      recordExtendedContextUnavailable()
                      claudeLog("upstream.context_fallback", {
                        mode: "stream",
                        from,
                        to: model,
                        reason: "extra_usage_required",
                      })
                      console.error(`[PROXY] ${requestMeta.requestId} extra usage required for [1m], falling back to ${model} (skipping [1m] for 1h)`)
                      continue
                    }

                    // Expired OAuth token: refresh once and retry
                    if (isExpiredTokenError(errMsg) && !tokenRefreshed) {
                      tokenRefreshed = true
                      const refreshed = await refreshOAuthToken()
                      if (refreshed) {
                        claudeLog("token_refresh.retrying", { mode: "stream" })
                        console.error(`[PROXY] ${requestMeta.requestId} OAuth token expired — refreshed, retrying`)
                        continue
                      }
                      // Refresh failed — fall through and surface the error
                    }

                    // Rate-limit retry: first strip [1m] (free, different tier), then backoff
                    if (isRateLimitError(errMsg)) {
                      if (hasExtendedContext(model)) {
                        const from = model
                        model = stripExtendedContext(model)
                        claudeLog("upstream.context_fallback", {
                          mode: "stream",
                          from,
                          to: model,
                          reason: "rate_limit",
                        })
                        console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                        continue
                      }
                      if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
                        rateLimitRetries++
                        const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
                        claudeLog("upstream.rate_limit_backoff", {
                          mode: "stream",
                          model,
                          attempt: rateLimitRetries,
                          maxAttempts: MAX_RATE_LIMIT_RETRIES,
                          delayMs: delay,
                        })
                        console.error(`[PROXY] ${requestMeta.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
                        await new Promise(r => setTimeout(r, delay))
                        continue
                      }
                    }

                    throw error
                  }
                }
              })()

              const heartbeat = setInterval(() => {
                heartbeatCount += 1
                try {
                  const payload = encoder.encode(`: ping\n\n`)
                  if (!safeEnqueue(payload, "heartbeat")) {
                    clearInterval(heartbeat)
                    return
                  }
                  if (heartbeatCount % 5 === 0) {
                    claudeLog("stream.heartbeat", { count: heartbeatCount })
                  }
                } catch (error) {
                  claudeLog("stream.heartbeat_failed", {
                    count: heartbeatCount,
                    error: error instanceof Error ? error.message : String(error)
                  })
                  clearInterval(heartbeat)
                }
              }, 15_000)

              const skipBlockIndices = new Set<number>()
              // NOTE: agent-specific — track block indices for "task" tool_use blocks
              // so we can normalize subagent_type in streamed input_json_delta events.
              // Deltas are buffered because input_json_delta sends JSON in chunks —
              // the key-value pair may span multiple deltas, preventing regex match.
              const taskToolBlockIndices = new Set<number>()
              const taskToolJsonBuffer = new Map<number, string>()
              const streamedToolUseIds = new Set<string>()

              // Block index remapping: the SDK resets indices on each turn, but
              // we skip intermediate message_start/stop so the client sees one
              // message. Without remapping, turn 2's index=0 collides with turn 1's.
              let nextClientBlockIndex = 0
              const sdkToClientIndex = new Map<number, number>()

              try {
                for await (const message of response) {
                  if (streamClosed) {
                    break
                  }

                  // Capture session ID and assistant UUID from any SDK message
                  if ((message as any).session_id) {
                    currentSessionId = (message as any).session_id
                  }
                  if (message.type === "assistant" && (message as any).uuid) {
                    sdkUuidMap.push((message as any).uuid)
                  }

                  if (message.type === "stream_event") {
                    streamEventsSeen += 1
                    if (!firstChunkAt) {
                      firstChunkAt = Date.now()
                      claudeLog("upstream.first_chunk", {
                        mode: "stream",
                        model,
                        ttfbMs: firstChunkAt - upstreamStartAt
                      })
                    }

                    const event = message.event
                    const eventType = (event as any).type
                    const eventIndex = (event as any).index as number | undefined

                    // Track MCP tool blocks (mcp__opencode__*) — these are internal tools
                    // that the SDK executes. Don't forward them to OpenCode.
                    if (eventType === "message_start") {
                      skipBlockIndices.clear()
                      sdkToClientIndex.clear()
                      const startUsage = (event as unknown as { message?: { usage?: TokenUsage } }).message?.usage
                      if (startUsage) lastUsage = { ...lastUsage, ...startUsage }
                      // Only emit the first message_start — subsequent ones are internal SDK turns.
                      // In passthrough mode, the second message_start marks Turn 2 beginning
                      // (SDK processed the blocked tool call and Claude is now summarising).
                      // Close the stream immediately — before ANY Turn 2 content blocks reach
                      // the client — and inject a clean message_delta + message_stop so the
                      // client sees stop_reason:"tool_use" and executes the tool itself.
                      if (messageStartEmitted) {
                        if (passthrough && streamedToolUseIds.size > 0) {
                          safeEnqueue(encoder.encode(
                            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: lastUsage?.output_tokens ?? 0 } })}\n\n`
                          ), "passthrough_turn2_stop")
                          safeEnqueue(encoder.encode(
                            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
                          ), "passthrough_turn2_stop")
                          claudeLog("passthrough.turn2_suppressed", { mode: "stream", toolUses: streamedToolUseIds.size })
                          streamClosed = true
                          controller.close()
                          break
                        }
                        continue
                      }
                      messageStartEmitted = true
                    }

                    // Skip intermediate message_stop events (SDK will start another turn)
                    // Only emit message_stop when the final message ends
                    if (eventType === "message_stop") {
                      // Peek: if there are more events coming, skip this message_stop
                      // We handle this by only emitting message_stop at the very end (after the loop)
                      continue
                    }

                    if (eventType === "content_block_start") {
                      const block = (event as any).content_block
                      // Strip thinking blocks in passthrough mode — non-native clients
                      // have no renderer for type:"thinking" and may choke on the
                      // encrypted signature field.
                      if (
                        passthrough &&
                        !pipelineCtx.supportsThinking && !sdkFeatures.thinkingPassthrough &&
                        (block?.type === "thinking" || block?.type === "redacted_thinking")
                      ) {
                        if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                        claudeLog("passthrough.thinking_stripped", { mode: "stream", type: block.type, index: eventIndex })
                        continue
                      }
                      if (block?.type === "tool_use" && typeof block.name === "string") {
                        // Filter out ToolSearch — handled internally by the SDK
                        // for deferred tool loading, not visible to the client.
                        if (block.name === "ToolSearch") {
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        }
                        if (passthrough && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
                          // Passthrough mode: SDK sent the name WITH the mcp__oc__ prefix.
                          // Strip it so OpenCode sees the bare tool name.
                          block.name = stripMcpPrefix(block.name)
                          if (block.id) streamedToolUseIds.add(block.id)
                        } else if (block.name.startsWith("mcp__")) {
                          // Internal MCP tool (mcp__opencode__* etc.) — skip, SDK handles it
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        } else if (passthrough && block.id) {
                          // Passthrough mode: SDK already stripped the mcp__oc__ prefix before
                          // emitting the stream_event (observed in practice — the SDK normalises
                          // tool names in stream events). Track the ID so the early-break
                          // condition fires correctly.
                          streamedToolUseIds.add(block.id)
                        }
                        // NOTE: agent-specific — track "task" tool blocks so we can
                        // normalize subagent_type in their streamed input_json_delta.
                        if (passthrough && eventIndex !== undefined && block.name.toLowerCase() === "task") {
                          taskToolBlockIndices.add(eventIndex)
                        }
                      }
                      // Assign a monotonic client index for this forwarded block
                      if (eventIndex !== undefined) {
                        sdkToClientIndex.set(eventIndex, nextClientBlockIndex++)
                      }
                    }

                    // Skip deltas and stops for MCP tool blocks
                    if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) {
                      continue
                    }

                    // Remap block index to monotonic client index
                    if (eventIndex !== undefined && sdkToClientIndex.has(eventIndex)) {
                      (event as any).index = sdkToClientIndex.get(eventIndex)
                    }

                    // Skip intermediate message_delta with stop_reason: tool_use
                    // (SDK is about to execute MCP tools and continue)
                    if (eventType === "message_delta") {
                      const deltaUsage = (event as unknown as { usage?: TokenUsage }).usage
                      if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage }
                      const stopReason = (event as any).delta?.stop_reason
                      if (stopReason === "tool_use" && skipBlockIndices.size > 0) {
                        // All tool_use blocks in this turn were MCP — skip this delta
                        continue
                      }
                    }

                    // NOTE: agent-specific — buffer input_json_delta for Task tool blocks.
                    // Claude sends PascalCase subagent_type (e.g., "Explore") and aliases
                    // like "general-purpose" that OpenCode rejects. input_json_delta sends
                    // JSON in chunks so we can't normalize individual deltas — buffer
                    // all chunks, parse the complete JSON, and emit the fixed version
                    // at content_block_stop.
                    if (
                      passthrough &&
                      eventIndex !== undefined &&
                      taskToolBlockIndices.has(eventIndex)
                    ) {
                      if (eventType === "content_block_delta") {
                        const delta = (event as any).delta
                        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                          const prev = taskToolJsonBuffer.get(eventIndex) ?? ""
                          taskToolJsonBuffer.set(eventIndex, prev + delta.partial_json)
                          continue // Don't forward — emit complete JSON at block_stop
                        }
                      }
                      if (eventType === "content_block_stop") {
                        const buffered = taskToolJsonBuffer.get(eventIndex)
                        if (buffered) {
                          let fixed = buffered
                          try {
                            const parsed = JSON.parse(buffered) as Record<string, unknown>
                            if (typeof parsed.subagent_type === "string") {
                              parsed.subagent_type = resolveAgentAlias(parsed.subagent_type)
                            }
                            fixed = JSON.stringify(parsed)
                          } catch {
                            // Malformed JSON — forward buffer unchanged rather than drop the block
                          }
                          const clientIdx = sdkToClientIndex.get(eventIndex) ?? eventIndex
                          safeEnqueue(encoder.encode(
                            `event: content_block_delta\ndata: ${JSON.stringify({
                              type: "content_block_delta",
                              index: clientIdx,
                              delta: { type: "input_json_delta", partial_json: fixed }
                            })}\n\n`
                          ), "task_tool_fixed_delta")
                          taskToolJsonBuffer.delete(eventIndex)
                        }
                        // Fall through to forward content_block_stop normally
                      }
                    }

                    // Forward all other events (text, non-MCP tool_use like Task, message events)
                    const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                    if (!safeEnqueue(payload, `stream_event:${eventType}`)) {
                      break
                    }
                    eventsForwarded += 1

                    // NOTE: agent-specific (passthrough mode) — break immediately when
                    // the model stops for tool_use so the client can execute the tools
                    // and send results back. Without this the SDK executes the passthrough
                    // MCP no-op (→ "passthrough"), feeds that back to the model, and the
                    // model produces an incorrect fallback response which gets forwarded.
                    if (
                      passthrough &&
                      eventType === "message_delta" &&
                      (event as any).delta?.stop_reason === "tool_use" &&
                      streamedToolUseIds.size > 0
                    ) {
                      safeEnqueue(
                        encoder.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
                        "passthrough_tool_stream_stop"
                      )
                      streamClosed = true
                      controller.close()
                      break
                    }

                    if (eventType === "content_block_delta") {
                      const delta = (event as any).delta
                      if (delta?.type === "text_delta") {
                        textEventsForwarded += 1
                      }
                    }
                  }
                }
              } finally {
                clearInterval(heartbeat)
              }

              claudeLog("upstream.completed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                eventsForwarded,
                textEventsForwarded
              })
              if (lastUsage) logUsage(requestMeta.requestId, lastUsage)
              // Accumulate discovered tools into the session-level set
              const sessId = currentSessionId || resumeSessionId
              if (sessId && discoveredTools.size > 0) {
                if (!sessionDiscoveredTools.has(sessId)) sessionDiscoveredTools.set(sessId, new Set())
                for (const t of discoveredTools) sessionDiscoveredTools.get(sessId)!.add(t)
                const newNames = [...discoveredTools].join(", ")
                const allNames = [...sessionDiscoveredTools.get(sessId)!]
                console.error(`[PROXY] ${requestMeta.requestId} discovered=${discoveredTools.size} (${newNames}) session_total=${allNames.length}`)
              }

              // Store session for future resume.
              // Fork/subagent requests don't write to the cache (see lookupSession
              // block for rationale).
              if (currentSessionId && !isIndependentSession) {
                storeSession(profileSessionId, body.messages || [], currentSessionId, profileScopedCwd, sdkUuidMap, lastUsage)
              }

              if (!streamClosed) {
                // In passthrough mode, emit captured tool_use blocks as stream events
                // Skip any that were already forwarded during the stream (dedup by ID)
                const unseenToolUses = capturedToolUses.filter(tu => !streamedToolUseIds.has(tu.id))
                if (passthrough && unseenToolUses.length > 0 && messageStartEmitted) {
                  for (let i = 0; i < unseenToolUses.length; i++) {
                    const tu = unseenToolUses[i]!
                    const blockIndex = eventsForwarded + i

                    // content_block_start
                    safeEnqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: { type: "tool_use", id: tu.id, name: tu.name, input: {} }
                      })}\n\n`
                    ), "passthrough_tool_block_start")

                    // input_json_delta with the full input
                    safeEnqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: { type: "input_json_delta", partial_json: JSON.stringify(tu.input) }
                      })}\n\n`
                    ), "passthrough_tool_input")

                    // content_block_stop
                    safeEnqueue(encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: blockIndex
                      })}\n\n`
                    ), "passthrough_tool_block_stop")
                  }

                  // Emit message_delta with stop_reason: "tool_use"
                  safeEnqueue(encoder.encode(
                    `event: message_delta\ndata: ${JSON.stringify({
                      type: "message_delta",
                      delta: { stop_reason: "tool_use", stop_sequence: null },
                      usage: { output_tokens: 0 }
                    })}\n\n`
                  ), "passthrough_message_delta")
                }

                // Passthrough mode: scan body.messages for file changes on end_turn
                if (trackFileChanges && passthrough && pipelineCtx.extractFileChangesFromToolUse) {
                  const passthroughChanges = extractFileChangesFromMessages(
                    body.messages || [],
                    pipelineCtx.extractFileChangesFromToolUse
                  )
                  fileChanges.push(...passthroughChanges)
                }

                // Emit file change summary as a text block before closing
                if (trackFileChanges) {
                  const streamFileChangeSummary = formatFileChangeSummary(fileChanges)
                  if (streamFileChangeSummary && messageStartEmitted) {
                    const fcBlockIndex = nextClientBlockIndex++
                    safeEnqueue(encoder.encode(
                      `event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: fcBlockIndex,
                        content_block: { type: "text", text: "" },
                      })}\n\n`
                    ), "file_changes_block_start")
                    safeEnqueue(encoder.encode(
                      `event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: fcBlockIndex,
                        delta: { type: "text_delta", text: streamFileChangeSummary },
                      })}\n\n`
                    ), "file_changes_text_delta")
                    safeEnqueue(encoder.encode(
                      `event: content_block_stop\ndata: ${JSON.stringify({
                        type: "content_block_stop",
                        index: fcBlockIndex,
                      })}\n\n`
                    ), "file_changes_block_stop")
                    claudeLog("response.file_changes", { mode: "stream", count: fileChanges.length })
                  }
                }

                // Emit the final message_stop (we skipped all intermediate ones)
                if (messageStartEmitted) {
                  safeEnqueue(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`), "final_message_stop")
                }

                try { controller.close() } catch {}
                streamClosed = true

                claudeLog("stream.ended", {
                  model,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  bytesSent,
                  durationMs: Date.now() - requestStartAt
                })
              }

              // Record telemetry for ALL completed streams (including early-close from
              // passthrough tool_use break and client disconnect during enqueue).
              // Must be outside the if(!streamClosed) block.
              {
                const streamTotalDurationMs = Date.now() - requestStartAt

                claudeLog("response.completed", {
                  mode: "stream",
                  model,
                  durationMs: streamTotalDurationMs,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded
                })

                const streamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
                checkTokenHealth(
                  requestMeta.requestId,
                  currentSessionId || resumeSessionId,
                  lastUsage,
                  allMessages.length,
                  isResume,
                  passthrough
                )
                telemetryStore.record({
                  requestId: requestMeta.requestId,
                  timestamp: Date.now(),
                  adapter: adapter.name,
            requestSource,
                  model,
                  requestModel: body.model || undefined,
                  mode: "stream",
                  isResume,
                  isPassthrough: passthrough,
                  hasDeferredTools,
                  deferredToolCount: hasDeferredTools ? deferredToolCount : undefined,
                  toolCount,
                  discoveredTools: discoveredTools.size > 0 ? [...discoveredTools] : undefined,
            sessionDiscoveredCount: sessionDiscoveredTools.get(currentSessionId || resumeSessionId || "")?.size,
                  lineageType,
                  messageCount: allMessages.length,
                  sdkSessionId: currentSessionId || resumeSessionId,
                  status: 200,
                  queueWaitMs: streamQueueWaitMs,
                  proxyOverheadMs: upstreamStartAt - requestStartAt - streamQueueWaitMs,
                  ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
                  upstreamDurationMs: Date.now() - upstreamStartAt,
                  totalDurationMs: streamTotalDurationMs,
                  contentBlocks: eventsForwarded,
                  textEvents: textEventsForwarded,
                  error: null,
                  inputTokens: lastUsage?.input_tokens,
                  outputTokens: lastUsage?.output_tokens,
                  cacheReadInputTokens: lastUsage?.cache_read_input_tokens,
                  cacheCreationInputTokens: lastUsage?.cache_creation_input_tokens,
                  cacheHitRate: computeCacheHitRate(lastUsage),
                })

                if (textEventsForwarded === 0) {
                  claudeLog("response.empty_stream", {
                    model,
                    streamEventsSeen,
                    eventsForwarded,
                    reason: "no_text_deltas_forwarded"
                  })
                }
              }
            } catch (error) {
              if (isClosedControllerError(error)) {
                streamClosed = true
                claudeLog("stream.client_closed", {
                  source: "stream_catch",
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded,
                  durationMs: Date.now() - requestStartAt
                })
                return
              }

              const stderrOutput = stderrLines.join("\n").trim()
              if (stderrOutput && error instanceof Error && !error.message.includes(stderrOutput)) {
                error.message = `${error.message}\nSubprocess stderr: ${stderrOutput}`
              }
              const errMsg = error instanceof Error ? error.message : String(error)
              claudeLog("upstream.failed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                textEventsForwarded,
                error: errMsg,
                ...(stderrOutput ? { stderr: stderrOutput } : {})
              })
              const streamErr = classifyError(errMsg)
              claudeLog("proxy.anthropic.error", { error: errMsg, classified: streamErr.type })

              // If we already emitted message_start, close the message cleanly so
              // clients that access usage.input_tokens don't crash on the incomplete response.
              if (messageStartEmitted) {
                safeEnqueue(encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 0 }
                  })}\n\n`
                ), "error_message_delta")
                safeEnqueue(encoder.encode(
                  `event: message_stop\ndata: {"type":"message_stop"}\n\n`
                ), "error_message_stop")
              }

              safeEnqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
                type: "error",
                error: { type: streamErr.type, message: streamErr.message }
              })}\n\n`), "error_event")
              if (!streamClosed) {
                try { controller.close() } catch {}
                streamClosed = true
              }
            }
          }
        })

        const streamSessionId = resumeSessionId || `session_${Date.now()}`
        return new Response(readable, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Claude-Session-ID": streamSessionId
          }
        })
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        claudeLog("error.unhandled", {
          durationMs: Date.now() - requestStartAt,
          error: errMsg
        })

        // Detect specific error types and return helpful messages
        const classified = classifyError(errMsg)

        claudeLog("proxy.error", { error: errMsg, classified: classified.type })

        const errorQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
        telemetryStore.record({
          requestId: requestMeta.requestId,
          timestamp: Date.now(),
          adapter: adapter.name,
          model: "unknown",
          requestModel: undefined,
          mode: "non-stream",
          isResume: false,
          isPassthrough: envBool("PASSTHROUGH"),
          hasDeferredTools: undefined,
          deferredToolCount: undefined,
          toolCount: undefined,
          lineageType: undefined,
          messageCount: undefined,
          sdkSessionId: undefined,
          status: classified.status,
          queueWaitMs: errorQueueWaitMs,
          proxyOverheadMs: Date.now() - requestStartAt - errorQueueWaitMs,
          ttfbMs: null,
          upstreamDurationMs: Date.now() - requestStartAt,
          totalDurationMs: Date.now() - requestStartAt,
          contentBlocks: 0,
          textEvents: 0,
          error: classified.type,
        })

        return new Response(
          JSON.stringify({ type: "error", error: { type: classified.type, message: classified.message } }),
          { status: classified.status, headers: { "Content-Type": "application/json" } }
        )
      }
    })
  }

  const handleWithQueue = async (c: Context, endpoint: string) => {
    const requestId = c.req.header("x-request-id") || randomUUID()
    const queueEnteredAt = Date.now()
    claudeLog("request.enter", { requestId, endpoint })
    await acquireSession()
    const queueStartedAt = Date.now()
    try {
      return await handleMessages(c, { requestId, endpoint, queueEnteredAt, queueStartedAt })
    } finally {
      releaseSession()
    }
  }

  app.post("/v1/messages", (c) => handleWithQueue(c, "/v1/messages"))
  app.post("/messages", (c) => handleWithQueue(c, "/messages"))

  // Telemetry dashboard and API
  app.route("/telemetry", createTelemetryRoutes())

  // SDK Features settings page and API
  app.get("/settings", (c) => {
    const { settingsPageHtml } = require("../telemetry/settingsPage") as typeof import("../telemetry/settingsPage")
    return c.html(settingsPageHtml)
  })
  app.get("/settings/api/features", (c) => {
    const { getAllFeatureConfigs } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    return c.json(getAllFeatureConfigs())
  })
  app.patch("/settings/api/features/:adapter", async (c) => {
    const { validateFeatureUpdate, updateAdapterFeatures } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    const adapter = c.req.param("adapter")
    const body = await c.req.json()
    let validated: ReturnType<typeof validateFeatureUpdate>
    try {
      validated = validateFeatureUpdate(body)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    updateAdapterFeatures(adapter, validated)
    return c.json({ ok: true })
  })
  app.delete("/settings/api/features/:adapter", (c) => {
    const { resetAdapterFeatures } = require("./sdkFeatures") as typeof import("./sdkFeatures")
    const adapter = c.req.param("adapter")
    resetAdapterFeatures(adapter)
    return c.json({ ok: true })
  })

  // Prometheus metrics endpoint
  app.get("/metrics", (c) => {
    const body = renderPrometheusMetrics(telemetryStore)
    return c.body(body, 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    })
  })

  // Health check endpoint — verifies auth status
  app.get("/health", async (c) => {
    try {
      // Use active profile's auth context for health check
      const healthProfile = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile)
      const profileEnvOverrides = Object.keys(healthProfile.env).length > 0 ? healthProfile.env : undefined
      const auth = await getClaudeAuthStatusAsync(
          healthProfile.id !== "default" ? healthProfile.id : undefined,
          profileEnvOverrides
        )
      if (!auth) {
        return c.json({
          status: "degraded",
          version: serverVersion,
          error: "Could not verify auth status",
          mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
        })
      }
      if (!auth.loggedIn) {
        return c.json({
          status: "unhealthy",
          version: serverVersion,
          error: "Not logged in. Run: claude login",
          auth: { loggedIn: false }
        }, 503)
      }
      return c.json({
        status: "healthy",
        version: serverVersion,
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
        },
        mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
        plugin: { opencode: checkPluginConfigured() ? "configured" : "not-configured" },
      })
    } catch {
      return c.json({
        status: "degraded",
        version: serverVersion,
        error: "Could not verify auth status",
        mode: envBool("PASSTHROUGH") ? "passthrough" : "internal",
      })
    }
  })

  // --- Profile management routes ---

  app.get("/profiles/list", async (c) => {
    const profiles = listProfiles(finalConfig.profiles, finalConfig.defaultProfile)
    // Enrich with live auth status
    const enriched = await Promise.all(profiles.map(async (p) => {
      const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, p.id)
      const envOverrides = Object.keys(resolved.env).length > 0 ? resolved.env : undefined
      const auth = await getClaudeAuthStatusAsync(
        p.id !== "default" ? p.id : undefined,
        envOverrides
      )
      const cacheInfo = getAuthCacheInfo(p.id !== "default" ? p.id : undefined)
      return {
        ...p,
        email: auth?.email || null,
        subscriptionType: auth?.subscriptionType || null,
        loggedIn: auth?.loggedIn ?? false,
        lastCheckedAt: cacheInfo.lastCheckedAt || null,
        lastSuccessAt: cacheInfo.lastSuccessAt || null,
      }
    }))
    return c.json({
      profiles: enriched,
      activeProfile: getActiveProfileId() || finalConfig.defaultProfile || profiles[0]?.id || "default",
    })
  })

  app.get("/profiles", async (c) => {
    const { profilePageHtml } = await import("../telemetry/profilePage")
    return c.html(profilePageHtml)
  })

  app.post("/profiles/active", async (c) => {
    let body: { profile?: string }
    try {
      body = await c.req.json() as { profile?: string }
    } catch {
      return c.json({ error: "Invalid JSON in request body" }, 400)
    }
    if (!body.profile) {
      return c.json({ error: "Missing 'profile' in request body" }, 400)
    }
    const effective = getEffectiveProfiles(finalConfig.profiles)
    if (effective.length === 0) {
      return c.json({ error: "No profiles configured" }, 400)
    }
    if (!effective.find(p => p.id === body.profile)) {
      return c.json({ error: `Unknown profile: ${body.profile}. Available: ${effective.map(p => p.id).join(", ")}` }, 400)
    }
    setActiveProfile(body.profile!)
    // Evict all cached SDK sessions — they were started under the old profile's
    // credentials and cannot be reused with different auth. Also drop the
    // rate-limit snapshot so /v1/usage/quota doesn't return the previous
    // profile's quotas under the new profile's identity.
    clearSessionCache()
    rateLimitStore.clear()
    console.error(`[PROXY] Active profile switched to: ${body.profile} (session + rate-limit caches cleared)`)
    return c.json({ success: true, activeProfile: body.profile })
  })

  // --- Plugin management routes ---

  app.get("/plugins/list", async (c) => {
    const { getPluginStats } = await import("./plugins/stats")
    return c.json({
      plugins: loadedPlugins.map(p => ({
        name: p.name,
        description: p.description,
        version: p.version,
        adapters: p.adapters,
        hooks: p.hooks,
        status: p.status,
        path: p.path,
        ...(p.error ? { error: p.error } : {}),
        ...(p.status === "active" ? { stats: getPluginStats(p.name) } : {}),
      })),
    })
  })

  app.post("/plugins/reload", async (c) => {
    try {
      loadedPlugins = await loadPlugins(pluginDir, pluginConfigPath)
      pluginTransforms = getActiveTransforms(loadedPlugins)
      const active = loadedPlugins.filter(p => p.status === "active").length
      console.error(`[PROXY] Plugins reloaded: ${active} active`)
      return c.json({
        success: true,
        plugins: loadedPlugins.map(p => ({
          name: p.name,
          status: p.status,
          hooks: p.hooks,
          ...(p.error ? { error: p.error } : {}),
        })),
      })
    } catch (err) {
      return c.json({ success: false, error: String(err) }, 500)
    }
  })

  app.get("/plugins", async (c) => {
    const { pluginPageHtml } = await import("./plugins/pluginPage")
    return c.html(pluginPageHtml)
  })

  app.post("/auth/refresh", async (c) => {
    const success = await refreshOAuthToken()
    if (success) {
      // Drop the rate-limit snapshot — old quotas were observed under the
      // previous credential and may belong to a different account if the
      // refresh swapped profiles. The next SDK call repopulates.
      rateLimitStore.clear()
      return c.json({ success: true, message: "OAuth token refreshed successfully" })
    }
    return c.json(
      { success: false, message: "Token refresh failed. If the problem persists, run 'claude login'." },
      500
    )
  })

  // --- OpenAI Chat Completions Compatibility ---
  // Translates OpenAI /v1/chat/completions requests to Anthropic format and
  // routes them through the internal /v1/messages handler via app.fetch().
  // No network roundtrip — Hono resolves the route in-process.
  // See src/proxy/openai.ts for the translation logic and design rationale.
  app.post("/v1/chat/completions", async (c) => {
    const rawBody = await c.req.json() as Record<string, unknown>
    const anthropicBody = translateOpenAiToAnthropic(rawBody)

    if (!anthropicBody) {
      return c.json(
        { type: "error", error: { type: "invalid_request_error", message: "messages: Field required" } },
        400
      )
    }

    // Route internally via app.fetch() — no network roundtrip.
    // Hono resolves the path in-process; the URL scheme/host are ignored.
    const internalReq = new Request("http://internal/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(anthropicBody),
    })
    const internalRes = await app.fetch(internalReq)

    if (!internalRes.ok) {
      const errBody = await internalRes.text()
      return c.json(
        { type: "error", error: { type: "upstream_error", message: errBody } },
        internalRes.status as 400 | 401 | 429 | 500
      )
    }

    const completionId = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const model = (typeof rawBody.model === "string" && rawBody.model) ? rawBody.model : "claude-sonnet-4-6"

    if (!anthropicBody.stream) {
      const anthropicRes = await internalRes.json() as Record<string, unknown>
      return c.json(translateAnthropicToOpenAi(anthropicRes, completionId, model, created))
    }

    // Streaming: translate Anthropic SSE events to OpenAI SSE chunks
    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        const reader = internalRes.body?.getReader()
        if (!reader) { controller.close(); return }

        const decoder = new TextDecoder()
        let buffer = ""
        let streamError: Error | null = null

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue
              const dataStr = line.slice(6).trim()
              if (!dataStr) continue

              let event: Record<string, unknown>
              try { event = JSON.parse(dataStr) as Record<string, unknown> }
              catch { continue }
              if (typeof event.type !== "string") continue

              const chunk = translateAnthropicSseEvent(event as { type: string } & Record<string, unknown>, completionId, model, created)
              if (chunk) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            }
          }
        } catch (err) {
          streamError = err instanceof Error ? err : new Error(String(err))
        } finally {
          if (!streamError) controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        }
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  })

  // --- Model Discovery ---
  // Returns available Claude models in OpenAI-compatible format.
  // Context window reflects the subscription tier (Max = 1M, others = 200k).
  app.get("/v1/models", async (c) => {
    const authStatus = await getClaudeAuthStatusAsync()
    const isMax = authStatus?.subscriptionType === "max"
    return c.json({ object: "list", data: buildModelList(isMax) })
  })

  // --- Subscription Quota ---
  // Returns the most recent SDK-reported quota state for the Claude Max
  // subscription, broken down by rate-limit bucket (five_hour, seven_day,
  // seven_day_opus, seven_day_sonnet, overage).
  //
  // Source: `rate_limit_event` events emitted by `@anthropic-ai/claude-agent-sdk`'s
  // `query()` stream. We snapshot them as they arrive and serve the cache here.
  // The `utilization` field is a 0..1 fraction directly from Anthropic; `resetsAt`
  // is an epoch-ms timestamp.
  //
  // Returns 200 with `buckets: []` if no events have been observed yet (first
  // call after proxy restart).
  app.get("/v1/usage/quota", async (c) => {
    // Two data sources, merged:
    //   - OAuth usage API (continuous % via Anthropic's private endpoint,
    //     profile-scoped — reads credentials from the active profile's
    //     CLAUDE_CONFIG_DIR so multi-account setups don't cross-contaminate).
    //   - SDK rate_limit_event store (overage info, threshold-gated %).
    //
    // Strategy: build a bucket per known type. OAuth-sourced fields
    // (`utilization`, `resetsAt`) win when present — they're always
    // populated. SDK fields fill in overage details and any bucket types
    // OAuth doesn't expose.
    //
    // Filter out the internal "default" bucket — it's a Meridian-side
    // fallback for SDK events missing `rateLimitType`, not a real Anthropic
    // bucket that consumers can render.
    const sdkEntries = rateLimitStore.getAll().filter(entry => entry.rateLimitType !== undefined)

    // Determine which profile we're querying:
    //   1. Explicit ?profile=<id> query param
    //   2. Active profile (set via UI / POST /profiles/active)
    //   3. First configured profile
    //   4. Default OAuth account (no claudeConfigDir override)
    const requestedProfile = c.req.query("profile")
    const profilesList = getEffectiveProfiles(finalConfig.profiles)
    const targetProfileId = requestedProfile
      || getActiveProfileId()
      || finalConfig.defaultProfile
      || profilesList[0]?.id
      || null
    const targetProfile = targetProfileId ? profilesList.find(p => p.id === targetProfileId) : undefined

    const oauth = await fetchOAuthUsage({
      profileId: targetProfileId ?? undefined,
      claudeConfigDir: targetProfile?.claudeConfigDir,
    })

    type Bucket = {
      type: string
      status: "allowed" | "allowed_warning" | "rejected"
      utilization: number | null
      resetsAt: number | null
      isUsingOverage: boolean
      overageStatus: string | null
      overageResetsAt: number | null
      overageDisabledReason: string | null
      surpassedThreshold: number | null
      observedAt: number
    }

    const byType = new Map<string, Bucket>()

    // Seed with SDK-sourced buckets (provides overage details).
    for (const entry of sdkEntries) {
      const type = entry.rateLimitType as string
      byType.set(type, {
        type,
        status: entry.status,
        utilization: entry.utilization ?? null,
        resetsAt: entry.resetsAt ?? null,
        isUsingOverage: entry.isUsingOverage ?? false,
        overageStatus: entry.overageStatus ?? null,
        overageResetsAt: entry.overageResetsAt ?? null,
        overageDisabledReason: entry.overageDisabledReason ?? null,
        surpassedThreshold: entry.surpassedThreshold ?? null,
        observedAt: entry.observedAt,
      })
    }

    // Overlay OAuth-sourced buckets — these always have current % when
    // available. Keep SDK overage fields if we already have them.
    if (oauth) {
      for (const w of oauth.windows) {
        const existing = byType.get(w.type)
        const status: Bucket["status"] =
          (w.utilization ?? 0) >= 1 ? "rejected" :
          (w.utilization ?? 0) >= 0.8 ? "allowed_warning" :
          "allowed"
        byType.set(w.type, {
          type: w.type,
          status: existing?.status === "rejected" ? "rejected" : status,
          utilization: w.utilization ?? existing?.utilization ?? null,
          resetsAt: w.resetsAt ?? existing?.resetsAt ?? null,
          isUsingOverage: existing?.isUsingOverage ?? false,
          overageStatus: existing?.overageStatus ?? null,
          overageResetsAt: existing?.overageResetsAt ?? null,
          overageDisabledReason: existing?.overageDisabledReason ?? null,
          surpassedThreshold: existing?.surpassedThreshold ?? null,
          observedAt: oauth.fetchedAt,
        })
      }
    }

    return c.json({
      profile: targetProfileId ?? null,
      buckets: Array.from(byType.values()),
      extraUsage: oauth?.extraUsage ?? null,
      sources: {
        oauth: oauth ? { fetchedAt: oauth.fetchedAt } : null,
        sdk: { entryCount: sdkEntries.length },
      },
      asOf: Date.now(),
    })
  })

  // All-profiles aggregate — returns OAuth usage for every configured profile
  // in parallel, each with its own per-profile cache. Used by the Meridian
  // settings UI to render a multi-account usage panel.
  //
  // Pylon and other single-profile clients should keep using `/v1/usage/quota`
  // (which returns only the active profile's data).
  //
  // Each profile entry includes the same shape as `/v1/usage/quota`'s top
  // level (windows + extraUsage), or `error: "no_token" | "upstream_error"`
  // when the fetch failed for that profile.
  app.get("/v1/usage/quota/all", async (c) => {
    const profilesList = getEffectiveProfiles(finalConfig.profiles)
    const activeId = getActiveProfileId() || finalConfig.defaultProfile || profilesList[0]?.id || null

    if (profilesList.length === 0) {
      // Single-account mode — just return the default OAuth account's data.
      const oauth = await fetchOAuthUsage({})
      return c.json({
        profiles: [{
          id: "default",
          isActive: true,
          windows: oauth?.windows ?? [],
          extraUsage: oauth?.extraUsage ?? null,
          fetchedAt: oauth?.fetchedAt ?? null,
          error: oauth ? null : "no_token",
        }],
        activeProfile: "default",
        asOf: Date.now(),
      })
    }

    const results = await Promise.all(profilesList.map(async (p) => {
      // Skip API-key profiles — OAuth usage endpoint only applies to Claude Max OAuth.
      const type = p.type ?? "claude-max"
      if (type !== "claude-max") {
        return {
          id: p.id,
          isActive: p.id === activeId,
          type,
          windows: [] as any[],
          extraUsage: null,
          fetchedAt: null,
          error: "not_oauth" as const,
        }
      }
      const oauth = await fetchOAuthUsage({
        profileId: p.id,
        claudeConfigDir: p.claudeConfigDir,
      })
      return {
        id: p.id,
        isActive: p.id === activeId,
        type,
        windows: oauth?.windows ?? [],
        extraUsage: oauth?.extraUsage ?? null,
        fetchedAt: oauth?.fetchedAt ?? null,
        error: oauth ? null : "no_token",
      }
    }))

    return c.json({
      profiles: results,
      activeProfile: activeId,
      asOf: Date.now(),
    })
  })

  // Returns the last observed token usage for a session, looked up by the Claude
  // session ID that was returned in a prior /v1/messages response body.
  app.get("/v1/sessions/:claudeSessionId/context-usage", (c) => {
    const claudeSessionId = c.req.param("claudeSessionId")
    const session = getSessionByClaudeId(claudeSessionId)
    if (!session) {
      return c.json({ error: "Session not found" }, 404)
    }
    if (!session.contextUsage) {
      return c.json({ error: "No usage data available for this session" }, 404)
    }
    return c.json({ session_id: claudeSessionId, context_usage: normalizeContextUsage(session.contextUsage) })
  })

  // --- Session Recovery ---
  // Returns recovery information for a session, including CLI commands and file paths
  // to locate the conversation if context was lost due to compaction/restart bugs.
  app.get("/v1/sessions/recover", (c) => {
    const sessions = listStoredSessions()
    if (sessions.length === 0) {
      return c.json({ error: "No sessions found in store" }, 404)
    }
    return c.json({
      sessions: sessions.map(s => ({
        key: s.key,
        claudeSessionId: s.claudeSessionId,
        previousClaudeSessionId: s.previousClaudeSessionId,
        createdAt: new Date(s.createdAt).toISOString(),
        lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        messageCount: s.messageCount,
        recoverCommand: `claude --resume ${s.claudeSessionId}`,
        ...(s.previousClaudeSessionId ? {
          recoverPreviousCommand: `claude --resume ${s.previousClaudeSessionId}`,
        } : {}),
      })),
    })
  })

  app.get("/v1/sessions/:key/recover", (c) => {
    const key = c.req.param("key")
    const recovery = lookupSessionRecovery(key)
    if (!recovery) {
      return c.json({ error: "Session not found", key }, 404)
    }
    return c.json({
      key,
      claudeSessionId: recovery.claudeSessionId,
      previousClaudeSessionId: recovery.previousClaudeSessionId,
      createdAt: new Date(recovery.createdAt).toISOString(),
      lastUsedAt: new Date(recovery.lastUsedAt).toISOString(),
      messageCount: recovery.messageCount,
      recoverCommand: `claude --resume ${recovery.claudeSessionId}`,
      ...(recovery.previousClaudeSessionId ? {
        recoverPreviousCommand: `claude --resume ${recovery.previousClaudeSessionId}`,
        note: "Previous session was replaced — if your current session has lost context, try the previous session ID.",
      } : {}),
    })
  })

  // Catch-all: log unhandled requests
  app.all("*", (c) => {
    console.error(`[PROXY] UNHANDLED ${c.req.method} ${c.req.url}`)
    return c.json({ error: { type: "not_found", message: `Endpoint not supported: ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404)
  })

  async function initPluginsAsync(): Promise<void> {
    try {
      loadedPlugins = await loadPlugins(pluginDir, pluginConfigPath)
      pluginTransforms = getActiveTransforms(loadedPlugins)
      if (loadedPlugins.length > 0) {
        const active = loadedPlugins.filter(p => p.status === "active").length
        const disabled = loadedPlugins.filter(p => p.status === "disabled").length
        const errored = loadedPlugins.filter(p => p.status === "error").length
        console.error(`[PROXY] Plugins loaded: ${active} active, ${disabled} disabled, ${errored} errors`)
      }
    } catch (err) {
      console.error(`[PROXY] Plugin loading failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { app, config: finalConfig, initPlugins: initPluginsAsync }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}): Promise<ProxyInstance> {
  claudeExecutable = await resolveClaudeExecutableAsync()
  const { app, config: finalConfig, initPlugins } = createProxyServer(config)
  if (initPlugins) await initPlugins()

  const server = serve({
    fetch: app.fetch,
    port: finalConfig.port,
    hostname: finalConfig.host,
    overrideGlobalObjects: false,
  }, (info) => {
    if (!finalConfig.silent) {
      console.log(`Meridian running at http://${finalConfig.host}:${info.port}`)
      console.log(`Telemetry dashboard: http://${finalConfig.host}:${info.port}/telemetry`)
      const pins = resolveSdkModelDefaults()
      console.log(`Model pins: opus=${pins.ANTHROPIC_DEFAULT_OPUS_MODEL} sonnet=${pins.ANTHROPIC_DEFAULT_SONNET_MODEL} haiku=${pins.ANTHROPIC_DEFAULT_HAIKU_MODEL}`)
      console.log(`\nPoint any Anthropic-compatible tool at this endpoint:`)
      console.log(`  ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://${finalConfig.host}:${info.port}`)
    }
  }) as Server

  const idleMs = finalConfig.idleTimeoutSeconds * 1000
  server.keepAliveTimeout = idleMs
  server.headersTimeout = idleMs + 1000

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !finalConfig.silent) {
      console.error(`\nError: Port ${finalConfig.port} is already in use.`)
      console.error(`\nIs another instance of the proxy already running?`)
      console.error(`  Check with: lsof -i :${finalConfig.port}`)
      console.error(`  Kill it with: kill $(lsof -ti :${finalConfig.port})`)
      console.error(`\nOr use a different port:`)
      console.error(`  MERIDIAN_PORT=4567 meridian`)
    }
  })

  // Background auth keepalive: periodically refresh auth status for all
  // configured profiles so switching is instant (no stale token delay).
  let authKeepaliveInterval: ReturnType<typeof setInterval> | undefined
  const effectiveProfiles = getEffectiveProfiles(finalConfig.profiles)
  if (effectiveProfiles.length > 0) {
    const AUTH_KEEPALIVE_MS = 45_000 // 45s — well within the 60s TTL
    authKeepaliveInterval = setInterval(async () => {
      // Re-read effective profiles on each tick (picks up new profiles from disk)
      const currentProfiles = getEffectiveProfiles(finalConfig.profiles)
      for (const profile of currentProfiles) {
        const resolved = resolveProfile(finalConfig.profiles, finalConfig.defaultProfile, profile.id)
        if (Object.keys(resolved.env).length > 0) {
          getClaudeAuthStatusAsync(resolved.id, resolved.env).catch(() => {})
        }
      }
      // Also refresh the default (no-override) context
      getClaudeAuthStatusAsync().catch(() => {})
    }, AUTH_KEEPALIVE_MS)
    // Don't block process exit
    if (authKeepaliveInterval.unref) authKeepaliveInterval.unref()
  }

  return {
    server,
    config: finalConfig,
    async close() {
      if (authKeepaliveInterval) clearInterval(authKeepaliveInterval)
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
