import { Hono } from "hono"
import { cors } from "hono/cors"
import { serve } from "@hono/node-server"
import type { Server } from "node:http"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import { DEFAULT_PROXY_CONFIG } from "./types"
import type { ProxyConfig, ProxyInstance, ProxyServer } from "./types"
export type { ProxyConfig, ProxyInstance, ProxyServer }
import { claudeLog } from "../logger"
import { exec as execCallback } from "child_process"
import { promisify } from "util"

import { randomUUID } from "crypto"
import { withClaudeLogContext } from "../logger"
import { fuzzyMatchAgentName } from "./agentMatch"
import { buildAgentDefinitions } from "./agentDefs"
import { createPassthroughMcpServer, stripMcpPrefix, PASSTHROUGH_MCP_NAME, PASSTHROUGH_MCP_PREFIX } from "./passthroughTools"

import { telemetryStore, diagnosticLog, createTelemetryRoutes, landingHtml } from "../telemetry"
import type { RequestMetric } from "../telemetry"
import { classifyError, isStaleSessionError, isRateLimitError } from "./errors"
import { mapModelToClaudeModel, resolveClaudeExecutableAsync, isClosedControllerError, getClaudeAuthStatusAsync, hasExtendedContext, stripExtendedContext } from "./models"
import { ALLOWED_MCP_TOOLS } from "./tools"
import { getLastUserMessage } from "./messages"
import { openCodeAdapter } from "./adapters/opencode"
import { buildQueryOptions, type QueryContext } from "./query"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  type LineageResult,
} from "./session/lineage"
// Re-export for backwards compatibility (existing tests import from here)

import { lookupSession, storeSession, clearSessionCache, getMaxSessionsLimit, evictSession } from "./session/cache"
// Re-export for backwards compatibility (existing tests import from here)
export { computeLineageHash, hashMessage, computeMessageHashes }
export { clearSessionCache, getMaxSessionsLimit }
export type { LineageResult }











const exec = promisify(execCallback)

let claudeExecutable = ""

/**
 * Build a prompt from all messages for a fresh (non-resume) session.
 * Used when retrying after a stale session UUID error.
 */
