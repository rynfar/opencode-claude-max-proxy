/**
 * Phase 3: Subagent and Multi-turn Support Tests
 *
 * Tests for:
 * 1. Concurrent requests (subagents must not be blocked by parent)
 * 2. Error recovery (Claude should be able to retry after tool errors)
 * 3. tool_result messages properly converted in follow-up requests
 * 4. Multiple tool calls in a single response
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

function sseContentBlock(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const b = data.content_block;
  return b && typeof b === "object" && !Array.isArray(b)
    ? (b as Record<string, unknown>)
    : undefined;
}

// --- Capture SDK calls ---
let mockMessages: SDKMessage[] = [];
let capturedQueryParams: Record<string, unknown> | null = null;
let _queryCallCount = 0;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: Record<string, unknown>) => {
    capturedQueryParams = params;
    _queryCallCount++;
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

async function postMessages(app: FetchApp, body: Record<string, unknown>) {
  const req = new Request("http://localhost/v1/messages", {
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
// CONCURRENT REQUESTS
// ============================================================

describe("Phase 3: Concurrent request support", () => {
  beforeEach(() => {
    mockMessages = [];
    capturedQueryParams = null;
    _queryCallCount = 0;
  });

  it("should handle concurrent streaming requests without blocking", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Response"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ];

    const app = createTestApp();

    // Fire two requests simultaneously (like OpenCode does with main + title gen)
    const [r1, r2] = await Promise.all([
      postMessages(app, makeRequest({ stream: true })),
      postMessages(app, makeRequest({ stream: true })),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Both should complete (not block each other)
    const [text1, text2] = await Promise.all([
      readStreamFull(r1),
      readStreamFull(r2),
    ]);

    expect(text1).toContain("Response");
    expect(text2).toContain("Response");
  });

  it("should handle concurrent non-streaming requests", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "OK" }])];

    const app = createTestApp();

    const [r1, r2] = await Promise.all([
      postMessages(app, makeRequest({ stream: false })),
      postMessages(app, makeRequest({ stream: false })),
    ]);

    type NonStreamBody = { content: Array<{ text?: string }> };
    const [b1, b2] = await Promise.all([
      r1.json() as Promise<NonStreamBody>,
      r2.json() as Promise<NonStreamBody>,
    ]);

    expect(b1.content[0]?.text).toBe("OK");
    expect(b2.content[0]?.text).toBe("OK");
  });
});

// ============================================================
// TOOL RESULT HANDLING
// ============================================================

describe("Phase 3: Tool result in follow-up requests", () => {
  beforeEach(() => {
    mockMessages = [];
    capturedQueryParams = null;
    _queryCallCount = 0;
  });

  it("should include tool_use blocks from assistant messages in prompt", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Here are the contents." }]),
    ];

    const app = createTestApp();
    const response = await postMessages(
      app,
      makeRequest({
        stream: false,
        messages: [
          { role: "user", content: "Read test.ts" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Read",
                input: { file_path: "test.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "console.log('hello')",
              },
            ],
          },
        ],
      }),
    );
    await response.json();

    const prompt = String(capturedQueryParams?.prompt ?? "");
    // Should contain the tool use context
    expect(prompt).toContain("Read");
    expect(prompt).toContain("test.ts");
    // Should contain the tool result
    expect(prompt).toContain("console.log('hello')");
  });

  it("should handle multiple tool results in a single message", async () => {
    mockMessages = [
      assistantMessage([{ type: "text", text: "Both files read." }]),
    ];

    const app = createTestApp();
    const response = await postMessages(
      app,
      makeRequest({
        stream: false,
        messages: [
          { role: "user", content: "Read both files" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_a",
                name: "Read",
                input: { file_path: "a.ts" },
              },
              {
                type: "tool_use",
                id: "toolu_b",
                name: "Read",
                input: { file_path: "b.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_a",
                content: "file a contents",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_b",
                content: "file b contents",
              },
            ],
          },
        ],
      }),
    );
    await response.json();

    const prompt = String(capturedQueryParams?.prompt ?? "");
    expect(prompt).toContain("file a contents");
    expect(prompt).toContain("file b contents");
  });

  it("should handle error tool results", async () => {
    mockMessages = [
      assistantMessage([
        { type: "text", text: "I see the error, let me try differently." },
      ]),
    ];

    const app = createTestApp();
    const response = await postMessages(
      app,
      makeRequest({
        stream: false,
        messages: [
          { role: "user", content: "Do something" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_err",
                name: "Task",
                input: { agent_type: "general-purpose", prompt: "read file" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_err",
                content:
                  "Error: Unknown agent type: general-purpose is not a valid agent type",
                is_error: true,
              },
            ],
          },
        ],
      }),
    );
    await response.json();

    const prompt = String(capturedQueryParams?.prompt ?? "");
    expect(prompt).toContain("Unknown agent type");
    expect(prompt).toContain("general-purpose");
  });
});

// ============================================================
// MULTIPLE TOOL CALLS IN SINGLE RESPONSE
// ============================================================

describe("Phase 3: Multiple tool calls in response", () => {
  beforeEach(() => {
    mockMessages = [];
    capturedQueryParams = null;
  });

  it("should forward multiple tool_use blocks in streaming", async () => {
    mockMessages = [
      messageStart(),
      // First tool call
      toolUseBlockStart(0, "Read", "toolu_r1"),
      inputJsonDelta(0, '{"file_path":"a.ts"}'),
      blockStop(0),
      // Second tool call
      toolUseBlockStart(1, "Read", "toolu_r2"),
      inputJsonDelta(1, '{"file_path":"b.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: true }));
    const text = await readStreamFull(response);
    const events = parseSSE(text);

    const blockStarts = events.filter((e) => e.event === "content_block_start");
    const toolStarts = blockStarts.filter(
      (e) => sseContentBlock(e.data)?.type === "tool_use",
    );
    expect(toolStarts.length).toBe(2);
    expect(sseContentBlock(toolStarts[0]?.data)?.name).toBe("Read");
    expect(sseContentBlock(toolStarts[1]?.data)?.name).toBe("Read");
  });

  it("should include multiple tool_use blocks in non-streaming", async () => {
    mockMessages = [
      assistantMessage([
        {
          type: "tool_use",
          id: "toolu_m1",
          name: "Read",
          input: { file_path: "a.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_m2",
          name: "Bash",
          input: { command: "ls" },
        },
      ]),
    ];

    const app = createTestApp();
    const response = await postMessages(app, makeRequest({ stream: false }));
    const body = (await response.json()) as {
      content: Array<{ type: string; name?: string }>;
      stop_reason?: string;
    };

    expect(body.content.length).toBe(2);
    expect(body.content[0]?.type).toBe("tool_use");
    expect(body.content[0]?.name).toBe("Read");
    expect(body.content[1]?.type).toBe("tool_use");
    expect(body.content[1]?.name).toBe("Bash");
    expect(body.stop_reason).toBe("tool_use");
  });
});
