import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import { exec as execCallback } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { promisify } from "util"
import { opencodeMcpServer } from "../mcpTools"
import { randomUUID, createHash } from "crypto"
import { withClaudeLogContext } from "../logger"
import { fuzzyMatchAgentName } from "./agentMatch"
import { buildAgentDefinitions } from "./agentDefs"
import { createPassthroughMcpServer, stripMcpPrefix, PASSTHROUGH_MCP_NAME, PASSTHROUGH_MCP_PREFIX } from "./passthroughTools"
import { lookupSharedSession, storeSharedSession, clearSharedSessions } from "./sessionStore"

// --- Session Tracking ---
// Maps OpenCode session ID (or fingerprint) → Claude SDK session ID
interface SessionState {
  claudeSessionId: string
  lastAccess: number
  messageCount: number
}

class LRUMap<K, V> implements Iterable<[K, V]> {
  private readonly map = new Map<K, V>()

  constructor(
    private readonly maxSize: number,
    private readonly onEvict?: (key: K, value: V) => void
  ) {}

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      this.evictOldest()
    }

    this.map.set(key, value)
    return this
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  entries(): MapIterator<[K, V]> {
    return this.map.entries()
  }

  keys(): MapIterator<K> {
    return this.map.keys()
  }

  values(): MapIterator<V> {
    return this.map.values()
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.map[Symbol.iterator]()
  }

  private evictOldest(): void {
    const oldestKey = this.map.keys().next().value as K | undefined
    if (oldestKey === undefined) return

    const oldestValue = this.map.get(oldestKey)
    if (oldestValue === undefined) return

    this.map.delete(oldestKey)
    this.onEvict?.(oldestKey, oldestValue)
  }
}

const DEFAULT_MAX_SESSIONS = 1000

