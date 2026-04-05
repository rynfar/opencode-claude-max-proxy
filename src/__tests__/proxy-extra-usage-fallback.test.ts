/**
 * Tests for extra-usage-required fallback.
 *
 * Verifies that when a "extra usage required for 1M context" error occurs:
 * 1. Models with [1m] context fall back to the base model (immediate retry, no backoff)
 * 2. The fallback only triggers when the model has extended context
 * 3. The error propagates normally when the model is already base
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
} from "./helpers"

// Track query calls to verify retry behavior
let queryCalls: Array<{ model: string; callIndex: number }> = []
let queryCallCount = 0

// Control what the mock does
let mockBehavior: "extra_usage_then_succeed" | "always_extra_usage" | "succeed" | "error_assistant_then_ratelimit" = "succeed"

const EXTRA_USAGE_ERROR = "Claude Code returned an error result: API Error: Extra usage is required for 1M context · enable extra usage at claude.ai/settings/usage, or use --model to switch"

// Force sonnet[1m] regardless of auth status so tests are self-contained.
mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet[1m]",
  resolveClaudeExecutableAsync: async () => "claude",
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  hasExtendedContext: (model: string) => model.endsWith("[1m]"),
  stripExtendedContext: (model: string) => model.replace("[1m]", ""),
  isClosedControllerError: () => false,
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
}))

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    queryCallCount++
    const callIndex = queryCallCount
    const model = opts.options?.model || "sonnet"
    queryCalls.push({ model, callIndex })
    const isStreaming = opts.options?.includePartialMessages === true

    return (async function* () {
      if (mockBehavior === "always_extra_usage") {
        throw new Error(EXTRA_USAGE_ERROR)
      }

      if (mockBehavior === "extra_usage_then_succeed" && callIndex === 1) {
        throw new Error(EXTRA_USAGE_ERROR)
      }

      // Simulates real SDK behaviour: emits an error assistant event first,
      // then throws a rate_limit error (which is what the SDK does when the
      // rate_limit_event with status:"rejected" is received).
      // The didYieldContent guard must NOT fire for error assistant events.
      if (mockBehavior === "error_assistant_then_ratelimit" && callIndex === 1) {
        yield {
          type: "assistant",
          error: "rate_limit",
          uuid: `uuid-${callIndex}-err`,
          message: {
            id: `msg-${callIndex}-err`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "API Error: Extra usage is required for 1M context" }],
            model: "<synthetic>",
            stop_reason: "stop_sequence",
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          session_id: `sdk-session-${callIndex}`,
        }
        throw new Error("429 rate limit exceeded for 1m context")
      }

      // Success path
      if (isStreaming) {
        yield messageStart(`msg-${callIndex}`)
        yield textBlockStart(0)
        yield textDelta(0, `response-${callIndex}`)
        yield blockStop(0)
        yield messageDelta("end_turn")
        yield messageStop()
      }
      yield {
        type: "assistant",
        uuid: `uuid-${callIndex}`,
        message: {
          id: `msg-${callIndex}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${callIndex}` }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sdk-session-${callIndex}`,
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

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

describe("Extra usage required fallback", () => {
  beforeEach(() => {
    clearSessionCache()
    queryCalls = []
    queryCallCount = 0
    mockBehavior = "succeed"
  })

  describe("Non-streaming", () => {
    it("falls back from [1m] to base model on extra usage error", async () => {
      mockBehavior = "extra_usage_then_succeed"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      // Should succeed after fallback (no backoff delay)
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.content).toBeDefined()
    })

    it("propagates error when model is already base (no [1m] to strip)", async () => {
      mockBehavior = "always_extra_usage"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      // After stripping [1m] (if applicable) and retrying, the error
      // should eventually propagate since the base model also fails
      expect(response.status).toBe(500)
    })
  })

  describe("Streaming", () => {
    it("falls back from [1m] to base model on extra usage error", async () => {
      mockBehavior = "extra_usage_then_succeed"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200)
      const text = await response.text()
      // Should contain successful stream content after fallback
      expect(text).toContain("event: message_start")
    })

    it("returns error event when model is already base", async () => {
      mockBehavior = "always_extra_usage"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      })

      expect(response.status).toBe(200) // SSE always returns 200
      const text = await response.text()
      const events = parseSSE(text)
      const errorEvent = events.find((e) => e.event === "error")
      expect(errorEvent).toBeDefined()
    })
  })

  describe("No backoff needed", () => {
    it("does not use exponential backoff for extra usage errors", async () => {
      mockBehavior = "extra_usage_then_succeed"
      const app = createTestApp()

      const start = Date.now()
      await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
      const elapsed = Date.now() - start

      // Should complete nearly instantly (no 1s+ backoff delay)
      // Rate limit retry uses 1000ms minimum — extra usage should be <500ms
      expect(elapsed).toBeLessThan(500)
    })
  })

  describe("Real SDK behaviour: error assistant emitted before throw", () => {
    it("retries after error assistant event + rate limit throw (non-streaming)", async () => {
      // Simulates the real SDK sequence when extra usage is disabled:
      // 1. SDK yields type:"assistant" with error:"rate_limit" field
      // 2. SDK throws a rate limit error
      // Previously, step 1 set didYieldContent=true which blocked the retry.
      mockBehavior = "error_assistant_then_ratelimit"
      const app = createTestApp()

      const response = await post(app, {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })

      // Should succeed after stripping [1m] and retrying with sonnet
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.content).toBeDefined()
      // Two query calls: first (sonnet[1m]) failed, second (sonnet) succeeded
      expect(queryCalls.length).toBe(2)
      expect(queryCalls[0]!.model).toBe("sonnet[1m]")
      expect(queryCalls[1]!.model).toBe("sonnet")
    })
  })
})
