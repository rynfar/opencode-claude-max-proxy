import { Hono } from "hono"
import { cors } from "hono/cors"
import { query } from "@anthropic-ai/claude-agent-sdk"
import PQueue from "p-queue"
import type { Context } from "hono"
import type { ProxyConfig } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { opencodeMcpServer } from "../mcpTools"

const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
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

// Queue to serialize Claude Agent SDK queries and avoid ~60s delay on concurrent requests
const requestQueue = new PQueue({ concurrency: 1 })

function resolveClaudeExecutable(): string {
  // 1. Try the SDK's bundled cli.js (same dir as this module's SDK)
  try {
    const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const sdkCliJs = join(dirname(sdkPath), "cli.js")
    if (existsSync(sdkCliJs)) return sdkCliJs
  } catch {}

  // 2. Try the system-installed claude binary
  try {
    const claudePath = execSync("which claude", { encoding: "utf-8" }).trim()
    if (claudePath && existsSync(claudePath)) return claudePath
  } catch {}

  throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
}

const claudeExecutable = resolveClaudeExecutable()

function mapModelToClaudeModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus"
  if (model.includes("haiku")) return "haiku"
  return "sonnet"
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
      const model = mapModelToClaudeModel(body.model || "sonnet")
      const stream = body.stream ?? true

      claudeLog("proxy.anthropic.request", { model, stream, messageCount: body.messages?.length })

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

      // Convert messages to a text prompt
      const conversationParts = body.messages
        ?.map((m: { role: string; content: string | Array<{ type: string; text?: string }> }) => {
          const role = m.role === "assistant" ? "Assistant" : "Human"
          let content: string
          if (typeof m.content === "string") {
            content = m.content
          } else if (Array.isArray(m.content)) {
            content = m.content
              .filter((block: any) => block.type === "text" && block.text)
              .map((block: any) => block.text)
              .join("")
          } else {
            content = String(m.content)
          }
          return `${role}: ${content}`
        })
        .join("\n\n") || ""

      // Combine system context with conversation
      const prompt = systemContext
        ? `${systemContext}\n\n${conversationParts}`
        : conversationParts

      if (!stream) {
        let fullContent = ""
        const response = query({
          prompt,
          options: {
            maxTurns: 100,
            model,
            pathToClaudeCodeExecutable: claudeExecutable,
            disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
            allowedTools: [...ALLOWED_MCP_TOOLS],
            mcpServers: {
              [MCP_SERVER_NAME]: opencodeMcpServer
            }
          }
        })

        for await (const message of response) {
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "text") {
                fullContent += block.text
              }
            }
          }
        }

        // If no text content was produced (e.g. only tool_use), return a fallback
        if (!fullContent) {
          fullContent = "I can help with that. Could you provide more details about what you'd like me to do?"
        }

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
          try {
            const response = query({
              prompt,
              options: {
                maxTurns: 100,
                model,
                pathToClaudeCodeExecutable: claudeExecutable,
                includePartialMessages: true,
                disallowedTools: [...BLOCKED_BUILTIN_TOOLS],
                allowedTools: [...ALLOWED_MCP_TOOLS],
                mcpServers: {
                  [MCP_SERVER_NAME]: opencodeMcpServer
                }
              }
            })

            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`))
              } catch {
                clearInterval(heartbeat)
              }
            }, 15_000)

            const skipBlockIndices = new Set<number>()

            try {
              for await (const message of response) {
                if (message.type === "stream_event") {
                  const event = message.event
                  const eventType = event.type
                  const eventIndex = (event as any).index as number | undefined

                  // Filter out tool_use content blocks — OpenCode expects text only
                  if (eventType === "content_block_start") {
                    const block = (event as any).content_block
                    if (block?.type === "tool_use") {
                      if (eventIndex !== undefined) skipBlockIndices.add(eventIndex)
                      continue
                    }
                  }

                  // Skip deltas and stops for tool_use blocks
                  if (eventIndex !== undefined && skipBlockIndices.has(eventIndex)) {
                    continue
                  }

                  // Override message_delta to always show end_turn
                  if (eventType === "message_delta") {
                    const patched = {
                      ...event,
                      delta: { ...((event as any).delta || {}), stop_reason: "end_turn" },
                      usage: (event as any).usage || { output_tokens: 0 }
                    }
                    controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(patched)}\n\n`))
                    continue
                  }

                  // Forward all other events (message_start, text deltas, content_block_start/stop for text, message_stop)
                  controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`))
                }
              }
            } finally {
              clearInterval(heartbeat)
            }

            controller.close()
          } catch (error) {
            claudeLog("proxy.anthropic.error", { error: error instanceof Error ? error.message : String(error) })
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: "api_error", message: error instanceof Error ? error.message : "Unknown error" }
            })}\n\n`))
            controller.close()
          }
        }
      })

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
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

  app.post("/v1/messages", (c) => requestQueue.add(() => handleMessages(c)))
  app.post("/messages", (c) => requestQueue.add(() => handleMessages(c)))

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    fetch: app.fetch
  })

  console.log(`Claude Max Proxy (Anthropic API) running at http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`\nTo use with OpenCode, run:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)

  return server
}
