/**
 * Error Handling Tests
 *
 * Verifies the proxy returns clear, actionable error messages
 * instead of cryptic SDK crashes.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TestFetchApp as TestApp } from "./helpers";

// Make the SDK throw specific errors
let mockError: Error | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    if (mockError) {
      const err = mockError;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.reject(err);
            },
          };
        },
      };
    }
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sess-1",
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

const { createProxyServer } = await import("../src/proxy");
const { clearSessionCache } = await import("../src/proxy/session");

function createTestApp() {
  const { app } = createProxyServer();
  return app;
}

async function post(app: TestApp, body: Record<string, unknown>) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const BASIC_REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
};

/** Anthropic-style error object returned by the proxy on failed /v1/messages. */
type ProxyErrorJson = {
  error: { type: string; message: string };
};

async function readErrorJson(res: Response): Promise<ProxyErrorJson> {
  return (await res.json()) as ProxyErrorJson;
}

describe("Error classification", () => {
  beforeEach(() => {
    mockError = null;
    clearSessionCache();
  });

  it("should return 401 for authentication errors", async () => {
    mockError = new Error(
      "API Error: 401 authentication_error - Invalid authentication credentials",
    );
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(401);
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("claude login");
  });

  it("should return 401 for process exit code 1", async () => {
    mockError = new Error("Claude Code process exited with code 1");
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(401);
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toContain("claude login");
  });

  it("should return 429 for rate limit errors", async () => {
    mockError = new Error("429 Too Many Requests - rate limit exceeded");
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(429);
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toContain("rate limit");
  });

  it("should return 402 for billing errors", async () => {
    mockError = new Error("402 billing_error - subscription expired");
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(402);
    expect(body.error.type).toBe("billing_error");
    expect(body.error.message).toContain("subscription");
  });

  it("should return 503 for overloaded errors", async () => {
    mockError = new Error("503 overloaded");
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(503);
    expect(body.error.type).toBe("overloaded_error");
  });

  it("should return 504 for timeout errors", async () => {
    mockError = new Error("Request timed out after 120s");
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(504);
    expect(body.error.type).toBe("timeout_error");
  });

  it("should return 500 for unknown errors", async () => {
    mockError = new Error("Something weird happened");
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    const body = await readErrorJson(res);

    expect(res.status).toBe(500);
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toContain("Something weird happened");
  });

  it("should return 200 when no error", async () => {
    const app = createTestApp();
    const res = await post(app, BASIC_REQUEST);
    expect(res.status).toBe(200);
  });
});
