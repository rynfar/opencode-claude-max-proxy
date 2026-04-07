/**
 * Passthrough mode: thinking-block filtering and Turn 2 suppression.
 *
 * Two bugs caused Claude edits via passthrough to show prose instead of
 * diff UI in OpenCode:
 *
 * Bug 1 — Non-streaming Turn 2 contamination:
 *   The SDK needs maxTurns:2 in passthrough mode to avoid crashing. But Turn 2
 *   runs after the blocked tool call completes, and Claude generates a prose
 *   summary ("The edit has been forwarded to your local environment...").
 *   Meridian was returning both Turn 1 (tool_use) + Turn 2 (thinking + prose)
 *   in one response, which confused OpenCode's diff renderer.
 *   Fix: once Turn 1 has produced tool_use blocks, ignore all content from
 *   subsequent assistant turns.
 *
 * Bug 2 — Thinking blocks forwarded to non-native clients (both modes):
 *   type:"thinking" / type:"redacted_thinking" blocks contain an encrypted
 *   signature that is only valid in Claude's native context. Some clients
 *   have no renderer for them and can misinterpret them.
 *   Fix: strip thinking/redacted_thinking blocks in passthrough mode UNLESS
 *   the adapter's supportsThinking() returns true (e.g. OpenCode).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
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
} from "./helpers"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"

// ─── OpenCode edit tool definition (real schema from OpenCode) ───────────────
const EDIT_TOOL = {
  name: "edit",
  description: "Edit a file by replacing oldString with newString",
  input_schema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      oldString: { type: "string" },
      newString: { type: "string" },
    },
    required: ["filePath", "oldString", "newString"],
  },
}

// ─── SDK mock ────────────────────────────────────────────────────────────────
let mockMessages: SDKMessage[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      for (const msg of mockMessages) yield msg
    })(),
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

function passthroughRequest(stream: boolean, extra: Record<string, unknown> = {}) {
  return makeRequest({
    stream,
    tools: [EDIT_TOOL],
    messages: [{ role: "user", content: "Edit /tmp/hello.ts" }],
    ...extra,
  })
}

/** POST a request in passthrough mode (sets MERIDIAN_PASSTHROUGH for the call) */
async function fetchPassthrough(stream: boolean, extra: Record<string, unknown> = {}) {
  const prev = process.env.MERIDIAN_PASSTHROUGH
  process.env.MERIDIAN_PASSTHROUGH = "1"
  try {
    return await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(passthroughRequest(stream, extra)),
    }))
  } finally {
    if (prev === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = prev
  }
}

// SDK prefix for passthrough MCP tools
const PREFIX = "mcp__oc__"

// Helper: a complete tool_use block (streamed)
function streamedToolUse(index: number, toolId: string) {
  return [
    toolUseBlockStart(index, `${PREFIX}edit`, toolId),
    inputJsonDelta(index, `{"filePath":"/tmp/hello.ts","oldString":"foo","newString":"bar"}`),
    blockStop(index),
  ]
}

// Helper: a thinking content block (streamed)
function thinkingBlockStart(index: number): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  } as SDKMessage
}
function thinkingDelta(index: number, text: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: text },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  } as SDKMessage
}

beforeEach(() => {
  clearSessionCache()
  mockMessages = []
})

