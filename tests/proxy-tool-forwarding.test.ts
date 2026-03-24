/**
 * Phase 1: Tool Use Forwarding Tests
 *
 * The proxy must forward ALL content blocks (including tool_use) to the client.
 * Previously, tool_use blocks were filtered out, breaking subagent workflows.
 *
 * These tests verify:
 * 1. Streaming: tool_use events are forwarded, not filtered
 * 2. Non-streaming: tool_use blocks are included in the response
 * 3. Mixed content (text + tool_use) is preserved
 * 4. stop_reason is preserved from the original response (not always forced to end_turn)
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  assistantMessage,
  blockStop,
  type TestFetchApp as FetchApp,
  inputJsonDelta,
  makeRequest,
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

/** Non-streaming /messages JSON body shapes used in these tests */
type MessagesJsonBody = {
  content: Array<{
    type: string;
    text?: string;
    name?: string;
    id?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
};

type ServiceInfoBody = {
  service?: string;
  version?: string;
};

// --- Mock the Claude SDK ---
let mockMessages: SDKMessage[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      for (const msg of mockMessages) {
        yield msg;
      }
    })();
  },
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: {},
  }),
}));

// Mock the logger to avoid noise
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

// Mock mcpTools
mock.module("@/providers/claude/mcp-tools", () => ({
  createOpencodeMcpServer: () => ({
    type: "sdk",
    name: "opencode",
    instance: {},
  }),
}));

// Import AFTER mocking
const { createProxyServer } = await import("../src/proxy");

function createTestApp() {
  const { app } = createProxyServer();
  return app;
}