export function getMaxSessionsLimit(): number {
  const raw = process.env.CLAUDE_PROXY_MAX_SESSIONS
  if (!raw) return DEFAULT_MAX_SESSIONS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[PROXY] Invalid CLAUDE_PROXY_MAX_SESSIONS value "${raw}"; using default ${DEFAULT_MAX_SESSIONS}`)
    return DEFAULT_MAX_SESSIONS
  }

  return parsed
}

let sessionCache: LRUMap<string, SessionState>
let fingerprintCache: LRUMap<string, SessionState>
let activeSessionCacheSize = 0

function removeFingerprintEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of fingerprintCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      fingerprintCache.delete(key)
    }
  }
}

function removeSessionEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of sessionCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      sessionCache.delete(key)
    }
  }
}

function initializeSessionCaches(maxSize: number): void {
  activeSessionCacheSize = maxSize
  sessionCache = new LRUMap<string, SessionState>(maxSize, (_key, evictedState) => {
    removeFingerprintEntriesByClaudeSessionId(evictedState.claudeSessionId)
  })
  fingerprintCache = new LRUMap<string, SessionState>(maxSize, (_key, evictedState) => {
    removeSessionEntriesByClaudeSessionId(evictedState.claudeSessionId)
  })
}

function ensureSessionCacheLimit(): void {
  const configuredLimit = getMaxSessionsLimit()
  if (configuredLimit !== activeSessionCacheSize) {
    initializeSessionCaches(configuredLimit)
  }
}

initializeSessionCaches(getMaxSessionsLimit())

/** Clear all session caches (used in tests) */
export function clearSessionCache() {
  ensureSessionCacheLimit()
  sessionCache.clear()
  fingerprintCache.clear()
  // Also clear shared file store
  try { clearSharedSessions() } catch {}
}

// Clean stale sessions every hour — sessions survive a full workday
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
setInterval(() => {
  const now = Date.now()
  for (const [key, val] of sessionCache) {
    if (now - val.lastAccess > SESSION_TTL_MS) sessionCache.delete(key)
  }
  for (const [key, val] of fingerprintCache) {
    if (now - val.lastAccess > SESSION_TTL_MS) fingerprintCache.delete(key)
  }
}, 60 * 60 * 1000)

/** Hash the first user message to fingerprint a conversation */
function getConversationFingerprint(messages: Array<{ role: string; content: any }>): string {
  const firstUser = messages?.find((m) => m.role === "user")
  if (!firstUser) return ""
  const text = typeof firstUser.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser.content)
      ? firstUser.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : ""
  if (!text) return ""
  return createHash("sha256").update(text.slice(0, 2000)).digest("hex").slice(0, 16)
}

/** Look up a cached session by header or fingerprint */
function lookupSession(
  opencodeSessionId: string | undefined,
  messages: Array<{ role: string; content: any }>
): SessionState | undefined {
  // When a session ID is provided, only match by that ID — don't fall through
  // to fingerprint. A different session ID means a different session.
  if (opencodeSessionId) {
    const cached = sessionCache.get(opencodeSessionId)
    if (cached) return cached
    // Check shared file store
    const shared = lookupSharedSession(opencodeSessionId)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: shared.lastUsedAt,
        messageCount: 0,
      }
      sessionCache.set(opencodeSessionId, state)
      return state
    }
    return undefined
  }

  // No session ID — use fingerprint fallback
  const fp = getConversationFingerprint(messages)
  if (fp) {
    const cached = fingerprintCache.get(fp)
    if (cached) return cached
    const shared = lookupSharedSession(fp)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: shared.lastUsedAt,
        messageCount: 0,
      }
      fingerprintCache.set(fp, state)
      return state
    }
  }
  return undefined
}

/** Store a session mapping */
function storeSession(
  opencodeSessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  claudeSessionId: string
) {
  if (!claudeSessionId) return
  const state: SessionState = { claudeSessionId, lastAccess: Date.now(), messageCount: messages?.length || 0 }
  // In-memory cache
  if (opencodeSessionId) sessionCache.set(opencodeSessionId, state)
  const fp = getConversationFingerprint(messages)
  if (fp) fingerprintCache.set(fp, state)
  // Shared file store (cross-proxy resume)
  const key = opencodeSessionId || fp
  if (key) storeSharedSession(key, claudeSessionId, state.messageCount)
}

/** Extract only the last user message (for resume — SDK already has history) */
function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}

// --- Error Classification ---
// Detect specific SDK errors and return helpful messages to the client
function classifyError(errMsg: string): { status: number; type: string; message: string } {
  const lower = errMsg.toLowerCase()

  // Authentication failures
  if (lower.includes("401") || lower.includes("authentication") || lower.includes("invalid auth") || lower.includes("credentials")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
    }
  }

  // Rate limiting
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      status: 429,
      type: "rate_limit_error",
      message: "Claude Max rate limit reached. Wait a moment and try again."
    }
  }

  // Billing / subscription
  if (lower.includes("402") || lower.includes("billing") || lower.includes("subscription") || lower.includes("payment")) {
    return {
      status: 402,
      type: "billing_error",
      message: "Claude Max subscription issue. Check your subscription status at https://claude.ai/settings/subscription"
    }
  }

  // SDK process crash
  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/)
    const code = codeMatch ? codeMatch[1] : "unknown"

    // Code 1 with no other info is usually auth
    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      return {
        status: 401,
        type: "authentication_error",
        message: "Claude Code process crashed (exit code 1). This usually means authentication expired. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
      }
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`
    }
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message: "Request timed out. The operation may have been too complex. Try a simpler request."
    }
  }

  // Server errors from Anthropic
  if (lower.includes("500") || lower.includes("server error") || lower.includes("internal error")) {
    return {
      status: 502,
      type: "api_error",
      message: "Claude API returned a server error. This is usually temporary — try again in a moment."
    }
  }

  // Overloaded
  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds."
    }
  }

  // Default
  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error"
  }
}

// Block SDK built-in tools so Claude only uses MCP tools (which have correct param names)
const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

