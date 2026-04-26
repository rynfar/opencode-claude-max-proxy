/**
 * Integration tests for subagent model selection.
 *
 * Verifies that when the x-opencode-agent-mode header is set to "subagent",
 * the proxy selects the base model (sonnet/opus) instead of the 1M variant,
 * conserving rate limit budget for the primary agent.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

let capturedModel: string | null = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedModel = opts.options?.model ?? null
    return (async function* () {
      yield {
        type: "assistant",
        uuid: "test-uuid",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: capturedModel,
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        session_id: "sdk-session-1",
      }
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

// Fix auth status so mapModelToClaudeModel always picks the max/1m path
mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: (model: string, sub?: string | null, agentMode?: string | null) => {
    const base = model.toLowerCase()
    if (base.includes("opus")) return agentMode === "subagent" ? "opus" : "opus[1m]"
    if (base.includes("haiku")) return "haiku"
    // Sonnet [1m] requires Extra Usage on Max — default to 200k for all agents
    return "sonnet"
  },
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults: () => ({}),
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: (m: string) => m.endsWith("[1m]"),
  stripExtendedContext: (m: string) => m.replace("[1m]", "") as any,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
  resetCachedClaudeAuthStatus: () => {},
  resetCachedClaudePath: () => {},
  expireAuthStatusCache: () => {},
  resetExtendedContextUnavailable: () => {},
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function post(body: any, headers: Record<string, string> = {}) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const BASE_REQUEST = {
  model: "claude-sonnet-4-6",
  max_tokens: 10,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
}

describe("Subagent model selection", () => {
  beforeEach(() => {
    clearSessionCache()
    capturedModel = null
  })

  it("primary agent gets sonnet (200k) for max subscription", async () => {
    // Sonnet [1m] requires Extra Usage on Max — default to 200k
    await post(BASE_REQUEST, { "x-opencode-agent-mode": "primary" })
    expect(capturedModel).toBe("sonnet")
  })

  it("subagent gets base sonnet regardless of subscription", async () => {
    await post(BASE_REQUEST, { "x-opencode-agent-mode": "subagent" })
    expect(capturedModel).toBe("sonnet")
  })

  it("no header behaves as primary (default)", async () => {
    await post(BASE_REQUEST)
    expect(capturedModel).toBe("sonnet")
  })

  it("subagent with opus gets base opus", async () => {
    await post({ ...BASE_REQUEST, model: "claude-opus-4-6" }, { "x-opencode-agent-mode": "subagent" })
    expect(capturedModel).toBe("opus")
  })

  it("primary agent with opus gets opus[1m]", async () => {
    await post({ ...BASE_REQUEST, model: "claude-opus-4-6" }, { "x-opencode-agent-mode": "primary" })
    expect(capturedModel).toBe("opus[1m]")
  })

  it("haiku is unaffected by agent mode", async () => {
    await post({ ...BASE_REQUEST, model: "claude-haiku-4-5" }, { "x-opencode-agent-mode": "subagent" })
    expect(capturedModel).toBe("haiku")
  })

  it("subagent model appears in proxy log line", async () => {
    const logs: string[] = []
    const originalError = console.error
    console.error = (...args: any[]) => logs.push(args.join(" "))
    try {
      await post(BASE_REQUEST, { "x-opencode-agent-mode": "subagent" })
    } finally {
      console.error = originalError
    }
    const proxyLog = logs.find(l => l.includes("[PROXY]"))
    expect(proxyLog).toBeDefined()
    expect(proxyLog).toContain("model=sonnet ")
    expect(proxyLog).toContain("agent=subagent")
  })
})