function buildFreshPrompt(
  messages: Array<{ role: string; content: any }>,
  stripCacheControl: (content: any) => any
): string | AsyncIterable<any> {
  const MULTIMODAL_TYPES = new Set(["image", "document", "file"])
  const hasMultimodal = messages.some((m) =>
    Array.isArray(m.content) && m.content.some((b: any) => MULTIMODAL_TYPES.has(b.type))
  )

  if (hasMultimodal) {
    const structured: Array<{ type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }> = []
    for (const m of messages) {
      if (m.role === "user") {
        structured.push({
          type: "user" as const,
          message: { role: "user" as const, content: stripCacheControl(m.content) },
          parent_tool_use_id: null,
        })
      } else {
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
    return (async function* () { for (const msg of structured) yield msg })()
  }

  return messages
    .map((m) => {
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
}

export function createProxyServer(config: Partial<ProxyConfig> = {}): ProxyServer {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    // API clients get JSON, browsers get the landing page
    const accept = c.req.header("accept") || ""
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        status: "ok",
        service: "meridian",
        format: "anthropic",
        endpoints: ["/v1/messages", "/messages", "/telemetry", "/health"]
      })
    }
    return c.html(landingHtml)
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
        const authStatus = await getClaudeAuthStatusAsync()
        let model = mapModelToClaudeModel(body.model || "sonnet", authStatus?.subscriptionType)
        const stream = body.stream ?? true
        const adapter = openCodeAdapter
        const workingDirectory = adapter.extractWorkingDirectory(body) || process.env.CLAUDE_PROXY_WORKDIR || process.cwd()

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

        // Session resume: look up cached Claude SDK session and classify mutation
        const opencodeSessionId = adapter.getSessionId(c)
        const lineageResult = lookupSession(opencodeSessionId, body.messages || [], workingDirectory)
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
        const requestLogLine = `${requestMeta.requestId} model=${model} stream=${stream} tools=${body.tools?.length ?? 0} lineage=${lineageType} session=${resumeSessionId?.slice(0, 8) || "new"}${isUndo && undoRollbackUuid ? ` rollback=${undoRollbackUuid.slice(0, 8)}` : ""} active=${activeSessions}/${MAX_CONCURRENT_SESSIONS} msgCount=${msgCount}`
        console.error(`[PROXY] ${requestLogLine} msgs=${msgSummary}`)
        diagnosticLog.session(`${requestLogLine}`, requestMeta.requestId)

        claudeLog("request.received", {
          model,
          stream,
          queueWaitMs: requestMeta.queueStartedAt - requestMeta.queueEnteredAt,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          hasSystemPrompt: Boolean(body.system)
        })

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
                message: { role: "user" as const, content: stripCacheControl(m.content) },
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
              structuredMessages.push({
                type: "user" as const,
                message: { role: "user" as const, content: text },
                parent_tool_use_id: null,
              })
            }
          }
        }
      } else {
        // Text prompt — convert messages to string
        textPrompt = messagesToConvert
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

          // Build SDK UUID map: start with previously stored UUIDs (if resuming),
          // then capture new ones from the response. Declared outside try so
          // storeSession (in the finally/after block) can access it.
          const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
            ? [...cachedSession.sdkMessageUuids]
            : new Array(allMessages.length - 1).fill(null)
          // Pad to current message count (the last user message has no UUID yet)
          while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

          claudeLog("upstream.start", { mode: "non_stream", model })

          try {
            // Lazy-resolve executable if not already set (e.g. when using createProxyServer directly)
            if (!claudeExecutable) {
              claudeExecutable = await resolveClaudeExecutableAsync()
            }

            // Wrap SDK call with transparent retry for recoverable errors.
            // Both stale-UUID and rate-limit retries happen inside the generator,
            // so the message-processing loop doesn't need any retry logic.
            const response = (async function* () {
              try {
                yield* query(buildQueryOptions({
                  prompt: makePrompt(), model, workingDirectory, systemContext, claudeExecutable,
                  passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv,
                  resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter,
                }))
              } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error)

                // Retry 1: stale undo UUID — evict session and start fresh
                if (isStaleSessionError(error)) {
                  claudeLog("session.stale_uuid_retry", {
                    mode: "non_stream",
                    rollbackUuid: undoRollbackUuid,
                    resumeSessionId,
                  })
                  console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                  evictSession(opencodeSessionId, workingDirectory, allMessages)
                  sdkUuidMap.length = 0
                  for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                  yield* query(buildQueryOptions({
                    prompt: buildFreshPrompt(allMessages, stripCacheControl),
                    model, workingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv,
                    resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, adapter,
                  }))
                  return
                }

                // Retry 2: rate-limited on [1m] — fall back to base model
                if (hasExtendedContext(model) && isRateLimitError(errMsg)) {
                  model = stripExtendedContext(model)
                  claudeLog("upstream.context_fallback", {
                    mode: "non_stream",
                    from: model,
                    to: model,
                    reason: "rate_limit",
                  })
                  console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                  yield* query(buildQueryOptions({
                    prompt: makePrompt(), model, workingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: false, sdkAgents, passthroughMcp, cleanEnv,
                    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter,
                  }))
                  return
                }

                throw error
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

          const totalDurationMs = Date.now() - requestStartAt

          claudeLog("response.completed", {
            mode: "non_stream",
            model,
            durationMs: totalDurationMs,
            contentBlocks: contentBlocks.length,
            hasToolUse
          })

          const nonStreamQueueWaitMs = requestMeta.queueStartedAt - requestMeta.queueEnteredAt
          telemetryStore.record({
            requestId: requestMeta.requestId,
            timestamp: Date.now(),
            model,
            mode: "non-stream",
            isResume,
            isPassthrough: passthrough,
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
          })

          // Store session for future resume
              if (currentSessionId) {
                storeSession(opencodeSessionId, body.messages || [], currentSessionId, workingDirectory, sdkUuidMap)
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

            // Build SDK UUID map for the streaming path (declared before try for storeSession access)
            const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
              ? [...cachedSession.sdkMessageUuids]
              : new Array(allMessages.length - 1).fill(null)
            while (sdkUuidMap.length < allMessages.length) sdkUuidMap.push(null)

            let messageStartEmitted = false

            try {
              let currentSessionId: string | undefined
              // Same transparent retry wrapper as the non-streaming path
              const response = (async function* () {
                try {
                  yield* query(buildQueryOptions({
                    prompt: makePrompt(), model, workingDirectory, systemContext, claudeExecutable,
                    passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv,
                    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter,
                  }))
                } catch (error) {
                  const errMsg = error instanceof Error ? error.message : String(error)

                  if (isStaleSessionError(error)) {
                    claudeLog("session.stale_uuid_retry", {
                      mode: "stream",
                      rollbackUuid: undoRollbackUuid,
                      resumeSessionId,
                    })
                    console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
                    evictSession(opencodeSessionId, workingDirectory, allMessages)
                    sdkUuidMap.length = 0
                    for (let i = 0; i < allMessages.length; i++) sdkUuidMap.push(null)
                    yield* query(buildQueryOptions({
                      prompt: buildFreshPrompt(allMessages, stripCacheControl),
                      model, workingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv,
                      resumeSessionId: undefined, isUndo: false, undoRollbackUuid: undefined, sdkHooks, adapter,
                    }))
                    return
                  }

                  if (hasExtendedContext(model) && isRateLimitError(errMsg)) {
                    model = stripExtendedContext(model)
                    claudeLog("upstream.context_fallback", {
                      mode: "stream",
                      from: model,
                      to: model,
                      reason: "rate_limit",
                    })
                    console.error(`[PROXY] ${requestMeta.requestId} rate-limited on [1m], retrying with ${model}`)
                    yield* query(buildQueryOptions({
                      prompt: makePrompt(), model, workingDirectory, systemContext, claudeExecutable,
                      passthrough, stream: true, sdkAgents, passthroughMcp, cleanEnv,
                      resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter,
                    }))
                    return
                  }

                  throw error
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
              const streamedToolUseIds = new Set<string>()

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
                storeSession(opencodeSessionId, body.messages || [], currentSessionId, workingDirectory, sdkUuidMap)
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
                telemetryStore.record({
                  requestId: requestMeta.requestId,
                  timestamp: Date.now(),
                  model,
                  mode: "stream",
                  isResume,
                  isPassthrough: passthrough,
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

              const errMsg = error instanceof Error ? error.message : String(error)
              claudeLog("upstream.failed", {
                mode: "stream",
                model,
                durationMs: Date.now() - upstreamStartAt,
                streamEventsSeen,
                textEventsForwarded,
                error: errMsg
              })
              const streamErr = classifyError(errMsg)
              claudeLog("proxy.anthropic.error", { error: errMsg, classified: streamErr.type })
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
          model: "unknown",
          mode: "non-stream",
          isResume: false,
          isPassthrough: Boolean(process.env.CLAUDE_PROXY_PASSTHROUGH),
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

  // Health check endpoint — verifies auth status
  app.get("/health", async (c) => {
    try {
      const auth = await getClaudeAuthStatusAsync()
      if (!auth) {
        return c.json({
          status: "degraded",
          error: "Could not verify auth status",
          mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
        })
      }
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

export async function startProxyServer(config: Partial<ProxyConfig> = {}): Promise<ProxyInstance> {
  claudeExecutable = await resolveClaudeExecutableAsync()
  const { app, config: finalConfig } = createProxyServer(config)

  const server = serve({
    fetch: app.fetch,
    port: finalConfig.port,
    hostname: finalConfig.host,
    overrideGlobalObjects: false,
  }, (info) => {
    if (!finalConfig.silent) {
      console.log(`Meridian running at http://${finalConfig.host}:${info.port}`)
      console.log(`Telemetry dashboard: http://${finalConfig.host}:${info.port}/telemetry`)
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
      console.error(`  CLAUDE_PROXY_PORT=4567 claude-max-proxy`)
    }
  })

  return {
    server,
    config: finalConfig,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
