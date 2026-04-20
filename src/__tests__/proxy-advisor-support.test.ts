import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  assistantMessage,
  blockStop,
  messageDelta,
  messageStart,
  parseSSE,
  streamEvent,
  textBlockStart,
  textDelta,
} from "./helpers"

let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function readStreamFull(response: Response): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return result
}

describe("Advisor request handling", () => {
  beforeEach(() => {
    mockMessages = []
    clearSessionCache()
  })

  it("rejects native advisor tool requests on /v1/messages", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" }],
      }),
    }))

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("advisor tool requests are not supported")
  })

  it("rejects native advisor tool requests on /v1/chat/completions", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7" }],
      }),
    }))

    expect(res.status).toBe(400)
  })
})

describe("Advisor response preservation", () => {
  beforeEach(() => {
    mockMessages = []
    clearSessionCache()
  })

  it("preserves server_tool_use and advisor_tool_result in non-streaming responses", async () => {
    mockMessages = [assistantMessage([
      { type: "text", text: "Let me consult Opus." },
      { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
      { type: "advisor_tool_result", content: [{ type: "advisor_result", text: "Plan first." }] },
    ])]
    mockMessages[0].message.stop_reason = "pause_turn"

    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.stop_reason).toBe("pause_turn")
    expect(body.content[1]).toEqual({ type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} })
    expect(body.content[2].type).toBe("advisor_tool_result")
  })

  it("forwards advisor stream events unchanged", async () => {
    mockMessages = [
      messageStart("msg_advisor"),
      textBlockStart(0),
      textDelta(0, "Consulting advisor."),
      blockStop(0),
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
      }),
      streamEvent({ type: "content_block_stop", index: 1 }),
      streamEvent({
        type: "content_block_start",
        index: 2,
        content_block: { type: "advisor_tool_result", content: [] },
      }),
      streamEvent({
        type: "content_block_delta",
        index: 2,
        delta: { type: "text_delta", text: "Plan first." },
      }),
      streamEvent({ type: "content_block_stop", index: 2 }),
      messageDelta("pause_turn"),
      streamEvent({ type: "message_stop" }),
    ]

    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }))

    expect(res.status).toBe(200)
    const events = parseSSE(await readStreamFull(res))
    const serverToolStart = events.find((e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "server_tool_use")
    expect(serverToolStart).toBeDefined()
    const advisorDelta = events.find((e) => e.event === "content_block_delta" && (e.data as any).index === 2)
    expect((advisorDelta?.data as any).delta.text).toBe("Plan first.")
    const msgDelta = events.find((e) => e.event === "message_delta")
    expect((msgDelta?.data as any).delta.stop_reason).toBe("pause_turn")
  })
})