async function postMessages(
  app: FetchApp,
  body: Record<string, unknown>,
  endpoint = "/v1/messages",
) {
  const req = new Request(`http://localhost${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

async function readStreamFull(response: Response): Promise<string> {
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
  return result;
}

// ============================================================
// STREAMING TESTS
// ============================================================

describe("Phase 1: Streaming - tool_use forwarding", () => {
  beforeEach(() => {
    mockMessages = [];
  });

  it("should forward tool_use content blocks in streaming responses", async () => {
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, "Read", "toolu_test123"),
      inputJsonDelta(0, '{"file_path":'),
      inputJsonDelta(0, '"test.ts"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: true }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await readStreamFull(response);
    const events = parseSSE(text);

    // Must contain content_block_start with tool_use type
    const blockStartEvents = events.filter(
      (e) => e.event === "content_block_start",
    );
    expect(blockStartEvents.length).toBeGreaterThanOrEqual(1);

    const toolUseStart = blockStartEvents.find(
      (e) => sseContentBlock(e.data)?.type === "tool_use",
    );
    expect(toolUseStart).toBeDefined();
    expect(sseContentBlock(toolUseStart?.data)?.name).toBe("Read");
    expect(sseContentBlock(toolUseStart?.data)?.id).toBe("toolu_test123");

    // Must contain input_json_delta events
    const deltaEvents = events.filter((e) => e.event === "content_block_delta");
    const jsonDeltas = deltaEvents.filter(
      (e) => sseDelta(e.data)?.type === "input_json_delta",
    );
    expect(jsonDeltas.length).toBe(2);
  });

  it("should forward mixed text + tool_use content blocks", async () => {
    mockMessages = [
      messageStart(),
      // Text block first
      textBlockStart(0),
      textDelta(0, "Let me read that file."),
      blockStop(0),
      // Then tool_use block
      toolUseBlockStart(1, "Read", "toolu_mixed"),
      inputJsonDelta(1, '{"file_path":"main.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: true }));
    const text = await readStreamFull(response);
    const events = parseSSE(text);

    // Should have both text and tool_use content blocks
    const blockStarts = events.filter((e) => e.event === "content_block_start");
    const types = blockStarts.map((e) => sseContentBlock(e.data)?.type);
    expect(types).toContain("text");
    expect(types).toContain("tool_use");

    // Should have text_delta events
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        sseDelta(e.data)?.type === "text_delta",
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    // Should have input_json_delta events
    const jsonDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        sseDelta(e.data)?.type === "input_json_delta",
    );
    expect(jsonDeltas.length).toBeGreaterThanOrEqual(1);
  });

  it("should preserve stop_reason from the original response", async () => {
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, "Bash", "toolu_bash"),
      inputJsonDelta(0, '{"command":"ls"}'),
      blockStop(0),
      messageDelta("tool_use"), // stop_reason should be tool_use, not end_turn
      messageStop(),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: true }));
    const text = await readStreamFull(response);
    const events = parseSSE(text);

    const deltaEvent = events.find((e) => e.event === "message_delta");
    expect(deltaEvent).toBeDefined();
    expect(sseDelta(deltaEvent?.data)?.stop_reason).toBe("tool_use");
  });

  it("should forward text-only responses unchanged", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hello! "),
      textDelta(0, "How can I help?"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: true }));
    const text = await readStreamFull(response);
    const events = parseSSE(text);

    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        sseDelta(e.data)?.type === "text_delta",
    );
    expect(textDeltas.length).toBe(2);
    expect(sseDelta(textDeltas[0]?.data)?.text).toBe("Hello! ");
    expect(sseDelta(textDeltas[1]?.data)?.text).toBe("How can I help?");

    const deltaEvent = events.find((e) => e.event === "message_delta");
    expect(sseDelta(deltaEvent?.data)?.stop_reason).toBe("end_turn");
  });
});

// ============================================================
// NON-STREAMING TESTS
// ============================================================

describe("Phase 1: Non-streaming - tool_use forwarding", () => {
  beforeEach(() => {
    mockMessages = [];
  });

  it("should include tool_use blocks in non-streaming response", async () => {
    mockMessages = [
      assistantMessage([
        { type: "text", text: "Let me read that." },
        {
          type: "tool_use",
          id: "toolu_ns1",
          name: "Read",
          input: { file_path: "test.ts" },
        },
      ]),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: false }));
    const body = (await response.json()) as MessagesJsonBody;

    expect(body.content).toBeArray();
    expect(body.content.length).toBe(2);
    expect(body.content[0]?.type).toBe("text");
    expect(body.content[0]?.text).toBe("Let me read that.");
    expect(body.content[1]?.type).toBe("tool_use");
    expect(body.content[1]?.name).toBe("Read");
    expect(body.content[1]?.id).toBe("toolu_ns1");
    expect(body.content[1]?.input).toEqual({ file_path: "test.ts" });
  });

  it("should return tool_use-only responses without fallback text", async () => {
    mockMessages = [
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_ns2",
          name: "Bash",
          input: { command: "ls" },
        },
      ]),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: false }));
    const body = (await response.json()) as MessagesJsonBody;

    // Should NOT add fallback text — just return the tool_use block
    expect(body.content.length).toBe(1);
    expect(body.content[0]?.type).toBe("tool_use");
    expect(body.content[0]?.name).toBe("Bash");
  });

  it("should set stop_reason to tool_use when response contains tool_use blocks", async () => {
    mockMessages = [
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_ns3",
          name: "Read",
          input: { file_path: "x.ts" },
        },
      ]),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: false }));
    const body = (await response.json()) as MessagesJsonBody;

    expect(body.stop_reason).toBe("tool_use");
  });

  it("should set stop_reason to end_turn for text-only responses", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Here's the answer." }]),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: false }));
    const body = (await response.json()) as MessagesJsonBody;

    expect(body.stop_reason).toBe("end_turn");
  });
});

// ============================================================
// HEALTH/BASIC TESTS
// ============================================================

describe("Proxy basics", () => {
  it("should return service info on GET /", async () => {
    const app = createTestApp();
    const req = new Request("http://localhost/", { method: "GET" });
    const response = await app.fetch(req);
    const body = (await response.json()) as ServiceInfoBody;

    expect(body.service).toBe("opencode-claude-max-proxy");
    expect(body.version).toBeDefined();
  });

  it("should accept requests on both /v1/messages and /messages", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "test"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ];

    const app = createTestApp();

    const r1 = await postMessages(
      app,
      makeRequest({ stream: true }),
      "/v1/messages",
    );
    expect(r1.status).toBe(200);
    await readStreamFull(r1); // consume

    const r2 = await postMessages(
      app,
      makeRequest({ stream: true }),
      "/messages",
    );
    expect(r2.status).toBe(200);
    await readStreamFull(r2); // consume
  });
});
