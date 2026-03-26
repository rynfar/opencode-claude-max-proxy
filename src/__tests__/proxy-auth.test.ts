import { beforeEach, describe, expect, it, mock } from "bun:test"

let queryCallCount = 0

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    queryCallCount += 1
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg-auth",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        session_id: "sdk-auth",
      }
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

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "/usr/bin/claude",
  isClosedControllerError: () => false,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  hasExtendedContext: () => false,
  stripExtendedContext: (model: string) => model,
}))

const { createProxyServer } = await import("../proxy/server")

function createTestApp(config: Record<string, unknown> = {}) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", ...config })
  return app
}

async function post(app: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    }),
  }))
}

describe("Proxy API key auth", () => {
  beforeEach(() => {
    queryCallCount = 0
  })

  it("allows requests when API key auth is disabled", async () => {
    const app = createTestApp()

    const response = await post(app, { "x-api-key": "dummy" })
    expect(response.status).toBe(200)
    expect(queryCallCount).toBe(1)
  })

  it("allows requests with a configured x-api-key", async () => {
    const app = createTestApp({ requiredApiKeys: ["alpha", "beta"] })

    const response = await post(app, { "x-api-key": "beta" })
    expect(response.status).toBe(200)
    expect(queryCallCount).toBe(1)
  })

  it("allows requests with a bearer token", async () => {
    const app = createTestApp({ requiredApiKeys: ["alpha", "beta"] })

    const response = await post(app, { authorization: "Bearer alpha" })
    expect(response.status).toBe(200)
    expect(queryCallCount).toBe(1)
  })

  it("rejects requests with no key when auth is enabled", async () => {
    const app = createTestApp({ requiredApiKeys: ["alpha"] })

    const response = await post(app)
    const body = await response.json() as any

    expect(response.status).toBe(401)
    expect(body.error.type).toBe("authentication_error")
    expect(queryCallCount).toBe(0)
  })

  it("rejects requests with the wrong key", async () => {
    const app = createTestApp({ requiredApiKeys: ["alpha"] })

    const response = await post(app, { "x-api-key": "wrong" })
    const body = await response.json() as any

    expect(response.status).toBe(401)
    expect(body.error.type).toBe("authentication_error")
    expect(queryCallCount).toBe(0)
  })
})
