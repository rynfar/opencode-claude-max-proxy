/**
 * Deferred tool loading in passthrough mode.
 *
 * When tools have defer_loading: true, Meridian enables the SDK's ToolSearch
 * mechanism. Non-deferred tools are marked alwaysLoad. ToolSearch calls are
 * handled internally by the SDK and filtered from responses.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  messageStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
  assistantMessage,
  makeRequest,
} from "./helpers"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ─── SDK mock ────────────────────────────────────────────────────────────────
let mockMessages: SDKMessage[] = []
let capturedQueryParams: any = {}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: any) => {
    capturedQueryParams = opts
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function app() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

const ALWAYS_LOADED_TOOL = {
  name: "read",
  description: "Read a file",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}

const DEFERRED_TOOL = {
  name: "custom_lint",
  description: "Run custom linter",
  input_schema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
  defer_loading: true,
}

// Generate N generic tools for threshold testing
function makeTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i).padStart(2, "0")}`,
    description: `Tool ${i}`,
    input_schema: { type: "object", properties: { input: { type: "string" } } },
  }))
}

let savedPassthrough: string | undefined
let savedThreshold: string | undefined

beforeEach(() => {
  clearSessionCache()
  mockMessages = []
  capturedQueryParams = {}
  savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
  savedThreshold = process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
  process.env.MERIDIAN_PASSTHROUGH = "1"
  delete process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
})

afterEach(() => {
  if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
  else delete process.env.MERIDIAN_PASSTHROUGH
  if (savedThreshold !== undefined) process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = savedThreshold
  else delete process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
})

describe("deferred tool loading — query options", () => {
  it("sets ENABLE_TOOL_SEARCH=true when tools have defer_loading", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("true")
  })

  it("sets ENABLE_TOOL_SEARCH=false when no tools have defer_loading", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL],
        messages: [{ role: "user", content: "Read a file" }],
      })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
  })
})

describe("deferred tool loading — ToolSearch filtering", () => {
  it("filters ToolSearch tool_use blocks from streaming responses", async () => {
    mockMessages = [
      messageStart(),
      // ToolSearch call (SDK internal — should be filtered)
      toolUseBlockStart(0, "ToolSearch", "tu_search_001"),
      inputJsonDelta(0, '{"query":"custom_lint"}'),
      blockStop(0),
      // Actual tool call (should pass through)
      toolUseBlockStart(1, "mcp__oc__custom_lint", "tu_lint_001"),
      inputJsonDelta(1, '{"file":"/tmp/app.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: true,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    const text = await res.text()
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const toolNames = blockStarts
      .filter((e) => (e.data as any).content_block?.type === "tool_use")
      .map((e) => (e.data as any).content_block?.name)

    expect(toolNames).not.toContain("ToolSearch")
    expect(toolNames).toContain("custom_lint")
  })

  it("filters ToolSearch from non-streaming responses", async () => {
    const PREFIX = "mcp__oc__"
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "tu_search_002", name: "ToolSearch", input: { query: "custom_lint" } },
      { type: "tool_use", id: "tu_lint_002", name: `${PREFIX}custom_lint`, input: { file: "/tmp/app.ts" } },
    ])]

    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>
    const toolNames = content.filter((b) => b.type === "tool_use").map((b) => b.name)

    expect(toolNames).not.toContain("ToolSearch")
    expect(toolNames).toContain("custom_lint")
  })
})

describe("auto-defer — threshold-based deferral via HTTP", () => {
  it("enables ENABLE_TOOL_SEARCH when tool count exceeds threshold", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "5"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    // 6 core tools + 4 generic = 10 tools, above threshold of 5
    const tools = [
      { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "edit", description: "Edit", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { name: "glob", description: "Glob", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
      { name: "grep", description: "Grep", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
      ...makeTools(4),
    ]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: false, tools, messages: [{ role: "user", content: "hi" }] })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("true")
  })

  it("does not enable ENABLE_TOOL_SEARCH when tool count is at or below threshold", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "10"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    // 6 tools, below threshold of 10
    const tools = [
      { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "write", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "edit", description: "Edit", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "bash", description: "Bash", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
      { name: "glob", description: "Glob", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
      { name: "grep", description: "Grep", input_schema: { type: "object", properties: { pat: { type: "string" } } } },
    ]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: false, tools, messages: [{ role: "user", content: "hi" }] })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  it("sets maxTurns to 3 when deferred tools are present", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    expect(capturedQueryParams.options.maxTurns).toBe(3)
  })

  it("sets maxTurns to 3 when no deferred tools (passthrough base budget)", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL],
        messages: [{ role: "user", content: "Read a file" }],
      })),
    }))

    expect(capturedQueryParams.options.maxTurns).toBe(3)
  })

  it("disables auto-defer when threshold is 0", async () => {
    process.env.MERIDIAN_DEFER_TOOL_THRESHOLD = "0"
    mockMessages = [assistantMessage([{ type: "text", text: "Hello" }])]

    // 20 tools, but threshold is 0 (disabled)
    const tools = [
      ...makeTools(20),
    ]

    await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: false, tools, messages: [{ role: "user", content: "hi" }] })),
    }))

    expect(capturedQueryParams.options.env.ENABLE_TOOL_SEARCH).toBe("false")
  })
})

describe("deferred tool loading — ToolSearch exempted from PreToolUse block", () => {
  it("does not include ToolSearch in captured tool uses", async () => {
    // Simulate SDK calling ToolSearch (not blocked) then the actual tool (blocked)
    const PREFIX = "mcp__oc__"
    mockMessages = [assistantMessage([
      { type: "tool_use", id: "tu_search_003", name: "ToolSearch", input: { query: "custom_lint" } },
      { type: "tool_use", id: "tu_lint_003", name: `${PREFIX}custom_lint`, input: { file: "/tmp/app.ts" } },
    ])]

    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({
        stream: false,
        tools: [ALWAYS_LOADED_TOOL, DEFERRED_TOOL],
        messages: [{ role: "user", content: "Lint my code" }],
      })),
    }))

    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>

    // ToolSearch should not appear in response (filtered + not captured by PreToolUse)
    const toolNames = content.filter((b) => b.type === "tool_use").map((b) => b.name)
    expect(toolNames).not.toContain("ToolSearch")

    // The actual tool should be captured and forwarded
    expect(toolNames).toContain("custom_lint")
    expect(body.stop_reason).toBe("tool_use")
  })
})
