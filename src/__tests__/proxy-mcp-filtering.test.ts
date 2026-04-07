/**
 * MCP Tool Filtering Tests
 *
 * MCP tools (mcp__opencode__*) are executed internally by the SDK.
 * Their tool_use events must NOT be forwarded to OpenCode.
 * Non-MCP tools (Task, delegate_task, etc.) MUST be forwarded.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  toolUseBlockStart,
  textDelta,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
  streamEvent,
} from "./helpers"

let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
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

const { createProxyServer } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postStream(app: any, content: string) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content }],
    }),
  })
  const response = await app.fetch(req)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return parseSSE(result)
}

describe("MCP tool filtering: internal tools hidden from client", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = []
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("should filter out mcp__opencode__* tool_use blocks", async () => {
    mockMessages = [
      messageStart(),
      // MCP tool call (internal — should be hidden)
      toolUseBlockStart(0, "mcp__opencode__read", "toolu_mcp1"),
      inputJsonDelta(0, '{"path":"README.md"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
      // After SDK executes the tool internally, new message with text result
      messageStart(),
      textBlockStart(0),
      textDelta(0, "The README says hello."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const events = await postStream(app, "read README.md")

    // Should NOT contain mcp__ tool blocks
    const toolStarts = events.filter(
      (e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "tool_use"
    )
    const mcpTools = toolStarts.filter(
      (e) => (e.data as any).content_block?.name?.startsWith("mcp__")
    )
    expect(mcpTools.length).toBe(0)

    // Should contain the text result
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)
    expect((textDeltas[0]?.data as any).delta.text).toBe("The README says hello.")
  })

  it("should forward non-MCP tool_use blocks (like Task)", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "I'll delegate this."),
      blockStop(0),
      // Task tool call (OpenCode handles this — should be forwarded)
      toolUseBlockStart(1, "Task", "toolu_task1"),
      inputJsonDelta(1, '{"subagent_type":"explore","prompt":"find files"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const app = createTestApp()
    const events = await postStream(app, "explore the codebase")

    // Should contain the Task tool block
    const toolStarts = events.filter(
      (e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "tool_use"
    )
    expect(toolStarts.length).toBe(1)
    expect((toolStarts[0]?.data as any).content_block.name).toBe("Task")

    // Should also contain text
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    expect(textDeltas.length).toBe(1)
  })

  it("should filter MCP tools but forward Task in mixed response", async () => {
    mockMessages = [
      messageStart(),
      // MCP tool (hidden)
      toolUseBlockStart(0, "mcp__opencode__bash", "toolu_mcp_bash"),
      inputJsonDelta(0, '{"command":"ls"}'),
      blockStop(0),
      // Task tool (forwarded)  
      toolUseBlockStart(1, "task", "toolu_task2"),
      inputJsonDelta(1, '{"subagent_type":"explore","prompt":"search"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const app = createTestApp()
    const events = await postStream(app, "list files and explore")

    const toolStarts = events.filter(
      (e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "tool_use"
    )
    // Only task should be forwarded, not mcp__opencode__bash
    expect(toolStarts.length).toBe(1)
    expect((toolStarts[0]?.data as any).content_block.name).toBe("task")
  })
})
