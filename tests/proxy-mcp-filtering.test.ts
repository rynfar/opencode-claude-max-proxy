/**
 * MCP Tool Filtering Tests
 *
 * MCP tools (mcp__opencode__*) are executed internally by the SDK.
 * Their tool_use events must NOT be forwarded to OpenCode.
 * Non-MCP tools (Task, delegate_task, etc.) MUST be forwarded.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  blockStop,
  inputJsonDelta,
  messageDelta,
  messageStart,
  messageStop,
  parseSSE,
  type TestFetchApp as TestApp,
  textBlockStart,
  textDelta,
  toolUseBlockStart,
} from "./helpers";

function contentBlockFromData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const raw = data.content_block;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function deltaFromData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const raw = data.delta;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return undefined;
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

function createTestApp() {
  const { app } = createProxyServer();
  return app;
}

async function postStream(app: TestApp, content: string) {
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

describe("MCP tool filtering: internal tools hidden from client", () => {
  beforeEach(() => {
    mockMessages = [];
  });

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
    ];

    const app = createTestApp();
    const events = await postStream(app, "read README.md");

    // Should NOT contain mcp__ tool blocks
    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        contentBlockFromData(e.data)?.type === "tool_use",
    );
    const mcpTools = toolStarts.filter((e) =>
      String(contentBlockFromData(e.data)?.name ?? "").startsWith("mcp__"),
    );
    expect(mcpTools.length).toBe(0);

    // Should contain the text result
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        deltaFromData(e.data)?.type === "text_delta",
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const firstTextDelta = textDeltas[0];
    expect(firstTextDelta).toBeDefined();
    if (firstTextDelta === undefined) {
      throw new Error("expected at least one text_delta event");
    }
    expect(deltaFromData(firstTextDelta.data)?.text).toBe(
      "The README says hello.",
    );
  });

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
    ];

    const app = createTestApp();
    const events = await postStream(app, "explore the codebase");

    // Should contain the Task tool block
    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        contentBlockFromData(e.data)?.type === "tool_use",
    );
    expect(toolStarts.length).toBe(1);
    expect(contentBlockFromData(toolStarts[0]?.data)?.name).toBe("Task");

    // Should also contain text
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        deltaFromData(e.data)?.type === "text_delta",
    );
    expect(textDeltas.length).toBe(1);
  });

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
    ];

    const app = createTestApp();
    const events = await postStream(app, "list files and explore");

    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        contentBlockFromData(e.data)?.type === "tool_use",
    );
    // Only task should be forwarded, not mcp__opencode__bash
    expect(toolStarts.length).toBe(1);
    expect(contentBlockFromData(toolStarts[0]?.data)?.name).toBe("task");
  });
});
