/**
 * Streaming Message Tests
 *
 * When the SDK runs multiple turns (MCP tool calls), the stream contains
 * multiple message_start/message_stop pairs. The Anthropic API spec
 * expects exactly ONE message per response.
 *
 * The proxy should:
 * 1. Only emit events from the FINAL message (the one with actual content for the client)
 * 2. Skip intermediate messages that are just MCP tool calls
 * 3. Emit exactly one message_start and one message_stop
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  blockStop,
  type TestFetchApp as FetchApp,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  parseSSE,
  textBlockStart,
  textDelta,
  toolUseBlockStart,
} from "./helpers";

function sseDelta(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const d = data.delta;
  return d && typeof d === "object" && !Array.isArray(d)
    ? (d as Record<string, unknown>)
    : undefined;
}

function sseContentBlock(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const b = data.content_block;
  return b && typeof b === "object" && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : undefined;
}

let mockMessages: SDKMessage[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      for (const msg of mockMessages) yield msg;
    })();
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}));

mock.module("@/logger", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
    start: () => {},
    success: () => {},
  },
}));

mock.module("@/providers/claude/mcp-tools", () => ({
  createOpencodeMcpServer: () => ({
    type: "sdk",
    name: "opencode",
    instance: {},
  }),
}));

const { createProxyServer } = await import("../src/proxy");
const { clearSessionCache } = await import("../src/proxy/session");

function createTestApp() {
  const { app } = createProxyServer();
  return app;
}

async function postStream(app: FetchApp, content: string) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content }],
    }),
  });
  const response = await app.fetch(req);
  if (!response.body) {
    throw new Error("Expected streaming response body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return parseSSE(result);
}

describe("Streaming: single message per response", () => {
  beforeEach(() => {
    mockMessages = [];
    clearSessionCache();
  });

  it("should emit exactly one message_start for multi-turn SDK responses", async () => {
    // Simulate SDK doing: turn 1 (text + MCP tool) → turn 2 (final text)
    mockMessages = [
      // Turn 1: text + MCP tool_use (filtered)
      messageStart("msg_turn1"),
      textBlockStart(0),
      textDelta(0, "Let me check."),
      blockStop(0),
      toolUseBlockStart(1, "mcp__opencode__read", "toolu_mcp1"),
      inputJsonDelta(1, '{"path":"README.md"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
      // Turn 2: final text response
      messageStart("msg_turn2"),
      textBlockStart(0),
      textDelta(0, "The README says hello."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ];

    const app = createTestApp();
    const events = await postStream(app, "read README");

    // Should have exactly ONE message_start
    const msgStarts = events.filter((e) => e.event === "message_start");
    expect(msgStarts.length).toBe(1);

    // Should have exactly ONE message_stop
    const msgStops = events.filter((e) => e.event === "message_stop");
    expect(msgStops.length).toBe(1);

    // The text should be the final response only
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        sseDelta(e.data)?.type === "text_delta",
    );
    const fullText = textDeltas
      .map((e) => String(sseDelta(e.data)?.text ?? ""))
      .join("");
    expect(fullText).toContain("The README says hello.");
  });

  it("should include intermediate text from tool-calling turns", async () => {
    // Turn 1 has useful text ("Let me check") before the tool call
    // This text should be included in the response too
    mockMessages = [
      messageStart("msg_turn1"),
      textBlockStart(0),
      textDelta(0, "Let me check that file. "),
      blockStop(0),
      toolUseBlockStart(1, "mcp__opencode__read", "toolu_mcp2"),
      inputJsonDelta(1, '{"path":"file.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
      // Turn 2: final response
      messageStart("msg_turn2"),
      textBlockStart(0),
      textDelta(0, "Here's what I found."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ];

    const app = createTestApp();
    const events = await postStream(app, "read file.ts");

    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        sseDelta(e.data)?.type === "text_delta",
    );
    const fullText = textDeltas
      .map((e) => String(sseDelta(e.data)?.text ?? ""))
      .join("");

    // Both turns' text should be present
    expect(fullText).toContain("Let me check that file.");
    expect(fullText).toContain("Here's what I found.");
  });

  it("should forward single-turn responses unchanged", async () => {
    mockMessages = [
      messageStart("msg_single"),
      textBlockStart(0),
      textDelta(0, "Hello!"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ];

    const app = createTestApp();
    const events = await postStream(app, "hello");

    const msgStarts = events.filter((e) => e.event === "message_start");
    expect(msgStarts.length).toBe(1);

    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        sseDelta(e.data)?.type === "text_delta",
    );
    expect(textDeltas.length).toBe(1);
    expect(sseDelta(textDeltas[0]?.data)?.text).toBe("Hello!");
  });

  it("should forward non-MCP tool_use even in multi-turn", async () => {
    // Turn 1: MCP tool (hidden) + Task tool (forwarded)
    mockMessages = [
      messageStart("msg_t1"),
      toolUseBlockStart(0, "mcp__opencode__glob", "toolu_glob"),
      inputJsonDelta(0, '{"pattern":"*.ts"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
      // Turn 2: text + Task (forwarded to OpenCode)
      messageStart("msg_t2"),
      textBlockStart(0),
      textDelta(0, "Found files. Delegating."),
      blockStop(0),
      toolUseBlockStart(1, "task", "toolu_task"),
      inputJsonDelta(1, '{"subagent_type":"explore","prompt":"analyze"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const app = createTestApp();
    const events = await postStream(app, "explore the project");

    // Task tool should be forwarded
    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        sseContentBlock(e.data)?.type === "tool_use",
    );
    expect(toolStarts.length).toBe(1);
    expect(sseContentBlock(toolStarts[0]?.data)?.name).toBe("task");
  });
});
