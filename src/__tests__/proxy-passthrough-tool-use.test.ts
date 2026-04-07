/**
 * Passthrough Mode: tool_use Bug Fixes
 *
 * Regression tests for two bugs that broke tool_use flows in passthrough mode:
 *
 * Bug 1 (non-streaming): maxTurns:1 caused HTTP 500 on multi-turn tool flows.
 *   The SDK needs a second internal turn to process the blocked-tool handoff
 *   before returning. Fixed by raising maxTurns to 2.
 *
 * Bug 2 (streaming): After the model emitted message_delta(stop_reason:tool_use),
 *   the SDK continued by executing the passthrough MCP no-op (→ "passthrough"),
 *   feeding that back to the model, and the model produced a junk fallback response
 *   which got forwarded to the client. Fixed by breaking the stream loop immediately
 *   on tool_use stop in passthrough mode.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  toolUseBlockStart,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  textDelta,
  parseSSE,
  assistantMessage,
  makeRequest,
  READ_TOOL,
} from "./helpers"

// --- Mock the Claude SDK ---
let mockMessages: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const msg of mockMessages) yield msg
    })(),
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    // Provide a minimal instance that supports tool() registration
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

// Prefix the SDK uses for passthrough MCP tools
const PASSTHROUGH_PREFIX = "mcp__oc__"

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postStream(app: any, tools: any[] = [READ_TOOL]): Promise<string> {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      makeRequest({
        stream: true,
        tools,
        messages: [{ role: "user", content: "Read the file /tmp/test.txt" }],
      })
    ),
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
  return result
}

async function postNonStream(app: any, tools: any[] = [READ_TOOL]): Promise<Response> {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      makeRequest({
        stream: false,
        tools,
        messages: [{ role: "user", content: "Read the file /tmp/test.txt" }],
      })
    ),
  })
  return app.fetch(req)
}

// ============================================================
// Bug 2: Streaming — early termination on tool_use stop
// ============================================================

describe("Passthrough streaming: early termination on tool_use stop", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    mockMessages = []
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.MERIDIAN_PASSTHROUGH = origEnv
    } else {
      delete process.env.MERIDIAN_PASSTHROUGH
    }
  })

  it("stream ends with message_stop immediately after message_delta(stop_reason:tool_use)", async () => {
    // Simulate: model streams a passthrough tool_use, then the SDK would
    // normally continue (turn 2) — but we should break before that happens.
    mockMessages = [
      messageStart(),
      // Passthrough MCP tool block (mcp__oc__ prefix) — should be stripped and forwarded
      toolUseBlockStart(0, `${PASSTHROUGH_PREFIX}Read`, "toolu_read1"),
      inputJsonDelta(0, '{"file_path":"/tmp/test.txt"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
      // Turn 2 — SDK would normally continue here after executing the MCP no-op.
      // With the fix, we should never reach these events.
      messageStart("msg_turn2"),
      textBlockStart(0),
      textDelta(0, "I was unable to read the file as the tool returned 'passthrough'."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const raw = await postStream(app)
    const events = parseSSE(raw)

    // The stream must end with message_stop
    const lastEvent = events[events.length - 1]
    expect(lastEvent?.event).toBe("message_stop")

    // The tool_use block should be forwarded with the prefix stripped
    const toolStarts = events.filter(
      (e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "tool_use"
    )
    expect(toolStarts.length).toBe(1)
    expect((toolStarts[0]?.data as any).content_block.name).toBe("Read")

    // No text from turn 2 should appear after the tool_use stop
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    expect(textDeltas.length).toBe(0)

    // The message_delta with stop_reason:tool_use must be forwarded before message_stop
    const toolUseDelta = events.find(
      (e) => e.event === "message_delta" && (e.data as any).delta?.stop_reason === "tool_use"
    )
    expect(toolUseDelta).toBeDefined()
  })

  it("stream ends with message_stop after multiple passthrough tool_use blocks", async () => {
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, `${PASSTHROUGH_PREFIX}Read`, "toolu_1"),
      inputJsonDelta(0, '{"file_path":"/tmp/a.txt"}'),
      blockStop(0),
      toolUseBlockStart(1, `${PASSTHROUGH_PREFIX}Bash`, "toolu_2"),
      inputJsonDelta(1, '{"command":"ls -la"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
      // Turn 2 junk — should never be forwarded
      messageStart("msg_turn2"),
      textBlockStart(0),
      textDelta(0, "The tools returned passthrough, I cannot continue."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const raw = await postStream(app, [READ_TOOL, { name: "Bash", description: "Run bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }])
    const events = parseSSE(raw)

    // Two tool_use blocks forwarded (prefix stripped)
    const toolStarts = events.filter(
      (e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "tool_use"
    )
    expect(toolStarts.length).toBe(2)
    expect((toolStarts[0]?.data as any).content_block.name).toBe("Read")
    expect((toolStarts[1]?.data as any).content_block.name).toBe("Bash")

    // Stream ends cleanly
    const lastEvent = events[events.length - 1]
    expect(lastEvent?.event).toBe("message_stop")

    // No turn-2 text
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    expect(textDeltas.length).toBe(0)
  })

  it("does NOT terminate early when stop_reason is end_turn (no tool_use)", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "I can help with that."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const raw = await postStream(app)
    const events = parseSSE(raw)

    // Normal end_turn stream — text should be present
    const textDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    expect(textDeltas.length).toBeGreaterThan(0)
    expect((textDeltas[0]?.data as any).delta.text).toBe("I can help with that.")

    const lastEvent = events[events.length - 1]
    expect(lastEvent?.event).toBe("message_stop")
  })
})

// ============================================================
// Bug 1: Non-streaming — maxTurns fix (no HTTP 500)
// ============================================================

describe("Passthrough non-streaming: tool_use returned without HTTP 500", () => {
  let origEnv: string | undefined

  beforeEach(() => {
    mockMessages = []
    origEnv = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    clearSessionCache()
  })

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.MERIDIAN_PASSTHROUGH = origEnv
    } else {
      delete process.env.MERIDIAN_PASSTHROUGH
    }
  })

  it("returns 200 with tool_use stop_reason when model calls a passthrough tool", async () => {
    // The SDK (with maxTurns:2) completes successfully.
    // The assistant message contains a tool_use block.
    mockMessages = [
      assistantMessage([
        { type: "text", text: "Let me read that file." },
        { type: "tool_use", id: "toolu_read1", name: `${PASSTHROUGH_PREFIX}Read`, input: { file_path: "/tmp/test.txt" } },
      ]),
    ]

    const app = createTestApp()
    const response = await postNonStream(app)
    expect(response.status).toBe(200)

    const body = await response.json() as any
    expect(body.type).toBe("message")
    expect(body.stop_reason).toBe("tool_use")

    // Tool name should have the prefix stripped
    const toolBlock = body.content.find((b: any) => b.type === "tool_use")
    expect(toolBlock).toBeDefined()
    expect(toolBlock.name).toBe("Read")
    expect(toolBlock.id).toBe("toolu_read1")
  })

  it("returns 200 with end_turn when model responds with text only", async () => {
    mockMessages = [
      assistantMessage([
        { type: "text", text: "I cannot access that file directly." },
      ]),
    ]

    const app = createTestApp()
    const response = await postNonStream(app)
    expect(response.status).toBe(200)

    const body = await response.json() as any
    expect(body.stop_reason).toBe("end_turn")
    const textBlock = body.content.find((b: any) => b.type === "text")
    expect(textBlock?.text).toContain("I cannot access that file directly.")
  })
})
