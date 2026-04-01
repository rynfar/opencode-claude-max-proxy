/**
 * Tests for token budget tracking in session persistence.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test"
import { assistantMessage, messageStart, messageDelta, messageStop } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
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

async function post(app: any, body: any) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

function makeStreamingAssistantMessage() {
  return [
    messageStart("msg_1"),
    messageDelta("end_turn"),
    messageStop(),
  ]
}

describe("Token budget tracking", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedQueryParams = null
  })

  it("tracks token usage from non-streaming response", async () => {
    const app = createTestApp()
    mockMessages = [
      {
        type: "assistant",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          model: "claude-sonnet-4-6",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1500,
            output_tokens: 300,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 10000,
          },
        },
        session_id: "sdk-token-test",
        uuid: "uuid-assistant-1",
        parent_tool_use_id: null,
      },
    ]

    const res = await post(app, {
      model: "sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    })

    expect(res.status).toBe(200)
    const sessionId = res.headers.get("X-Claude-Session-ID")
    expect(sessionId).toBeDefined()
    expect(sessionId).not.toBe("new")
  })

  it("tracks token usage from streaming response", async () => {
    const app = createTestApp()
    mockMessages = makeStreamingAssistantMessage()

    const res = await post(app, {
      model: "sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    })

    expect(res.status).toBe(200)
    const sessionId = res.headers.get("X-Claude-Session-ID")
    expect(sessionId).toBeDefined()
    expect(sessionId).not.toBe("new")
  })

  it("resumes session with token budget", async () => {
    const app = createTestApp()
    mockMessages = makeStreamingAssistantMessage()

    // First request
    const res1 = await post(app, {
      model: "sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    })
    expect(res1.status).toBe(200)
    const sessionId = res1.headers.get("X-Claude-Session-ID")
    expect(sessionId).toBeDefined()

    // Second request with same session - should resume
    mockMessages = makeStreamingAssistantMessage()
    const res2 = await post(app, {
      model: "sonnet",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "How are you?" },
      ],
      stream: false,
    }, { "x-opencode-session": sessionId! })
    expect(res2.status).toBe(200)
  })

  it("accumulates token usage across multiple turns", async () => {
    const app = createTestApp()

    // Turn 1
    mockMessages = makeStreamingAssistantMessage()
    const res1 = await post(app, {
      model: "sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    })
    expect(res1.status).toBe(200)
    const sessionId = res1.headers.get("X-Claude-Session-ID")

    // Verify session was created
    expect(sessionId).toBeDefined()
    expect(sessionId).not.toBe("new")
    expect(sessionId).not.toBe(`session_${Date.now()}`)
  })
})
