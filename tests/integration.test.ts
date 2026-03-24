/**
 * Integration Tests — Real HTTP requests against the proxy
 *
 * These tests start the actual proxy server and send real HTTP requests
 * to verify the full request/response cycle works correctly.
 *
 * Note: These do NOT hit the real Claude API — they still mock the SDK.
 * But they test the full Hono HTTP stack, SSE parsing, etc.
 */

import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  assistantMessage,
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

interface ApiResponse {
  stop_reason: string;
  content: Array<{ type: string; text?: string; name?: string; id?: string }>;
  [key: string]: unknown;
}

interface SseEventData {
  delta?: { type?: string; text?: string; stop_reason?: string };
  content_block?: { type: string; name?: string };
  [key: string]: unknown;
}

// --- Mock SDK ---
let mockMessages: Record<string, unknown>[] = [];
let capturedQueryParams: Record<string, unknown> | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: Record<string, unknown>) => {
    capturedQueryParams = params;
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

// Use Hono's built-in test client
function createTestApp() {
  const { app } = createProxyServer();
  return app;
}

async function post(app: TestApp, body: Record<string, unknown>) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dummy" },
      body: JSON.stringify(body),
    }),
  );
}

async function readStream(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
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
// FULL TOOL LOOP SIMULATION
// ============================================================

describe("Integration: Full Anthropic API tool loop", () => {
  let app: TestApp;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    mockMessages = [];
    capturedQueryParams = null;
  });

  it("Step 1: Initial request → Claude responds with tool_use", async () => {
    mockMessages = [
      assistantMessage([
        { type: "text", text: "I'll read that file." },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "Read",
          input: { file_path: "package.json" },
        },
      ]),
    ];

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Read package.json" }],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: { file_path: { type: "string" } },
            required: ["file_path"],
          },
        },
      ],
    });

    const body = (await response.json()) as ApiResponse;
    expect(response.status).toBe(200);
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content).toHaveLength(2);
    expect(body.content[0]?.type).toBe("text");
    expect(body.content[1]?.type).toBe("tool_use");
    expect(body.content[1]?.name).toBe("Read");
    expect(body.content[1]?.id).toBe("toolu_abc");
  });

  it("Step 2: Send tool_result → Claude responds with final text", async () => {
    mockMessages = [
      assistantMessage([
        {
          type: "text",
          text: "The project is opencode-claude-max-proxy version 1.1.0",
        },
      ]),
    ];

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "Read package.json" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll read that file." },
            {
              type: "tool_use",
              id: "toolu_abc",
              name: "Read",
              input: { file_path: "package.json" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_abc",
              content: '{"name":"opencode-claude-max-proxy","version":"1.1.0"}',
            },
          ],
        },
      ],
    });

    const body = (await response.json()) as ApiResponse;
    expect(response.status).toBe(200);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content[0]?.type).toBe("text");
    expect(body.content[0]?.text).toContain("opencode-claude-max-proxy");

    // Verify the prompt includes the tool result
    expect(capturedQueryParams?.prompt).toContain("opencode-claude-max-proxy");
    expect(capturedQueryParams?.prompt).toContain("1.1.0");
  });

  it("Step 3: Error tool_result → Claude recovers", async () => {
    mockMessages = [
      assistantMessage([
        {
          type: "text",
          text: "I see the agent type was invalid. Let me try with a different approach.",
        },
        {
          type: "tool_use",
          id: "toolu_retry",
          name: "Bash",
          input: { command: "cat README.md | head -5" },
        },
      ]),
    ];

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: "use a subagent to read README" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_task1",
              name: "Task",
              input: { agent_type: "general-purpose", prompt: "read README" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_task1",
              content:
                "Error: Unknown agent type: general-purpose is not a valid agent type",
              is_error: true,
            },
          ],
        },
      ],
    });

    const body = (await response.json()) as ApiResponse;
    expect(response.status).toBe(200);
    // Claude should recover with a new tool call or text
    expect(body.content.length).toBeGreaterThanOrEqual(1);
    // The prompt should contain the error so Claude can learn from it
    expect(capturedQueryParams?.prompt).toContain("Unknown agent type");
  });
});

// ============================================================
// STREAMING TOOL LOOP
// ============================================================

describe("Integration: Streaming tool loop", () => {
  let app: TestApp;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    mockMessages = [];
  });

  it("should stream tool_use blocks with proper SSE format", async () => {
    mockMessages = [
      messageStart("msg_stream_tool"),
      textBlockStart(0),
      textDelta(0, "Reading file..."),
      blockStop(0),
      toolUseBlockStart(1, "Read", "toolu_stream1"),
      inputJsonDelta(1, '{"file_path":'),
      inputJsonDelta(1, '"src/index.ts"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
    ];

    const response = await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Read src/index.ts" }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const text = await readStream(response);
    const events = parseSSE(text);

    // Should have message_start
    const msgStart = events.find((e) => e.event === "message_start");
    expect(msgStart).toBeDefined();

    // Should have text content
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as SseEventData).delta?.type === "text_delta",
    );
    expect(textDeltas.length).toBe(1);
    expect((textDeltas[0]?.data as SseEventData).delta?.text).toBe(
      "Reading file...",
    );

    // Should have tool_use content block
    const toolStarts = events.filter(
      (e) =>
        e.event === "content_block_start" &&
        (e.data as SseEventData).content_block?.type === "tool_use",
    );
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0]?.data as SseEventData).content_block?.name).toBe(
      "Read",
    );

    // Should have input_json_delta events
    const jsonDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as SseEventData).delta?.type === "input_json_delta",
    );
    expect(jsonDeltas.length).toBe(2);

    // Should have tool_use stop_reason
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta?.data as SseEventData).delta?.stop_reason).toBe(
      "tool_use",
    );
  });
});

// ============================================================
// CONCURRENT SUBAGENT SIMULATION
// ============================================================

describe("Integration: Concurrent subagent requests", () => {
  let app: TestApp;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done." }])];
  });

  it("should handle 3 concurrent requests (parent + 2 subagents)", async () => {
    const requests = Array.from({ length: 3 }, (_, i) =>
      post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: `Request ${i}` }],
      }),
    );

    const responses = await Promise.all(requests);
    const bodies = await Promise.all(
      responses.map((r) => r.json() as Promise<ApiResponse>),
    );

    for (let i = 0; i < 3; i++) {
      expect(responses[i]?.status).toBe(200);
      expect(bodies[i]?.content[0]?.text).toBe("Done.");
    }
  });
});
