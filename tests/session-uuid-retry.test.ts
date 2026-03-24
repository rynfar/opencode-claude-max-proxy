/**
 * Tests for stale undo UUID retry logic.
 *
 * After an undo+fork, the SDK session gets new UUIDs. If the proxy
 * stores the old UUIDs, the next undo attempt passes a stale UUID as
 * `resumeSessionAt`, causing the SDK to throw "No message found with
 * message.uuid". The proxy should catch this and retry without
 * `resumeSessionAt`.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assistantMessage,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
  parseSSE,
  type TestFetchApp as TestApp,
  textBlockStart,
  textDelta,
} from "./helpers";

// --- Mock state ---

let capturedQueryCalls: Array<{
  options: {
    resume?: string;
    forkSession?: boolean;
    resumeSessionAt?: string;
  };
}> = [];
let queryCallCount = 0;
let shouldFailOnFirstCall = false;
let streamMode = false;

const UUID_ERROR_MSG =
  "No message found with message.uuid of: 9895d4bc-f217-4186-9fb1-399e22ee909b";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: Record<string, unknown>) => {
    queryCallCount++;
    const callIndex = queryCallCount;
    capturedQueryCalls.push({
      options: params.options as (typeof capturedQueryCalls)[0]["options"],
    });

    // First call fails with UUID error, second succeeds
    if (shouldFailOnFirstCall && callIndex === 1) {
      return (async function* () {
        throw new Error(UUID_ERROR_MSG);
      })();
    }

    if (streamMode) {
      return (async function* () {
        for (const msg of [
          messageStart(),
          textBlockStart(0),
          textDelta(0, "recovered"),
          blockStop(0),
          messageDelta("end_turn"),
          messageStop(),
        ]) {
          yield { ...msg, session_id: "sdk-new" };
        }
      })();
    }

    return (async function* () {
      yield {
        ...assistantMessage([{ type: "text", text: "recovered" }]),
        session_id: "sdk-new",
      };
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

const tmpDir = mkdtempSync(join(tmpdir(), "session-uuid-retry-test-"));
process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir;

const { createProxyServer } = await import("../src/proxy");
const { clearSessionCache } = await import("../src/proxy/session");
const { clearSharedSessions } = await import("../src/proxy/session/store");
const { isSessionUuidError } = await import(
  "../src/providers/claude/errors"
);

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROXY_SESSION_DIR;
  mock.restore();
});

function createTestApp() {
  const { app } = createProxyServer();
  return app as TestApp;
}

async function post(
  app: TestApp,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function readStreamFull(response: Response): Promise<string> {
  if (!response.body) throw new Error("Expected streaming body");
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

beforeEach(() => {
  capturedQueryCalls = [];
  queryCallCount = 0;
  shouldFailOnFirstCall = false;
  streamMode = false;
  clearSessionCache();
  clearSharedSessions();
});

// ── Unit: isSessionUuidError ──

describe("isSessionUuidError", () => {
  it("detects the UUID error from an Error object", () => {
    expect(isSessionUuidError(new Error(UUID_ERROR_MSG))).toBe(true);
  });

  it("detects the UUID error from a string", () => {
    expect(isSessionUuidError(UUID_ERROR_MSG)).toBe(true);
  });

  it("detects case-insensitive match", () => {
    expect(
      isSessionUuidError(
        new Error("no message found with message.uuid of: abc-123"),
      ),
    ).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isSessionUuidError(new Error("rate limit exceeded"))).toBe(false);
    expect(isSessionUuidError(new Error("authentication failed"))).toBe(false);
    expect(isSessionUuidError(null)).toBe(false);
    expect(isSessionUuidError(undefined)).toBe(false);
  });
});

// ── Integration: non-stream retry ──

describe("Stale UUID retry: non-stream", () => {
  it("retries without resumeSessionAt when UUID is stale", async () => {
    const app = createTestApp();

    // Turn 1: establish session
    await (
      await post(
        app,
        {
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        },
        { "x-opencode-session": "sess-retry" },
      )
    ).json();

    // Turn 2: continuation
    queryCallCount = 0;
    capturedQueryCalls = [];
    await (
      await post(
        app,
        {
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "step 2" },
          ],
        },
        { "x-opencode-session": "sess-retry" },
      )
    ).json();

    // Turn 3: undo — the first call should fail with UUID error, retry should succeed
    queryCallCount = 0;
    capturedQueryCalls = [];
    shouldFailOnFirstCall = true;

    const res = await post(
      app,
      {
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "different step 2" },
        ],
      },
      { "x-opencode-session": "sess-retry" },
    );

    const body = (await res.json()) as Record<string, unknown>;

    // Should succeed (retry worked)
    expect(res.status).toBe(200);
    expect(body.type).toBe("message");

    // Should have made 2 calls: first with resumeSessionAt (failed), second without
    expect(capturedQueryCalls.length).toBe(2);
    expect(capturedQueryCalls[0]!.options.forkSession).toBe(true);
    // Retry should NOT have forkSession or resumeSessionAt
    expect(capturedQueryCalls[1]!.options.forkSession).toBeUndefined();
    expect(capturedQueryCalls[1]!.options.resumeSessionAt).toBeUndefined();
  });

  it("does not retry for non-UUID errors", async () => {
    const app = createTestApp();

    // Establish session
    await (
      await post(
        app,
        {
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        },
        { "x-opencode-session": "sess-no-retry" },
      )
    ).json();

    // The mock only throws UUID error, so a normal continuation won't trigger retry
    queryCallCount = 0;
    capturedQueryCalls = [];

    const res = await post(
      app,
      {
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ],
      },
      { "x-opencode-session": "sess-no-retry" },
    );

    expect(res.status).toBe(200);
    // Only one call — no retry needed for continuation
    expect(capturedQueryCalls.length).toBe(1);
  });
});

// ── Integration: stream retry ──

describe("Stale UUID retry: stream", () => {
  it("retries without resumeSessionAt when UUID is stale (streaming)", async () => {
    const app = createTestApp();

    // Turn 1 & 2: establish session with non-stream so assistant UUIDs are captured
    await (
      await post(
        app,
        {
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [{ role: "user", content: "hello stream" }],
        },
        { "x-opencode-session": "sess-stream-retry" },
      )
    ).json();

    queryCallCount = 0;
    capturedQueryCalls = [];

    await (
      await post(
        app,
        {
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [
            { role: "user", content: "hello stream" },
            { role: "assistant", content: "hi" },
            { role: "user", content: "step 2" },
          ],
        },
        { "x-opencode-session": "sess-stream-retry" },
      )
    ).json();

    // Turn 3: undo via streaming — first call fails with UUID error, retry succeeds
    queryCallCount = 0;
    capturedQueryCalls = [];
    shouldFailOnFirstCall = true;
    streamMode = true;

    const res = await post(
      app,
      {
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: true,
        messages: [
          { role: "user", content: "hello stream" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "different step 2" },
        ],
      },
      { "x-opencode-session": "sess-stream-retry" },
    );

    const text = await readStreamFull(res);
    const events = parseSSE(text);

    // Should have streamed content from the retry
    const textEvents = events.filter((e) => e.event === "content_block_delta");
    expect(textEvents.length).toBeGreaterThan(0);

    // Should have made 2 calls: first with forkSession (failed), second without
    expect(capturedQueryCalls.length).toBe(2);
    expect(capturedQueryCalls[0]!.options.forkSession).toBe(true);
    expect(capturedQueryCalls[1]!.options.forkSession).toBeUndefined();
    expect(capturedQueryCalls[1]!.options.resumeSessionAt).toBeUndefined();
  });
});