// Claude Code SDK tools that have NO equivalent in OpenCode.
// Only block these — everything else either has an OpenCode equivalent
// or is handled by OpenCode's own tool system.
//
// Tools where OpenCode has an equivalent but with a DIFFERENT name/schema
// are blocked so Claude uses OpenCode's version instead of the SDK's.
// See schema-incompatible section below.
//
// These truly have NO OpenCode equivalent (BLOCKED):
const CLAUDE_CODE_ONLY_TOOLS = [
  "ToolSearch",        // Claude Code deferred tool loading (internal mechanism)
  "CronCreate",        // Claude Code cron jobs
  "CronDelete",        // Claude Code cron jobs
  "CronList",          // Claude Code cron jobs
  "EnterPlanMode",     // Claude Code mode switching (OpenCode uses plan agent instead)
  "ExitPlanMode",      // Claude Code mode switching
  "EnterWorktree",     // Claude Code git worktree management
  "ExitWorktree",      // Claude Code git worktree management
  "NotebookEdit",      // Jupyter notebook editing
  // Schema-incompatible: SDK tool name differs from OpenCode's.
  // If Claude calls the SDK version, OpenCode won't recognize it.
  // Block the SDK's so Claude only sees OpenCode's definitions.
  "TodoWrite",         // OpenCode: todowrite (requires 'priority' field)
  "AskUserQuestion",   // OpenCode: question
  "Skill",             // OpenCode: skill / skill_mcp / slashcommand
  "Agent",             // OpenCode: delegate_task / task
  "TaskOutput",        // OpenCode: background_output
  "TaskStop",          // OpenCode: background_cancel
  "WebSearch",         // OpenCode: websearch_web_search_exa
]

const MCP_SERVER_NAME = "opencode"

