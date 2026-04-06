/**
 * Integration tests for SDK parameter passthrough + usage logging.
 *
 * Covers:
 *   - effort/thinking/taskBudget/betas forwarded from body fields
 *   - Header overrides (x-opencode-effort, x-opencode-thinking, etc.)
 *   - Malformed x-opencode-thinking header is ignored (with log, no crash)
 *   - Usage logging: logUsage called after non-streaming and streaming responses
 *   - GET /v1/sessions/:claudeSessionId/context-usage endpoint
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  assistantMessage,
} from "./helpers"


// ─── captured query params ────────────────────────────────────────────────────
let capturedOptions: Record<string, unknown> = {}
let mockMessages: unknown[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedOptions = params.options ?? {}
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(
  app: ReturnType<typeof createTestApp>,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const BASE_BODY = {
  model: "claude-haiku-4-5-20251001",
  max_tokens: 50,
  stream: false,
  messages: [{ role: "user", content: "hi" }],
}

// ─── body field passthrough ───────────────────────────────────────────────────

describe("SDK param passthrough — body fields", () => {
  beforeEach(() => {
    capturedOptions = {}
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    clearSessionCache()
  })

  it("forwards effort from body", async () => {
    const app = createTestApp()
    await post(app, { ...BASE_BODY, effort: "low" })
    expect(capturedOptions.effort).toBe("low")
  })

  it("forwards thinking from body", async () => {
    const thinking = { type: "enabled", budgetTokens: 2048 }
    const app = createTestApp()
    await post(app, { ...BASE_BODY, thinking })
    expect(capturedOptions.thinking).toEqual(thinking)
  })

  it("forwards task_budget from body as taskBudget object", async () => {
    const app = createTestApp()
    await post(app, { ...BASE_BODY, task_budget: { total: 5000 } })
    expect(capturedOptions.taskBudget).toEqual({ total: 5000 })
  })

  it("omits effort/thinking/taskBudget/betas when not in body", async () => {
    const app = createTestApp()
    await post(app, BASE_BODY)
    expect(capturedOptions.effort).toBeUndefined()
    expect(capturedOptions.thinking).toBeUndefined()
    expect(capturedOptions.taskBudget).toBeUndefined()
    expect(capturedOptions.betas).toBeUndefined()
  })
})

// ─── header overrides ─────────────────────────────────────────────────────────

describe("SDK param passthrough — header overrides", () => {
  beforeEach(() => {
    capturedOptions = {}
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    clearSessionCache()
  })

  it("x-opencode-effort overrides body effort", async () => {
    const app = createTestApp()
    await post(app, { ...BASE_BODY, effort: "low" }, { "x-opencode-effort": "high" })
    expect(capturedOptions.effort).toBe("high")
  })

  it("x-opencode-effort takes precedence when body has no effort", async () => {
    const app = createTestApp()
    await post(app, BASE_BODY, { "x-opencode-effort": "max" })
    expect(capturedOptions.effort).toBe("max")
  })

  it("x-opencode-thinking header (JSON) overrides body thinking", async () => {
    const thinking = { type: "enabled", budgetTokens: 8192 }
    const app = createTestApp()
    await post(app, { ...BASE_BODY, thinking: { type: "disabled" } }, {
      "x-opencode-thinking": JSON.stringify(thinking),
    })
    expect(capturedOptions.thinking).toEqual(thinking)
  })

  it("x-opencode-task-budget header overrides body task_budget", async () => {
    const app = createTestApp()
    await post(app, { ...BASE_BODY, task_budget: { total: 1000 } }, {
      "x-opencode-task-budget": "9999",
    })
    expect(capturedOptions.taskBudget).toEqual({ total: 9999 })
  })

  it("anthropic-beta header with free beta is forwarded for claude-max profiles", async () => {
    // Free betas (prompt-caching, context-1m, etc.) must pass through so the
    // SDK can use prompt caching and 1M context. Stripping them caused ~3x
    // token consumption on long conversations.
    // See: https://github.com/rynfar/meridian/issues/278
    const app = createTestApp()
    await post(app, BASE_BODY, { "anthropic-beta": "context-1m-2025-08-07" })
    expect(capturedOptions.betas).toEqual(["context-1m-2025-08-07"])
  })

  it("comma-separated anthropic-beta header forwards all free betas for claude-max", async () => {
    const app = createTestApp()
    await post(app, BASE_BODY, { "anthropic-beta": "context-1m-2025-08-07, interleaved-thinking-2025-05-14" })
    expect(capturedOptions.betas).toEqual([
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
    ])
  })

  it("billable anthropic-beta (extended-cache-ttl) IS stripped for claude-max", async () => {
    const app = createTestApp()
    await post(app, BASE_BODY, { "anthropic-beta": "extended-cache-ttl-2025-04-11" })
    expect(capturedOptions.betas).toBeUndefined()
  })

  it("mixed free + billable anthropic-beta: only billable stripped for claude-max", async () => {
    const app = createTestApp()
    await post(app, BASE_BODY, {
      "anthropic-beta": "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07",
    })
    expect(capturedOptions.betas).toEqual([
      "prompt-caching-2024-07-31",
      "context-1m-2025-08-07",
    ])
  })

  it("anthropic-beta header is forwarded for api-type profiles", async () => {
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1",
      profiles: [{ id: "apiuser", type: "api", apiKey: "sk-test" }],
    })
    await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "dummy",
        "anthropic-beta": "context-1m-2025-08-07",
      },
      body: JSON.stringify(BASE_BODY),
    }))
    expect(capturedOptions.betas).toEqual(["context-1m-2025-08-07"])
  })

  it("malformed x-opencode-thinking header is ignored — request succeeds", async () => {
    const errorSpy = spyOn(console, "error")
    const app = createTestApp()
    const res = await post(app, BASE_BODY, { "x-opencode-thinking": "not-valid-json{{{" })
    expect(res.status).toBe(200)
    expect(capturedOptions.thinking).toBeUndefined()
    // Verify the warning was logged (not silently swallowed)
    const calls = errorSpy.mock.calls.map(c => String(c[0]))
    expect(calls.some(msg => msg.includes("malformed x-opencode-thinking"))).toBe(true)
    errorSpy.mockRestore()
  })

  it("falls back to body thinking when x-opencode-thinking header is malformed", async () => {
    const errorSpy = spyOn(console, "error")
    const app = createTestApp()
    const thinking = { type: "enabled", budgetTokens: 1024 }

    const res = await post(app, { ...BASE_BODY, thinking }, {
      "x-opencode-thinking": "not-valid-json{{{",
    })

    expect(res.status).toBe(200)
    expect(capturedOptions.thinking).toEqual(thinking)
    const calls = errorSpy.mock.calls.map(c => String(c[0]))
    expect(calls.some(msg => msg.includes("malformed x-opencode-thinking"))).toBe(true)
    errorSpy.mockRestore()
  })
})

// ─── usage logging ────────────────────────────────────────────────────────────

describe("Usage logging", () => {
  beforeEach(() => {
    capturedOptions = {}
    clearSessionCache()
  })

  it("logs usage line after non-streaming response", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "hello" }])]
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    await post(app, BASE_BODY)

    const calls = logSpy.mock.calls.map(c => String(c[0]))
    expect(calls.some(msg => msg.includes("usage:") && msg.includes("input=") && msg.includes("output="))).toBe(true)
    logSpy.mockRestore()
  })

  it("logs usage line after streaming response", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "hi"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    const res = await post(app, { ...BASE_BODY, stream: true })
    // drain the stream
    const reader = res.body!.getReader()
    while (!(await reader.read()).done) {}

    const calls = logSpy.mock.calls.map(c => String(c[0]))
    // Usage log should appear (even if 0 tokens in test fixtures)
    expect(calls.some(msg => msg.includes("[PROXY]") && msg.includes("usage:"))).toBe(true)
    logSpy.mockRestore()
  })

  it("formats large token counts with k suffix", async () => {
    // Patch the assistantMessage usage to large values
    mockMessages = [{
      type: "assistant",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        usage: { input_tokens: 15000, output_tokens: 2500, cache_read_input_tokens: 80000 },
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: "test-session-fmt",
    }]
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    await post(app, BASE_BODY)

    const calls = logSpy.mock.calls.map(c => String(c[0]))
    const usageLine = calls.find(msg => msg.includes("usage:"))
    expect(usageLine).toContain("input=15k")
    expect(usageLine).toContain("output=3k")
    expect(usageLine).toContain("cache_read=80k")
    logSpy.mockRestore()
  })

  it("does not include cache fields when zero", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    await post(app, BASE_BODY)

    const calls = logSpy.mock.calls.map(c => String(c[0]))
    const usageLine = calls.find(msg => msg.includes("usage:"))
    expect(usageLine).toBeDefined()
    expect(usageLine).not.toContain("cache_read")
    expect(usageLine).not.toContain("cache_write")
    logSpy.mockRestore()
  })
})

// ─── GET /v1/sessions/:claudeSessionId/context-usage ─────────────────────────

describe("GET /v1/sessions/:claudeSessionId/context-usage", () => {
  beforeEach(() => {
    mockMessages = []
    clearSessionCache()
  })

  it("returns 404 for unknown session ID", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/sessions/unknown-id/context-usage"))
    expect(res.status).toBe(404)
  })

  it("returns usage after a completed request", async () => {
    const claudeSessionId = "sess_usage_test_001"
    mockMessages = [{
      type: "assistant",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: claudeSessionId,
    }]

    const app = createTestApp()
    // Fire a request to populate the session cache with usage
    await post(app, { ...BASE_BODY, "x-opencode-session": "agent-session-abc" }, {
      "x-opencode-session": "agent-session-abc",
    })

    const res = await app.fetch(
      new Request(`http://localhost/v1/sessions/${claudeSessionId}/context-usage`)
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.session_id).toBe(claudeSessionId)
    expect(body.context_usage).toBeDefined()
    const usage = body.context_usage as Record<string, unknown>
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(50)
  })

  it("returns usage for sessions tracked only by fingerprint fallback", async () => {
    const claudeSessionId = "sess_usage_fingerprint_only"
    mockMessages = [{
      type: "assistant",
      message: {
        id: "msg_fingerprint",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 6 },
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: claudeSessionId,
    }]

    const app = createTestApp()
    await post(app, BASE_BODY)

    const res = await app.fetch(
      new Request(`http://localhost/v1/sessions/${claudeSessionId}/context-usage`)
    )
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const usage = body.context_usage as Record<string, unknown>
    expect(body.session_id).toBe(claudeSessionId)
    expect(usage.input_tokens).toBe(12)
    expect(usage.output_tokens).toBe(6)
  })

  it("returns 404 when session exists but has no usage data", async () => {
    // Sessions from before usage tracking was added won't have contextUsage
    const { storeSession } = await import("../proxy/session/cache")
    storeSession("agent-no-usage", [{ role: "user", content: "hi" }], "sess_no_usage_001", "/tmp")

    const app = createTestApp()
    const res = await app.fetch(
      new Request("http://localhost/v1/sessions/sess_no_usage_001/context-usage")
    )
    expect(res.status).toBe(404)
  })

  it("uses the Claude session ID from the response, not the agent session ID", async () => {
    const claudeSessionId = "sess_claude_id_check"
    const agentSessionId = "agent-id-xyz-different"

    mockMessages = [{
      type: "assistant",
      message: {
        id: "msg_test2",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        model: "claude-haiku-4-5-20251001",
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: claudeSessionId,
    }]

    const app = createTestApp()
    await post(app, BASE_BODY, { "x-opencode-session": agentSessionId })

    // Agent session ID → 404
    const byAgent = await app.fetch(
      new Request(`http://localhost/v1/sessions/${agentSessionId}/context-usage`)
    )
    expect(byAgent.status).toBe(404)

    // Claude session ID → 200
    const byClaude = await app.fetch(
      new Request(`http://localhost/v1/sessions/${claudeSessionId}/context-usage`)
    )
    expect(byClaude.status).toBe(200)
  })
})

// Note: context-usage shared store test is in proxy-context-usage-store.test.ts,
// which runs in a separate bun test invocation to avoid module-singleton
// contamination from parallel test files that also use setSessionStoreDir.
