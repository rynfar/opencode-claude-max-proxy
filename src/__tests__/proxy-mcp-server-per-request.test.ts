/**
 * MCP Server Per-Request Tests
 *
 * Verifies that createOpencodeMcpServer() is called fresh for each request,
 * not shared as a singleton. SDK ≥0.2.81 enforces single-use Protocol
 * transports, so reusing a server across requests causes:
 *   "Already connected to a transport. Call close() before connecting to a
 *    new transport, or use a separate Protocol instance per connection."
 *
 * Related: https://github.com/rynfar/meridian/issues/XXX
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

// Track how many times createOpencodeMcpServer is called and what's passed to query
let mcpServerCreateCount = 0
let capturedMcpServers: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    if (params.options?.mcpServers) {
      capturedMcpServers.push(params.options.mcpServers)
    }
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sess-${Date.now()}`,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

// Each call returns a unique object so we can verify they're different instances
mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => {
    mcpServerCreateCount++
    return { type: "sdk", name: "opencode", instance: {}, _id: mcpServerCreateCount }
  },
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const BASIC_REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

describe("MCP server per-request lifecycle", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mcpServerCreateCount = 0
    capturedMcpServers = []
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("should create a new MCP server for each non-streaming request", async () => {
    const app = createTestApp()

    await post(app, BASIC_REQUEST)
    await post(app, BASIC_REQUEST)
    await post(app, BASIC_REQUEST)

    // Each request should have created its own MCP server
    expect(mcpServerCreateCount).toBe(3)
  })

  it("should create a new MCP server for each streaming request", async () => {
    const app = createTestApp()
    const streamRequest = { ...BASIC_REQUEST, stream: true }

    const res1 = await post(app, streamRequest)
    await res1.text() // consume stream
    const res2 = await post(app, streamRequest)
    await res2.text()

    expect(mcpServerCreateCount).toBe(2)
  })

  it("should pass unique MCP server instances to each query call", async () => {
    const app = createTestApp()

    await post(app, BASIC_REQUEST)
    await post(app, BASIC_REQUEST)

    expect(capturedMcpServers.length).toBe(2)

    const server1 = capturedMcpServers[0]!.opencode
    const server2 = capturedMcpServers[1]!.opencode

    // Each should be a distinct object (different _id from our mock)
    expect(server1._id).not.toBe(server2._id)
  })

  it("should create a new MCP server even for resumed sessions", async () => {
    const app = createTestApp()

    // First request: establish session
    await post(app, BASIC_REQUEST, { "x-opencode-session": "session-abc" })

    // Second request: resume session (same session header, extended messages)
    await post(app, {
      ...BASIC_REQUEST,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "follow up" },
      ],
    }, { "x-opencode-session": "session-abc" })

    // Both requests should get fresh MCP server instances
    expect(mcpServerCreateCount).toBe(2)
  })

  it("should not share MCP server between concurrent requests", async () => {
    const app = createTestApp()

    // Fire 3 concurrent requests
    const results = await Promise.all([
      post(app, BASIC_REQUEST),
      post(app, BASIC_REQUEST),
      post(app, BASIC_REQUEST),
    ])

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200)
    }

    // Each should have its own MCP server
    expect(mcpServerCreateCount).toBe(3)
    const ids = capturedMcpServers.map(s => s.opencode._id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(3)
  })
})

describe("MCP server in passthrough mode", () => {
  beforeEach(() => {
    mcpServerCreateCount = 0
    capturedMcpServers = []
    clearSessionCache()
  })

  it("should NOT create opencode MCP server in passthrough mode", async () => {
    const origPassthrough = process.env.CLAUDE_PROXY_PASSTHROUGH
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"

    try {
      const app = createTestApp()
      await post(app, {
        ...BASIC_REQUEST,
        tools: [{ name: "Read", description: "read a file", input_schema: { type: "object", properties: {} } }],
      })

      // In passthrough mode, the opencode MCP server is not used
      // (passthrough creates its own MCP server for forwarding)
      expect(mcpServerCreateCount).toBe(0)
    } finally {
      if (origPassthrough === undefined) {
        delete process.env.CLAUDE_PROXY_PASSTHROUGH
      } else {
        process.env.CLAUDE_PROXY_PASSTHROUGH = origPassthrough
      }
    }
  })
})
