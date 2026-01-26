import { Hono } from "hono"
import { cors } from "hono/cors"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"

function mapModelToClaudeModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus"
  if (model.includes("haiku")) return "haiku"
  return "sonnet"
}

function extractTextFromSystem(system: unknown): string {
  if (!system) return ""
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .map((block) => {
      if (!block || typeof block !== "object") return ""
      const maybeType = (block as { type?: unknown }).type
      if (maybeType !== "text") return ""
      const maybeText = (block as { text?: unknown }).text
      return typeof maybeText === "string" ? maybeText : ""
    })
    .filter(Boolean)
    .join("\n")
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
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

  const handleMessages = async (c: Context) => {
    try {
      const body = await c.req.json()
      const requestId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const startedAt = Date.now()

      const rawModel = body.model || "sonnet"
      const model = mapModelToClaudeModel(rawModel)
      const stream = body.stream ?? true

      const systemText = extractTextFromSystem(body.system)
      const queryOptions = {
        maxTurns: finalConfig.maxTurns,
        model,
        permissionMode: finalConfig.permissionMode,
        allowDangerouslySkipPermissions: finalConfig.allowDangerouslySkipPermissions,
        ...(systemText
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: systemText
              }
            }
          : {})
      }

      const bodyKeys = body && typeof body === "object" ? Object.keys(body) : []
      claudeLog("proxy.anthropic.request", {
        requestId,
        path: c.req.path,
        rawModel,
        model,
        stream,
        messageCount: body.messages?.length,
        bodyKeys,
        idleTimeout: finalConfig.idleTimeout,
        sseHeartbeatMs: finalConfig.sseHeartbeatMs,
        maxTurns: finalConfig.maxTurns,
        permissionMode: finalConfig.permissionMode,
        allowDangerouslySkipPermissions: finalConfig.allowDangerouslySkipPermissions,
        systemChars: systemText.length
      })

      claudeLog("proxy.anthropic.request.body", { requestId, body })

      const prompt = body.messages
        ?.map((m: { role: string; content: string | Array<{ type: string; text?: string }> }) => {
          const role = m.role === "assistant" ? "Assistant" : "Human"
          let content: string
          if (typeof m.content === "string") {
            content = m.content
          } else if (Array.isArray(m.content)) {
            content = m.content
              .filter((block) => block.type === "text" && block.text)
              .map((block) => block.text)
              .join("")
          } else {
            content = String(m.content)
          }
          return `${role}: ${content}`
        })
        .join("\n\n") || ""

      claudeLog("proxy.anthropic.prompt", {
        requestId,
        chars: prompt.length,
        startedMsAgo: Date.now() - startedAt
      })

      if (!stream) {
        let fullContent = ""

        claudeLog("proxy.sdk.query.start", { requestId, stream: false })
        const response = query({
          prompt,
          options: queryOptions
        })

        for await (const message of response) {
          claudeLog("proxy.sdk.message", { requestId, type: message.type })
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text") {
                fullContent += block.text
              }
            }
          }
        }

        claudeLog("proxy.sdk.query.end", {
          requestId,
          stream: false,
          durationMs: Date.now() - startedAt,
          outputChars: fullContent.length
        })

        return c.json({
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: fullContent }],
          model: body.model,
          stop_reason: "end_turn",
          usage: { input_tokens: 0, output_tokens: 0 }
        })
      }

      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          const safeEnqueue = (label: string, chunk: string) => {
            try {
              controller.enqueue(encoder.encode(chunk))
              claudeLog("proxy.sse.send", {
                requestId,
                label,
                bytes: chunk.length,
                chunk,
                msSinceStart: Date.now() - startedAt
              })
              return true
            } catch (error) {
              claudeLog("proxy.sse.enqueue_error", {
                requestId,
                label,
                error: error instanceof Error ? error.message : String(error)
              })
              return false
            }
          }

          const sendEvent = (event: string, data: unknown) =>
            safeEnqueue(event, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

          const sendComment = (comment: string) => safeEnqueue(`comment:${comment}`, `: ${comment}\n\n`)

          try {
            sendEvent("message_start", {
              type: "message_start",
              message: {
                id: `msg_${Date.now()}`,
                type: "message",
                role: "assistant",
                content: [],
                model: body.model,
                stop_reason: null,
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            })

            sendEvent("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" }
            })

            claudeLog("proxy.sdk.query.start", { requestId, stream: true })
            const response = query({
              prompt,
              options: queryOptions
            })

            let heartbeat: ReturnType<typeof setInterval> | undefined
            if (finalConfig.sseHeartbeatMs > 0) {
              heartbeat = setInterval(() => {
                const ok = sendComment("ping")
                if (!ok && heartbeat) {
                  clearInterval(heartbeat)
                  heartbeat = undefined
                }
              }, finalConfig.sseHeartbeatMs)
            }

            try {
              let sentText = false
              let successResultText: string | undefined
              let resultError: { subtype: string; errors?: string[] } | undefined

              for await (const message of response) {
                const subtype = (message as { subtype?: string }).subtype

                if (message.type === "assistant") {
                  const blockTypes = Array.isArray(message.message?.content)
                    ? message.message.content.map((b: { type?: unknown }) => b?.type).filter(Boolean)
                    : []
                  claudeLog("proxy.sdk.message", {
                    requestId,
                    type: message.type,
                    blockTypes,
                    msSinceStart: Date.now() - startedAt
                  })
                } else if (message.type === "result") {
                  claudeLog("proxy.sdk.message", {
                    requestId,
                    type: message.type,
                    subtype,
                    is_error: (message as { is_error?: boolean }).is_error,
                    errors: (message as { errors?: string[] }).errors,
                    msSinceStart: Date.now() - startedAt
                  })
                } else {
                  claudeLog("proxy.sdk.message", {
                    requestId,
                    type: message.type,
                    subtype,
                    msSinceStart: Date.now() - startedAt
                  })
                }

                if (message.type === "result") {
                  if (subtype === "success") {
                    successResultText = (message as { result?: string }).result
                  } else if (typeof subtype === "string") {
                    resultError = {
                      subtype,
                      errors: (message as { errors?: string[] }).errors
                    }
                  }
                }

                if (message.type === "assistant") {
                  for (const block of message.message.content) {
                    if (block.type === "text") {
                      sendEvent("content_block_delta", {
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: block.text }
                      })
                      sentText = true
                    }
                  }
                }
              }

              if (!sentText && successResultText && successResultText.trim().length > 0) {
                sendEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: successResultText }
                })
                sentText = true
              }

              if (resultError) {
                sendEvent("error", {
                  type: "error",
                  error: {
                    type: "api_error",
                    message: `Claude Agent SDK ended with ${resultError.subtype}${
                      resultError.errors?.length ? `: ${resultError.errors.join("; ")}` : ""
                    }`
                  }
                })
                controller.close()
                return
              }
            } finally {
              if (heartbeat) clearInterval(heartbeat)
            }

            claudeLog("proxy.sdk.query.end", {
              requestId,
              stream: true,
              durationMs: Date.now() - startedAt
            })

            sendEvent("content_block_stop", {
              type: "content_block_stop",
              index: 0
            })

            sendEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 }
            })

            sendEvent("message_stop", {
              type: "message_stop"
            })

            controller.close()
          } catch (error) {
            claudeLog("proxy.anthropic.error", {
              requestId,
              error: error instanceof Error ? error.message : String(error)
            })

            sendEvent("error", {
              type: "error",
              error: { type: "api_error", message: error instanceof Error ? error.message : "Unknown error" }
            })

            controller.close()
          }
        }
      })

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
          Connection: "keep-alive"
        }
      })
    } catch (error) {
      claudeLog("proxy.error", { error: error instanceof Error ? error.message : String(error) })
      return c.json({
        type: "error",
        error: {
          type: "api_error",
          message: error instanceof Error ? error.message : "Unknown error"
        }
      }, 500)
    }
  }

  app.post("/v1/messages", handleMessages)
  app.post("/messages", handleMessages)

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    idleTimeout: finalConfig.idleTimeout,
    fetch: app.fetch
  })

  console.log(`Claude Max Proxy (Anthropic API) running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`\nTo use with OpenCode, run:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
