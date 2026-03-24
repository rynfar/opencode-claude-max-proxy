import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { assistantMessage, type TestFetchApp as TestApp } from "./helpers";

const originalMaxSessions = process.env.CLAUDE_PROXY_MAX_SESSIONS;
process.env.CLAUDE_PROXY_MAX_SESSIONS = "2";

type MockSdkMessage = Record<string, unknown>;

let mockMessages: MockSdkMessage[] = [];
let capturedQueryParams: { options?: { resume?: string } } | null = null;
let queuedSessionIds: string[] = [];
const loggerWarnings: string[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as { options?: { resume?: string } };
    const sessionId = queuedSessionIds.shift() || "sdk-session-default";
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId };
      }
    })();
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}));

mock.module("@/logger", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (...args: unknown[]) => {
      loggerWarnings.push(args.map((arg) => String(arg)).join(" "));
    },
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

mock.module("@/proxy/session/store", () => ({
  lookupSharedSession: () => undefined,
  storeSharedSession: () => {},
  clearSharedSessions: () => {},
}));

const { createProxyServer } = await import("../src/proxy");
const { clearSessionCache, getMaxSessionsLimit } = await import(
  "../src/proxy/session"
);

function createTestApp() {
  const { app } = createProxyServer();
  return app as TestApp;
}

async function post(
  app: TestApp,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

async function send(
  app: TestApp,
  session: string | undefined,
  firstMessage: string,
  sessionId: string,
) {
  queuedSessionIds.push(sessionId);
  const headers: Record<string, string> = {};
  if (session) headers["x-opencode-session"] = session;
  const response = await post(
    app,
    {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content: firstMessage }],
    },
    headers,
  );
  await response.json();
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])];
  capturedQueryParams = null;
  queuedSessionIds = [];
  loggerWarnings.length = 0;
  clearSessionCache();
});

afterAll(() => {
  if (originalMaxSessions === undefined)
    delete process.env.CLAUDE_PROXY_MAX_SESSIONS;
  else process.env.CLAUDE_PROXY_MAX_SESSIONS = originalMaxSessions;
});

describe("Session cache LRU eviction", () => {
  it("evicts the least-recently-used session entry", async () => {
    const app = createTestApp();

    await send(app, "oc-A", "first-A", "sdk-A");
    await send(app, "oc-B", "first-B", "sdk-B");
    await send(app, "oc-C", "first-C", "sdk-C");

    await send(app, "oc-A", "first-A", "sdk-A-new");
    expect(capturedQueryParams?.options?.resume).toBeUndefined();
  });

  it("refreshes recency when a key is accessed", async () => {
    const app = createTestApp();

    await send(app, "oc-A", "first-A", "sdk-A");
    await send(app, "oc-B", "first-B", "sdk-B");

    await send(app, "oc-A", "first-A", "sdk-A");
    expect(capturedQueryParams?.options?.resume).toBe("sdk-A");

    await send(app, "oc-C", "first-C", "sdk-C");

    await send(app, "oc-B", "first-B", "sdk-B-new");
    expect(capturedQueryParams?.options?.resume).toBeUndefined();
  });

  it("coordinates eviction across session and fingerprint caches", async () => {
    const app = createTestApp();

    await send(app, "oc-A", "alpha", "sdk-A");
    await send(app, "oc-B", "beta", "sdk-B");
    await send(app, "oc-C", "gamma", "sdk-C");

    await send(app, undefined, "alpha", "sdk-alpha-new");
    expect(capturedQueryParams?.options?.resume).toBeUndefined();

    clearSessionCache();

    await send(app, "oc-A", "alpha", "sdk-A2");
    await send(app, undefined, "fp-X", "sdk-X");
    await send(app, undefined, "fp-Y", "sdk-Y");

    await send(app, "oc-A", "alpha", "sdk-A3");
    expect(capturedQueryParams?.options?.resume).toBeUndefined();
  });
});

describe("Max session env parsing", () => {
  it("falls back to default and logs warning for invalid values", () => {
    const original = process.env.CLAUDE_PROXY_MAX_SESSIONS;

    process.env.CLAUDE_PROXY_MAX_SESSIONS = "not-a-number";
    loggerWarnings.length = 0;

    try {
      expect(getMaxSessionsLimit()).toBe(1000);
      expect(loggerWarnings.length).toBe(1);
      expect(loggerWarnings[0]).toContain("CLAUDE_PROXY_MAX_SESSIONS");
      expect(loggerWarnings[0]).toContain("using 1000");
    } finally {
      if (original === undefined) delete process.env.CLAUDE_PROXY_MAX_SESSIONS;
      else process.env.CLAUDE_PROXY_MAX_SESSIONS = original;
    }
  });
});
