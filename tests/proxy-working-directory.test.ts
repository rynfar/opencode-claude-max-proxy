/**
 * Working Directory Tests
 *
 * The proxy must pass the correct working directory to the Claude SDK
 * so that Claude's system prompt shows the user's project directory,
 * not the proxy's installation directory.
 *
 * Configurable via CLAUDE_PROXY_WORKDIR env var.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { assistantMessage, type TestFetchApp as TestApp } from "./helpers";

type CapturedSdkQueryParams = {
  options: {
    cwd?: string;
  };
};

let mockMessages: Record<string, unknown>[] = [];
let capturedQueryParams: CapturedSdkQueryParams | null = null;

function requireCapturedParams(): CapturedSdkQueryParams {
  if (!capturedQueryParams) {
    throw new Error("expected captured SDK query params");
  }
  return capturedQueryParams;
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: Record<string, unknown>) => {
    capturedQueryParams = params as CapturedSdkQueryParams;
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

async function post(app: TestApp, body: Record<string, unknown>) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

describe("Working directory", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hi" }])];
    capturedQueryParams = null;
    clearSessionCache();
  });

  it("should pass cwd option to the SDK query", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
    ).json();

    const opts = requireCapturedParams().options;
    expect(opts.cwd).toBeDefined();
    expect(typeof opts.cwd).toBe("string");
  });

  it("should use CLAUDE_PROXY_WORKDIR when set", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR;
    process.env.CLAUDE_PROXY_WORKDIR = "/tmp/test-project";

    try {
      const app = createTestApp();
      await (
        await post(app, {
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        })
      ).json();

      expect(requireCapturedParams().options.cwd).toBe("/tmp/test-project");
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original;
      else delete process.env.CLAUDE_PROXY_WORKDIR;
    }
  });

  it("should default to process.cwd() when CLAUDE_PROXY_WORKDIR is not set", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR;
    delete process.env.CLAUDE_PROXY_WORKDIR;

    try {
      const app = createTestApp();
      await (
        await post(app, {
          model: "claude-sonnet-4-5",
          max_tokens: 100,
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        })
      ).json();

      expect(requireCapturedParams().options.cwd).toBe(process.cwd());
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original;
    }
  });
});
