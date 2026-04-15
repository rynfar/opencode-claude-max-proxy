/**
 * Fingerprint cache skip for fork/subagent requests.
 *
 * When `x-meridian-source` marks a request as an independent sub-flow
 * (fork-memory-extract, subagent-scout, etc.), meridian must:
 *
 *   1. Skip fingerprint lookup — don't classify against the parent's cache
 *      (which would bounce between undo / modified-continuation / diverged as
 *      different flows write different hashes to the shared key)
 *   2. Skip fingerprint write — don't pollute the parent's cache entry with
 *      the fork's message hashes
 *
 * Requests without the header or with source=main retain today's behavior
 * exactly. This test verifies both sides.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let mockMessages: unknown[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { lookupSession } = await import("../proxy/session/cache")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const BASE_BODY = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello from pylon main" }],
}

describe("x-meridian-source: fingerprint cache skip for independent sessions", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    clearSessionCache()
  })

  /**
   * To test "was the cache written," send request N, then call lookupSession
   * with N+1 messages (same prefix + one new user message). If the cache was
   * written after N, verifyLineage sees a prefix hash match + new suffix →
   * "continuation". If cache wasn't written, lookup returns "diverged".
   *
   * We can't use the SAME messages for both post and lookup because
   * verifyLineage intentionally treats `messages.length <= cached.messageCount`
   * as a replay and classifies diverged (guards against duplicate request
   * retries re-resuming the old SDK session).
   */
  const nextTurn = [
    ...BASE_BODY.messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "another turn" },
  ]

  it("does NOT write to the fingerprint cache when source=fork-memory-extract", async () => {
    const app = createTestApp()
    const cwd = process.cwd()

    await post(app, BASE_BODY, { "x-meridian-source": "fork-memory-extract" })

    const result = lookupSession(undefined, nextTurn, cwd)
    expect(result.type).toBe("diverged")
  })

  it("does NOT write to the fingerprint cache when source=subagent-<name>", async () => {
    const app = createTestApp()
    const cwd = process.cwd()
    await post(app, BASE_BODY, { "x-meridian-source": "subagent-scout" })

    const result = lookupSession(undefined, nextTurn, cwd)
    expect(result.type).toBe("diverged")
  })

  it("DOES write to the fingerprint cache when source=main", async () => {
    // Sanity: main requests (non-fork, non-subagent) must still populate the
    // cache so the normal resume optimization works for regular chat turns.
    const app = createTestApp()
    const cwd = process.cwd()

    await post(app, BASE_BODY, { "x-meridian-source": "main" })

    const result = lookupSession(undefined, nextTurn, cwd)
    expect(result.type).not.toBe("diverged")
  })

  it("DOES write to the fingerprint cache when no source header is set", async () => {
    // Backward-compat: clients that don't send x-meridian-source must get
    // today's behavior byte-for-byte.
    const app = createTestApp()
    const cwd = process.cwd()
    await post(app, BASE_BODY)

    const result = lookupSession(undefined, nextTurn, cwd)
    expect(result.type).not.toBe("diverged")
  })

  it("fork with matching fingerprint does NOT overwrite parent's cache entry", async () => {
    // Scenario: parent conversation writes its cache entry. Then a fork fires
    // with the SAME fingerprint (same first user message + cwd — which is
    // exactly why we needed this fix). The fork must not overwrite or
    // invalidate the parent's cache.
    const app = createTestApp()
    const cwd = process.cwd()

    // 1) Parent turn establishes cache.
    await post(app, BASE_BODY, { "x-meridian-source": "main" })
    const afterParent = lookupSession(undefined, nextTurn, cwd)
    expect(afterParent.type).not.toBe("diverged")

    // 2) Fork turn with matching fingerprint — should NOT touch parent's entry.
    await post(app, BASE_BODY, { "x-meridian-source": "fork-memory-extract" })

    // 3) Parent's cache entry should still resolve to non-diverged.
    const afterFork = lookupSession(undefined, nextTurn, cwd)
    expect(afterFork.type).not.toBe("diverged")
  })

  it("logs source=fork-... even for independent sessions (observability preserved)", async () => {
    // When skipping the cache, we still want the source to appear in the
    // [PROXY] summary log line so the operator can see that an independent
    // session was handled.
    const { spyOn } = await import("bun:test")
    const logSpy = spyOn(console, "error")
    const app = createTestApp()

    await post(app, BASE_BODY, { "x-meridian-source": "fork-memory-extract" })

    const calls = logSpy.mock.calls.map((c: any) => String(c[0]))
    const summary = calls.find((msg: string) => msg.includes("[PROXY]") && msg.includes("adapter=") && msg.includes("msgCount="))
    expect(summary).toBeDefined()
    expect(summary).toContain("source=fork-memory-extract")
    // Independent sessions always take the 'new' lineage path (since we skip
    // the cache lookup, lineage result is diverged → logged as 'new').
    expect(summary).toContain("lineage=new")
    logSpy.mockRestore()
  })
})
