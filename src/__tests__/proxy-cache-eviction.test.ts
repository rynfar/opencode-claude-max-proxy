import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { assistantMessage } from "./helpers"

const originalMaxSessions = process.env.CLAUDE_PROXY_MAX_SESSIONS
process.env.CLAUDE_PROXY_MAX_SESSIONS = "2"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
let capturedQueryParams: { options?: { resume?: string } } | null = null
let queuedSessionIds: string[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as { options?: { resume?: string } }
    const sessionId = queuedSessionIds.shift() || "sdk-session-default"
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

mock.module("../mcpTools", () => ({
  opencodeMcpServer: { type: "sdk", name: "opencode", instance: {} },
}))

mock.module("../proxy/sessionStore", () => ({
  lookupSharedSession: () => undefined,
  storeSharedSession: () => {},
  clearSharedSessions: () => {},
}))

const { createProxyServer, clearSessionCache, getMaxSessionsLimit } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function post(app: TestApp, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

async function send(app: TestApp, session: string | undefined, firstMessage: string, sessionId: string) {
  queuedSessionIds.push(sessionId)
  const headers = session ? { "x-opencode-session": session } : {}
  const response = await post(app, {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream: false,
    messages: [{ role: "user", content: firstMessage }],
  }, headers)
  await response.json()
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedQueryParams = null
  queuedSessionIds = []
  clearSessionCache()
})

afterAll(() => {
  if (originalMaxSessions === undefined) delete process.env.CLAUDE_PROXY_MAX_SESSIONS
  else process.env.CLAUDE_PROXY_MAX_SESSIONS = originalMaxSessions
})

describe("Session cache LRU eviction", () => {
  it("evicts the least-recently-used session entry", async () => {
    const app = createTestApp()

    await send(app, "oc-A", "first-A", "sdk-A")
    await send(app, "oc-B", "first-B", "sdk-B")
    await send(app, "oc-C", "first-C", "sdk-C")

    await send(app, "oc-A", "first-A", "sdk-A-new")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("refreshes recency when a key is accessed", async () => {
    const app = createTestApp()

    await send(app, "oc-A", "first-A", "sdk-A")
    await send(app, "oc-B", "first-B", "sdk-B")

    await send(app, "oc-A", "first-A", "sdk-A")
    expect(capturedQueryParams?.options?.resume).toBe("sdk-A")

    await send(app, "oc-C", "first-C", "sdk-C")

    await send(app, "oc-B", "first-B", "sdk-B-new")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })

  it("coordinates eviction across session and fingerprint caches", async () => {
    const app = createTestApp()

    await send(app, "oc-A", "alpha", "sdk-A")
    await send(app, "oc-B", "beta", "sdk-B")
    await send(app, "oc-C", "gamma", "sdk-C")

    await send(app, undefined, "alpha", "sdk-alpha-new")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()

    clearSessionCache()

    await send(app, "oc-A", "alpha", "sdk-A2")
    await send(app, undefined, "fp-X", "sdk-X")
    await send(app, undefined, "fp-Y", "sdk-Y")

    await send(app, "oc-A", "alpha", "sdk-A3")
    expect(capturedQueryParams?.options?.resume).toBeUndefined()
  })
})

describe("Max session env parsing", () => {
  it("falls back to default and logs warning for invalid values", () => {
    const original = process.env.CLAUDE_PROXY_MAX_SESSIONS
    const originalWarn = console.warn
    const warnings: string[] = []

    process.env.CLAUDE_PROXY_MAX_SESSIONS = "not-a-number"
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "))
    }

    try {
      expect(getMaxSessionsLimit()).toBe(1000)
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("CLAUDE_PROXY_MAX_SESSIONS")
      expect(warnings[0]).toContain("using default 1000")
    } finally {
      console.warn = originalWarn
      if (original === undefined) delete process.env.CLAUDE_PROXY_MAX_SESSIONS
      else process.env.CLAUDE_PROXY_MAX_SESSIONS = original
    }
  })
})
