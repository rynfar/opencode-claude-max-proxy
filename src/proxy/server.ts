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

      if (!stream) {
        let fullContent = ""
        const response = query({
          prompt,
          options: { maxTurns: 1, model }
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
            controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
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
            })}\n\n`))

            controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" }
            })}\n\n`))

            const response = query({
              prompt,
              options: { maxTurns: 1, model }
            })

            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`))
              } catch {
                clearInterval(heartbeat)
              }
            }, 15_000)

            try {
              for await (const message of response) {
                if (message.type === "assistant") {
                  for (const block of message.message.content) {
                    if (block.type === "text") {
                      controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: 0,
                        delta: { type: "text_delta", text: block.text }
                      })}\n\n`))
                    }
                  }
                }
              }
            } finally {
              clearInterval(heartbeat)
            }

            controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0
            })}\n\n`))

            controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 }
            })}\n\n`))

            controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
              type: "message_stop"
            })}\n\n`))

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

  app.post("/v1/messages", handleMessages)
  app.post("/messages", handleMessages)

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