// ─────────────────────────────────────────────────────────────────────────────
// Non-streaming: Turn 2 suppression
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough non-streaming — Turn 2 suppression", () => {
  it("returns only Turn 1 tool_use blocks when Turn 2 adds prose", async () => {
    // Turn 1: tool_use for edit
    const turn1 = assistantMessage([
      { type: "tool_use", id: "tu_001", name: `${PREFIX}edit`,
        input: { filePath: "/tmp/hello.ts", oldString: "foo", newString: "bar" } },
    ])
    // Turn 2: thinking + prose summary (SDK artefact from blocked tool result)
    const turn2 = assistantMessage([
      { type: "thinking", thinking: "I edited the file", signature: "enc_sig_xyz" },
      { type: "text", text: "The edit has been forwarded to your local environment. The change was: foo → bar" },
    ])
    mockMessages = [turn1, turn2]

    const res = await fetchPassthrough(false)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    const content = body.content as Array<Record<string, unknown>>
    // Should have exactly the tool_use block — no thinking, no Turn 2 prose
    const types = content.map((b) => b.type)
    expect(types).toContain("tool_use")
    expect(types).not.toContain("thinking")
    expect(types).not.toContain("redacted_thinking")
    // The prose "The edit has been forwarded..." must NOT appear
    const textBlocks = content.filter((b) => b.type === "text")
    for (const tb of textBlocks) {
      expect(String(tb.text ?? "")).not.toContain("forwarded")
    }
    // stop_reason must be tool_use
    expect(body.stop_reason).toBe("tool_use")
  })

  it("does not suppress Turn 2 content when Turn 1 had no tool_use (end_turn flow)", async () => {
    // Turn 1: plain text only (Claude just replied without tools)
    const turn1 = assistantMessage([
      { type: "text", text: "I cannot edit that file without tools." },
    ])
    mockMessages = [turn1]

    const res = await fetchPassthrough(false)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>

    const content = body.content as Array<Record<string, unknown>>
    expect(content.some((b) => b.type === "text")).toBe(true)
    expect(body.stop_reason).toBe("end_turn")
  })

  it("forwards thinking blocks in Turn 1 for adapters that support thinking", async () => {
    // Turn 1: thinking + tool_use (Claude with extended thinking enabled)
    const turn1 = assistantMessage([
      { type: "thinking", thinking: "Let me plan the edit...", signature: "enc_sig_abc" },
      { type: "tool_use", id: "tu_002", name: `${PREFIX}edit`,
        input: { filePath: "/tmp/hello.ts", oldString: "foo", newString: "bar" } },
    ])
    mockMessages = [turn1]

    const res = await fetchPassthrough(false)
    const body = await res.json() as Record<string, unknown>

    const types = (body.content as Array<Record<string, unknown>>).map((b) => b.type)
    expect(types).toContain("tool_use")
    expect(types).toContain("thinking")
    expect(body.stop_reason).toBe("tool_use")
  })

  it("forwards redacted_thinking blocks for adapters that support thinking", async () => {
    const turn1 = assistantMessage([
      { type: "redacted_thinking", data: "redacted_data_xyz" },
      { type: "tool_use", id: "tu_003", name: `${PREFIX}edit`,
        input: { filePath: "/tmp/hello.ts", oldString: "foo", newString: "bar" } },
    ])
    mockMessages = [turn1]

    const res = await fetchPassthrough(false)
    const body = await res.json() as Record<string, unknown>

    const types = (body.content as Array<Record<string, unknown>>).map((b) => b.type)
    expect(types).toContain("redacted_thinking")
    expect(types).toContain("tool_use")
  })

  it("preserves tool_use input fields alongside forwarded thinking blocks", async () => {
    const turn1 = assistantMessage([
      { type: "thinking", thinking: "Planning...", signature: "enc_sig" },
      {
        type: "tool_use", id: "tu_004", name: `${PREFIX}edit`,
        input: { filePath: "/tmp/greet.ts", oldString: `"Hello " + name`, newString: "`Hello ${name}`" },
      },
    ])
    mockMessages = [turn1]

    const res = await fetchPassthrough(false)
    const body = await res.json() as Record<string, unknown>
    const content = body.content as Array<Record<string, unknown>>
    const tu = content.find((b) => b.type === "tool_use")

    expect(tu).toBeDefined()
    expect(tu!.name).toBe("edit")  // mcp__oc__ prefix stripped
    expect((tu!.input as Record<string, unknown>).filePath).toBe("/tmp/greet.ts")
    expect((tu!.input as Record<string, unknown>).oldString).toBe(`"Hello " + name`)
    expect((tu!.input as Record<string, unknown>).newString).toBe("`Hello ${name}`")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Streaming: thinking block filtering
// ─────────────────────────────────────────────────────────────────────────────

describe("passthrough streaming — thinking block filtering", () => {
  it("forwards thinking content_block_start and its deltas in the stream", async () => {
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "I should use the edit tool"),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "Preparing edit..."),
      blockStop(1),
      ...streamedToolUse(2, "tu_stream_001"),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    expect(res.status).toBe(200)
    const text = await res.text()
    const events = parseSSE(text)

    // Thinking blocks should be forwarded for adapters that support them
    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockTypes = blockStarts.map((e) => (e.data as any).content_block?.type)
    expect(blockTypes).toContain("thinking")

    // Thinking deltas should also be present
    const deltas = events.filter((e) => e.event === "content_block_delta")
    const hasThinkinDelta = deltas.some((d) => (d.data as any).delta?.type === "thinking_delta")
    expect(hasThinkinDelta).toBe(true)
  })

  it("forwards thinking and tool_use blocks with correct indices", async () => {
    // Thinking at SDK index 0, tool_use at SDK index 1
    // Both should be forwarded with their original indices
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "Plan the edit"),
      blockStop(0),
      ...streamedToolUse(1, "tu_stream_002"),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    const text = await res.text()
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    expect(blockStarts.length).toBe(2)  // thinking + tool_use (was 1)

    const thinkingStart = blockStarts.find((e) => (e.data as any).content_block?.type === "thinking")
    expect(thinkingStart).toBeDefined()
    expect((thinkingStart!.data as any).index).toBe(0)

    const tuStart = blockStarts.find((e) => (e.data as any).content_block?.type === "tool_use")
    expect(tuStart).toBeDefined()
    expect((tuStart!.data as any).content_block?.name).toBe("edit")  // prefix stripped
    expect((tuStart!.data as any).index).toBe(1)  // was 0 when thinking was stripped
  })

  it("tool_use input is complete and parseable after streaming", async () => {
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "Planning..."),
      blockStop(0),
      toolUseBlockStart(1, `${PREFIX}edit`, "tu_stream_003"),
      inputJsonDelta(1, '{"filePath":"/tmp/g.ts","oldString":"foo '),
      inputJsonDelta(1, 'bar","newString":"baz qux"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    const text = await res.text()
    const events = parseSSE(text)

    // Reconstruct the tool input from input_json_delta events
    const jsonDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "input_json_delta")
      .map((e) => (e.data as any).delta?.partial_json as string)
    const fullJson = jsonDeltas.join("")
    const input = JSON.parse(fullJson) as Record<string, unknown>

    expect(input.filePath).toBe("/tmp/g.ts")
    expect(input.oldString).toBe("foo bar")
    expect(input.newString).toBe("baz qux")
  })

  it("intercepts second message_start (Turn 2) and emits stop_reason:tool_use before Turn 2 content", async () => {
    // Simulates real SDK behaviour: tool names arrive WITHOUT the mcp__oc__ prefix
    // and the SDK delivers both turns in one stream, with Turn 2 starting after
    // a second message_start event.
    const turn2Start: SDKMessage = {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: "msg_turn2", type: "message", role: "assistant", content: [],
          model: "claude-sonnet-4-6", stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 0 } },
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: "test-session",
    } as unknown as SDKMessage

    mockMessages = [
      messageStart(),
      // Turn 1: text preamble + tool_use WITHOUT mcp__oc__ prefix (real SDK behaviour)
      textBlockStart(0),
      textDelta(0, "Sure, calling the edit tool:"),
      blockStop(0),
      // Note: no mcp__oc__ prefix — the real SDK strips it before stream_events
      toolUseBlockStart(1, "edit", "tu_real_001"),
      inputJsonDelta(1, '{"filePath":"/tmp/f.ts","oldString":"foo","newString":"bar"}'),
      blockStop(1),
      // Turn 2 begins — second message_start should trigger the break
      turn2Start,
      textBlockStart(0),
      textDelta(0, "The edit was forwarded to your local environment."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const res = await fetchPassthrough(true)
    const text = await res.text()
    const events = parseSSE(text)

    // Only Turn 1 content should be present
    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockTypes = blockStarts.map((e) => (e.data as any).content_block?.type)
    expect(blockTypes).toContain("tool_use")

    // Turn 2 prose must not be present
    const textDeltas = events
      .filter((e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta")
      .map((e) => (e.data as any).delta?.text as string)
    const allText = textDeltas.join("")
    expect(allText).not.toContain("forwarded to your local environment")

    // Stream must end with stop_reason:tool_use injected by the proxy
    const msgDeltas = events.filter((e) => e.event === "message_delta")
    expect(msgDeltas.length).toBeGreaterThan(0)
    const stopReason = (msgDeltas[msgDeltas.length - 1]!.data as any).delta?.stop_reason
    expect(stopReason).toBe("tool_use")

    // message_stop must follow
    expect(events.some((e) => e.event === "message_stop")).toBe(true)
  })

  it("does not strip thinking blocks in non-passthrough mode", async () => {
    // In normal (non-passthrough) mode, thinking blocks should pass through untouched
    mockMessages = [
      messageStart(),
      thinkingBlockStart(0),
      thinkingDelta(0, "Let me think..."),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, "Here is the answer"),
      blockStop(1),
      messageDelta("end_turn"),
      messageStop(),
    ]

    // No tools in this request = not passthrough mode
    const res = await app().fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(makeRequest({ stream: true })),
    }))
    const text = await res.text()
    const events = parseSSE(text)

    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const blockTypes = blockStarts.map((e) => (e.data as any).content_block?.type)
    // thinking should be forwarded in normal mode
    expect(blockTypes).toContain("thinking")
  })
})
