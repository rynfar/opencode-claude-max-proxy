/**
 * Environment Variable Stripping Tests
 *
 * Verifies that ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and ANTHROPIC_AUTH_TOKEN
 * are stripped from the environment passed to SDK subprocesses, preventing:
 *   1. Infinite loops when the proxy sets these vars for OpenCode
 *   2. The subprocess using a fake "dummy" API key instead of native Claude Max auth
 *
 * Related: https://github.com/rynfar/opencode-claude-max-proxy/issues/XXX
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { TestFetchApp as TestApp } from "./helpers";

// Capture the env passed to query()
type QueryOptionsSnapshot = { env: Record<string, string | undefined> };
let capturedQueryOptions: QueryOptionsSnapshot | null = null;

function requireCapturedOptions(): QueryOptionsSnapshot {
  if (!capturedQueryOptions) {
    throw new Error("expected SDK query options to be captured");
  }
  return capturedQueryOptions;
}
const savedEnv: Record<string, string | undefined> = {};

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { options: QueryOptionsSnapshot }) => {
    capturedQueryOptions = params.options;
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
        session_id: "sess-env-test",
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

describe("Environment variable stripping", () => {
  beforeEach(() => {
    capturedQueryOptions = null;
    clearSessionCache();
    // Save current env
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
    ]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("should strip ANTHROPIC_API_KEY from subprocess env", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy";
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    expect(requireCapturedOptions().env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("should strip ANTHROPIC_BASE_URL from subprocess env", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456";
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    expect(requireCapturedOptions().env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("should strip ANTHROPIC_AUTH_TOKEN from subprocess env", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "some-token";
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    expect(requireCapturedOptions().env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("should strip all three Anthropic env vars simultaneously", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-123";
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    const env = requireCapturedOptions().env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("should preserve other env vars", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy";
    process.env.MY_CUSTOM_VAR = "keep-me";
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    expect(requireCapturedOptions().env.MY_CUSTOM_VAR).toBe("keep-me");
    delete process.env.MY_CUSTOM_VAR;
  });

  it("should set ENABLE_TOOL_SEARCH to false", async () => {
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    expect(requireCapturedOptions().env.ENABLE_TOOL_SEARCH).toBe("false");
  });

  it("should still strip CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "true";
    const app = createTestApp();
    await post(app, BASIC_REQUEST);
    expect(
      requireCapturedOptions().env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
    ).toBeUndefined();
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
  });

  it("should work in streaming mode too", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456";
    const app = createTestApp();
    const res = await post(app, { ...BASIC_REQUEST, stream: true });
    // Consume the stream to trigger the query
    await res.text();
    const env = requireCapturedOptions().env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