const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`
]

const exec = promisify(execCallback)

let cachedClaudePath: string | null = null
let cachedClaudePathPromise: Promise<string> | null = null
let claudeExecutable = ""

async function resolveClaudeExecutableAsync(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath
  if (cachedClaudePathPromise) return cachedClaudePathPromise

  cachedClaudePathPromise = (async () => {
    // 1. Try the SDK's bundled cli.js (same dir as this module's SDK)
    try {
      const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
      const sdkCliJs = join(dirname(sdkPath), "cli.js")
      if (existsSync(sdkCliJs)) {
        cachedClaudePath = sdkCliJs
        return sdkCliJs
      }
    } catch {}

    // 2. Try the system-installed claude binary
    try {
      const { stdout } = await exec("which claude")
      const claudePath = stdout.trim()
      if (claudePath && existsSync(claudePath)) {
        cachedClaudePath = claudePath
        return claudePath
      }
    } catch {}

    throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
  })()

  try {
    return await cachedClaudePathPromise
  } finally {
    cachedClaudePathPromise = null
  }
}

function mapModelToClaudeModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus"
  if (model.includes("haiku")) return "haiku"
  return "sonnet"
}

function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("Controller is already closed")
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  ensureSessionCacheLimit()
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "1.0.0",
      format: "anthropic",
      endpoints: ["/v1/messages", "/messages"]
    })
  })

  // --- Concurrency Control ---
  // Each request spawns an SDK subprocess (cli.js, ~11MB). Spawning multiple
  // simultaneously can crash the process. Serialize SDK queries with a queue.
  const MAX_CONCURRENT_SESSIONS = parseInt(process.env.CLAUDE_PROXY_MAX_CONCURRENT || "10", 10)
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
      try {
        const body = await c.req.json()
        const model = mapModelToClaudeModel(body.model || "sonnet")
        const stream = body.stream ?? true
        const workingDirectory = process.env.CLAUDE_PROXY_WORKDIR || process.cwd()

        // Strip env vars that cause SDK subprocess to load unwanted plugins/features
        const { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, ...cleanEnv } = process.env

        // Session resume: look up cached Claude SDK session
        const opencodeSessionId = c.req.header("x-opencode-session")
        const cachedSession = lookupSession(opencodeSessionId, body.messages || [])
        const resumeSessionId = cachedSession?.claudeSessionId
        const isResume = Boolean(resumeSessionId)

        // Debug: log request details
        const msgSummary = body.messages?.map((m: any) => {
          const contentTypes = Array.isArray(m.content)
            ? m.content.map((b: any) => b.type).join(",")
            : "string"
          return `${m.role}[${contentTypes}]`
        }).join(" → ")
        console.error(`[PROXY] ${requestMeta.requestId} model=${model} stream=${stream} tools=${body.tools?.length ?? 0} resume=${isResume} active=${activeSessions}/${MAX_CONCURRENT_SESSIONS} msgs=${msgSummary}`)

        claudeLog("request.received", {
          model,
          stream,
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system)
        })

      // Build system context from the request's system prompt
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

      // Extract available agent types from the Task tool definition.
      // Used for: 1) SDK agent definitions, 2) fuzzy matching in PreToolUse hook, 3) prompt hints
      let validAgentNames: string[] = []
      let sdkAgents: Record<string, any> = {}
      if (Array.isArray(body.tools)) {
        const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
        if (taskTool?.description) {
          // Build SDK agent definitions from the Task tool description.
          // This makes the SDK's native Task handler recognize agent names
          // from OpenCode (with or without oh-my-opencode).
          sdkAgents = buildAgentDefinitions(taskTool.description, [...ALLOWED_MCP_TOOLS])
          validAgentNames = Object.keys(sdkAgents)

          if (process.env.CLAUDE_PROXY_DEBUG) {
            claudeLog("debug.agents", { names: validAgentNames, count: validAgentNames.length })
          }
          if (validAgentNames.length > 0) {
            systemContext += `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
          }
        }
      }



      // When resuming, only send new messages the SDK doesn't have.
      const allMessages = body.messages || []
      let messagesToConvert: typeof allMessages

      if (isResume && cachedSession) {
        const knownCount = cachedSession.messageCount || 0
        if (knownCount > 0 && knownCount < allMessages.length) {
          messagesToConvert = allMessages.slice(knownCount)
        } else {
          messagesToConvert = getLastUserMessage(allMessages)
        }
      } else {
        messagesToConvert = allMessages
      }

      // Check if any messages contain multimodal content (images, documents, files)
      const MULTIMODAL_TYPES = new Set(["image", "document", "file"])
      const hasMultimodal = messagesToConvert?.some((m: any) =>
        Array.isArray(m.content) && m.content.some((b: any) => MULTIMODAL_TYPES.has(b.type))
      )

      // Strip cache_control from content blocks — the SDK manages its own caching
      // and OpenCode's ttl='1h' blocks conflict with the SDK's ttl='5m' blocks
      function stripCacheControl(content: any): any {
        if (!Array.isArray(content)) return content
        return content.map((block: any) => {
          if (block.cache_control) {
            const { cache_control, ...rest } = block
            return rest
          }
          return block
        })
      }

      // Build the prompt — either structured (multimodal) or text
      let prompt: string | AsyncIterable<any>

      if (hasMultimodal) {
        // Structured messages preserve image/document/file blocks for Claude to see.
        // On resume, only send user messages (SDK has assistant context already).
        // On first request, include everything.
        const structured: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> = []

        if (isResume) {
          // Resume: only send user messages from the delta (SDK has the rest)
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structured.push({
                type: "user" as const,
                message: { role: "user" as const, content: stripCacheControl(m.content) },
                parent_tool_use_id: null,
              })
            }
          }
        } else {
          // First request: include system context + all messages
          if (systemContext) {
            structured.push({
              type: "user" as const,
              message: { role: "user", content: systemContext },
              parent_tool_use_id: null,
            })
          }
          for (const m of messagesToConvert) {
            if (m.role === "user") {
              structured.push({
                type: "user" as const,
                message: { role: "user" as const, content: stripCacheControl(m.content) },
                parent_tool_use_id: null,
              })
            } else {
              // Convert assistant messages to text summaries
              let text: string
              if (typeof m.content === "string") {
                text = `[Assistant: ${m.content}]`
              } else if (Array.isArray(m.content)) {
                text = m.content.map((b: any) => {
                  if (b.type === "text" && b.text) return `[Assistant: ${b.text}]`
                  if (b.type === "tool_use") return `[Tool Use: ${b.name}(${JSON.stringify(b.input)})]`
                  if (b.type === "tool_result") return `[Tool Result: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}]`
                  return ""
                }).filter(Boolean).join("\n")
              } else {
                text = `[Assistant: ${String(m.content)}]`
              }
              structured.push({
                type: "user" as const,
                message: { role: "user" as const, content: text },
                parent_tool_use_id: null,
              })
            }
          }
        }

        prompt = (async function* () { for (const msg of structured) yield msg })()
      } else {
        // Text prompt — convert messages to string
        const conversationParts = messagesToConvert
          ?.map((m: { role: string; content: string | Array<{ type: string; text?: string; content?: string; tool_use_id?: string; name?: string; input?: unknown; id?: string }> }) => {
            const role = m.role === "assistant" ? "Assistant" : "Human"
            let content: string
            if (typeof m.content === "string") {
              content = m.content
            } else if (Array.isArray(m.content)) {
              content = m.content
                .map((block: any) => {
                  if (block.type === "text" && block.text) return block.text
                  if (block.type === "tool_use") return `[Tool Use: ${block.name}(${JSON.stringify(block.input)})]`
                  if (block.type === "tool_result") return `[Tool Result for ${block.tool_use_id}: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}]`
                  if (block.type === "image") return "[Image attached]"
                  if (block.type === "document") return "[Document attached]"
                  if (block.type === "file") return "[File attached]"
                  return ""
                })
                .filter(Boolean)
                .join("\n")
            } else {
              content = String(m.content)
            }
            return `${role}: ${content}`
          })
          .join("\n\n") || ""

        // On resume, skip system context (SDK already has it)
        prompt = (!isResume && systemContext)
          ? `${systemContext}\n\n${conversationParts}`
          : conversationParts
      }

      // --- Passthrough mode ---
      // When enabled, ALL tool execution is forwarded to OpenCode instead of
      // being handled internally. This enables multi-model agent delegation
      // (e.g., oracle on GPT-5.2, explore on Gemini via oh-my-opencode).
      const passthrough = Boolean(process.env.CLAUDE_PROXY_PASSTHROUGH)
      const capturedToolUses: Array<{ id: string; name: string; input: any }> = []

      // In passthrough mode, register OpenCode's tools as MCP tools so Claude
      // can actually call them (not just see them as text descriptions).
      let passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined
      if (passthrough && Array.isArray(body.tools) && body.tools.length > 0) {
        passthroughMcp = createPassthroughMcpServer(body.tools)
      }



      // In passthrough mode: block ALL tools, capture them for forwarding
      // In normal mode: only fix agent names on Task tool
      const sdkHooks = passthrough
        ? {
            PreToolUse: [{
              matcher: "",  // Match ALL tools
              hooks: [async (input: any) => {
                capturedToolUses.push({
                  id: input.tool_use_id,
                  name: stripMcpPrefix(input.tool_name),
                  input: input.tool_input,
                })
                return {
                  decision: "block" as const,
                  reason: "Forwarding to client for execution",
                }
              }],
            }],
          }
        : validAgentNames.length > 0
          ? {
              PreToolUse: [{
                matcher: "Task",
                hooks: [async (input: any) => ({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    updatedInput: {
                      ...input.tool_input,
                      subagent_type: fuzzyMatchAgentName(
                        String(input.tool_input?.subagent_type || ""),
                        validAgentNames
                      ),
                    },
                  },
                })],
              }],
            }
          : undefined



        if (!stream) {
          const contentBlocks: Array<Record<string, unknown>> = []
          let assistantMessages = 0
          const upstreamStartAt = Date.now()
          let firstChunkAt: number | undefined
          let currentSessionId: string | undefined

          claudeLog("upstream.start", { mode: "non_stream", model })

          try {
            const response = query({
              prompt,
              options: {
                maxTurns: passthrough ? 1 : 100,
                cwd: workingDirectory,
                model,
                pathToClaudeCodeExecutable: claudeExecutable,
                permissionMode: "bypassPermissions",
                allowDangerouslySkipPermissions: true,
                // In passthrough mode: block ALL SDK built-in tools, use OpenCode's via MCP
                // In normal mode: block built-ins, use our own MCP replacements
                ...(passthrough
                  ? {
                      disallowedTools: [...BLOCKED_BUILTIN_TOOLS, ...CLAUDE_CODE_ONLY_TOOLS],
                      ...(passthroughMcp ? {
                        allowedTools: passthroughMcp.toolNames,
                        mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
                      } : {}),
                    }
                  : {
                      disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
                      allowedTools: [...ALLOWED_MCP_TOOLS],
                      mcpServers: { [MCP_SERVER_NAME]: opencodeMcpServer },
                    }),
                plugins: [],
                env: { ...cleanEnv, ENABLE_TOOL_SEARCH: "false" },
                ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
                ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                ...(sdkHooks ? { hooks: sdkHooks } : {}),
              }
            })

            for await (const message of response) {
              // Capture session ID from SDK messages
              if ((message as any).session_id) {
                currentSessionId = (message as any).session_id
              }
              if (message.type === "assistant") {
                assistantMessages += 1
                if (!firstChunkAt) {
                  firstChunkAt = Date.now()
                  claudeLog("upstream.first_chunk", {
                    mode: "non_stream",
                    model,
                    ttfbMs: firstChunkAt - upstreamStartAt
                  })
                }

                // Preserve ALL content blocks (text, tool_use, thinking, etc.)
                for (const block of message.message.content) {
                  const b = block as Record<string, unknown>
                  // In passthrough mode, strip MCP prefix from tool names
                  if (passthrough && b.type === "tool_use" && typeof b.name === "string") {
                    b.name = stripMcpPrefix(b.name as string)
                  }
                  contentBlocks.push(b)
                }
              }
            }

            claudeLog("upstream.completed", {
              mode: "non_stream",
              model,
              assistantMessages,
              durationMs: Date.now() - upstreamStartAt
            })
          } catch (error) {
            claudeLog("upstream.failed", {
              mode: "non_stream",
              model,
              durationMs: Date.now() - upstreamStartAt,
              error: error instanceof Error ? error.message : String(error)
            })
            throw error
          }

          // In passthrough mode, add captured tool_use blocks from the hook
          // (the SDK may not include them in content after blocking)
          if (passthrough && capturedToolUses.length > 0) {
            for (const tu of capturedToolUses) {
              // Only add if not already in contentBlocks
              if (!contentBlocks.some((b) => b.type === "tool_use" && (b as any).id === tu.id)) {
                contentBlocks.push({
                  type: "tool_use",
                  id: tu.id,
                  name: tu.name,
                  input: tu.input,
                })
              }
            }
          }

          // Determine stop_reason based on content: tool_use if any tool blocks, else end_turn
          const hasToolUse = contentBlocks.some((b) => b.type === "tool_use")
          const stopReason = hasToolUse ? "tool_use" : "end_turn"

          // If no content at all, add a fallback text block
          if (contentBlocks.length === 0) {
            contentBlocks.push({
              type: "text",
              text: "I can help with that. Could you provide more details about what you'd like me to do?"
            })
            claudeLog("response.fallback_used", { mode: "non_stream", reason: "no_content_blocks" })
          }

          claudeLog("response.completed", {
            mode: "non_stream",
            model,
            durationMs: Date.now() - requestStartAt,
            contentBlocks: contentBlocks.length,
            hasToolUse
          })

          // Store session for future resume
          if (currentSessionId) {
            storeSession(opencodeSessionId, body.messages || [], currentSessionId)
          }

          const responseSessionId = currentSessionId || resumeSessionId || `session_${Date.now()}`

          return new Response(JSON.stringify({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: contentBlocks,
            model: body.model,
            stop_reason: stopReason,
            usage: { input_tokens: 0, output_tokens: 0 }
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

            try {
              let currentSessionId: string | undefined
              const response = query({
                prompt,
                options: {
                  maxTurns: passthrough ? 1 : 100,
                  cwd: workingDirectory,
                  model,
                  pathToClaudeCodeExecutable: claudeExecutable,
                  includePartialMessages: true,
                  permissionMode: "bypassPermissions",
                  allowDangerouslySkipPermissions: true,
                  ...(passthrough
                    ? {
                        disallowedTools: [...BLOCKED_BUILTIN_TOOLS, ...CLAUDE_CODE_ONLY_TOOLS],
                        ...(passthroughMcp ? {
                          allowedTools: passthroughMcp.toolNames,
                          mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
                        } : {}),
                      }
                    : {
                        disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
                        allowedTools: [...ALLOWED_MCP_TOOLS],
                        mcpServers: { [MCP_SERVER_NAME]: opencodeMcpServer },
                      }),
                  plugins: [],
                  env: { ...cleanEnv, ENABLE_TOOL_SEARCH: "false" },
                  ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
                  ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                  ...(sdkHooks ? { hooks: sdkHooks } : {}),
                }
              })

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
              const streamedToolUseIds = new Set<string>() // Track tool_use IDs already forwarded in stream
              let messageStartEmitted = false // Track if we've sent a message_start to the client

              try {
                for await (const message of response) {
                  if (streamClosed) {
                    break
                  }

                  // Capture session ID from any SDK message
                  if ((message as any).session_id) {
                    currentSessionId = (message as any).session_id
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
                      // Only emit the first message_start — subsequent ones are internal SDK turns
                      if (messageStartEmitted) {
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
                      if (block?.type === "tool_use" && typeof block.name === "string") {
                        if (passthrough && block.name.startsWith(PASSTHROUGH_MCP_PREFIX)) {
                          // Passthrough mode: strip prefix and forward to OpenCode
                          block.name = stripMcpPrefix(block.name)
                          // Track this tool_use ID so we don't emit it again from capturedToolUses
                          if (block.id) streamedToolUseIds.add(block.id)
                        } else if (block.name.startsWith("mcp__")) {
                          // Internal mode: skip all MCP tool blocks (internal execution)
                          if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                          continue
                        }
                      }
                    }

                    // Skip deltas and stops for MCP tool blocks
                    if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) {
                      continue
                    }

                    // Skip intermediate message_delta with stop_reason: tool_use
                    // (SDK is about to execute MCP tools and continue)
                    if (eventType === "message_delta") {
                      const stopReason = (event as any).delta?.stop_reason
                      if (stopReason === "tool_use" && skipBlockIndices.size > 0) {
                        // All tool_use blocks in this turn were MCP — skip this delta
                        continue
                      }
                    }

                    // Forward all other events (text, non-MCP tool_use like Task, message events)
                    const payload = encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
                    if (!safeEnqueue(payload, `stream_event:${eventType}`)) {
                      break
                    }
                    eventsForwarded += 1

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

              // Store session for future resume
              if (currentSessionId) {
                storeSession(opencodeSessionId, body.messages || [], currentSessionId)
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

                claudeLog("response.completed", {
                  mode: "stream",
                  model,
                  durationMs: Date.now() - requestStartAt,
                  streamEventsSeen,
                  eventsForwarded,
                  textEventsForwarded
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

              claudeLog("upstream.failed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                textEventsForwarded,
                error: error instanceof Error ? error.message : String(error)
              })
              const streamErr = classifyError(error instanceof Error ? error.message : String(error))
              claudeLog("proxy.anthropic.error", { error: error instanceof Error ? error.message : String(error), classified: streamErr.type })
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

  // Health check endpoint — verifies auth status
  app.get("/health", async (c) => {
    try {
      const { stdout } = await exec("claude auth status", { timeout: 5000 })
      const auth = JSON.parse(stdout)
      if (!auth.loggedIn) {
        return c.json({
          status: "unhealthy",
          error: "Not logged in. Run: claude login",
          auth: { loggedIn: false }
        }, 503)
      }
      return c.json({
        status: "healthy",
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
        },
        mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
      })
    } catch {
      return c.json({
        status: "degraded",
        error: "Could not verify auth status",
        mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
      })
    }
  })

  // Catch-all: log unhandled requests
  app.all("*", (c) => {
    console.error(`[PROXY] UNHANDLED ${c.req.method} ${c.req.url}`)
    return c.json({ error: { type: "not_found", message: `Endpoint not supported: ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404)
  })

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  claudeExecutable = await resolveClaudeExecutableAsync()
  const { app, config: finalConfig } = createProxyServer(config)

  const server = serve({
    fetch: app.fetch,
    port: finalConfig.port,
    hostname: finalConfig.host,
  }, (info) => {
    console.log(`Claude Max Proxy (Anthropic API) running at http://${finalConfig.host}:${info.port}`)
    console.log(`\nTo use with OpenCode, run:`)
    console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${info.port} opencode`)
  }) as Server

  const idleMs = finalConfig.idleTimeoutSeconds * 1000
  server.keepAliveTimeout = idleMs
  server.headersTimeout = idleMs + 1000

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`\nError: Port ${finalConfig.port} is already in use.`)
      console.error(`\nIs another instance of the proxy already running?`)
      console.error(`  Check with: lsof -i :${finalConfig.port}`)
      console.error(`  Kill it with: kill $(lsof -ti :${finalConfig.port})`)
      console.error(`\nOr use a different port:`)
      console.error(`  CLAUDE_PROXY_PORT=4567 claude-max-proxy`)
      process.exit(1)
    }
    throw error
  })

  return server
}
