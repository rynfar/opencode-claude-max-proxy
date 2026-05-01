/**
 * Regression: SDK `result` message carries the authoritative aggregate usage
 * (closes #449).
 *
 * The Claude Agent SDK emits messages in two forms during a single non-streaming
 * /v1/messages call:
 *
 *   1. One or more `assistant` messages, each with a `usage` snapshot of the
 *      LAST iteration only. For multi-iteration runs (or even single-iteration
 *      runs where the assistant message is constructed mid-stream) the
 *      `output_tokens` here is wrong — typically a single-digit value.
 *   2. A single `result` message at the end with the AGGREGATE usage across
 *      all iterations, plus an `iterations[]` breakdown.
 *
 * Meridian's loop used to only consume the assistant messages. Result was
 * `output_tokens: 1` reported for any non-trivial response. Fix: also consume
 * the `result` message's usage as authoritative when present.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { assistantMessage } from "./helpers"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_params: unknown) => (async function* () {
    for (const m of mockMessages) yield m
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

let mockMessages: unknown[] = []

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postChatNonStream(app: ReturnType<typeof createTestApp>) {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 300,
      stream: false,
      messages: [{ role: "user", content: "Write 50 words about JSON." }],
    }),
  }))
  return res.json() as Promise<{ usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }>
}

/**
 * Faithful reproduction of what `@anthropic-ai/claude-agent-sdk` emits at the
 * end of a non-streaming request — captured by adding a temporary
 * `console.error(JSON.stringify(message))` in server.ts during the
 * investigation that produced this fix. Includes the iterations[] breakdown
 * the SDK populates (consumed by `normalizeContextUsage` from #411).
 */
function resultMessage(usage: Record<string, unknown>): unknown {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1500,
    duration_api_ms: 1200,
    is_error: false,
    num_turns: 1,
    session_id: "test-session",
    total_cost_usd: 0.0001,
    usage,
  }
}

describe("non-stream output_tokens uses SDK `result` message (regression #449)", () => {
  beforeEach(() => {
    clearSessionCache()
    mockMessages = []
  })

  it("uses result.output_tokens when assistant.output_tokens is misreported as 1", async () => {
    // Assistant message reports the last-iteration snapshot (wrong).
    mockMessages = [
      assistantMessage([{ type: "text", text: "JSON is a lightweight data format..." }]),
      resultMessage({
        input_tokens: 3,
        output_tokens: 67,           // ← the truth (sum across iterations)
        cache_read_input_tokens: 5326,
        cache_creation_input_tokens: 0,
        iterations: [
          { input_tokens: 3, output_tokens: 67, cache_read_input_tokens: 5326, cache_creation_input_tokens: 0, type: "message" },
        ],
      }),
    ]
    // Override assistant's wrong output_tokens to make the divergence explicit.
    ;(mockMessages[0] as { message: { usage: { output_tokens: number } } }).message.usage.output_tokens = 1

    const body = await postChatNonStream(createTestApp())
    expect(body.usage.output_tokens).toBe(67)
    expect(body.usage.input_tokens).toBe(3)
    expect(body.usage.cache_read_input_tokens).toBe(5326)
  })

  it("preserves cache fields from result message", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "..." }]),
      resultMessage({
        input_tokens: 5,
        output_tokens: 200,
        cache_read_input_tokens: 9876,
        cache_creation_input_tokens: 1234,
      }),
    ]
    const body = await postChatNonStream(createTestApp())
    expect(body.usage.output_tokens).toBe(200)
    expect(body.usage.cache_read_input_tokens).toBe(9876)
    expect(body.usage.cache_creation_input_tokens).toBe(1234)
  })

  it("falls back to assistant.usage when no result message is emitted", async () => {
    // Defensive: not all SDK paths necessarily emit `result`. If absent, the
    // pre-fix behavior (use last assistant.usage) should still apply.
    mockMessages = [
      assistantMessage([{ type: "text", text: "..." }]),
    ]
    ;(mockMessages[0] as { message: { usage: { output_tokens: number } } }).message.usage.output_tokens = 42

    const body = await postChatNonStream(createTestApp())
    expect(body.usage.output_tokens).toBe(42)
  })

  it("ignores result messages with no usage field", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "..." }]),
      { type: "result", subtype: "success", session_id: "x" }, // malformed: no usage
    ]
    ;(mockMessages[0] as { message: { usage: { output_tokens: number } } }).message.usage.output_tokens = 17

    const body = await postChatNonStream(createTestApp())
    expect(body.usage.output_tokens).toBe(17)
  })

  it("uses result.output_tokens even when its iterations show the per-step values", async () => {
    // Verify we correctly use the top-level aggregate, not the last iteration.
    mockMessages = [
      assistantMessage([{ type: "text", text: "..." }]),
      resultMessage({
        input_tokens: 10,
        output_tokens: 150,  // SUM
        iterations: [
          { input_tokens: 10, output_tokens: 100, type: "message" },
          { input_tokens: 10, output_tokens: 50, type: "message" }, // last iteration
        ],
      }),
    ]
    const body = await postChatNonStream(createTestApp())
    // We want the aggregate (150), not the last iteration (50).
    expect(body.usage.output_tokens).toBe(150)
  })
})
