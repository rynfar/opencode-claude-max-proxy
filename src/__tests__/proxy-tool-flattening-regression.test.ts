/**
 * Regression test for issue #386 — "New version still shows the Tools message in the context"
 *
 * The bug: in certain scenarios (proxy restart, cache eviction, new session header on rehydration),
 * meridian falls through to "diverged" lineage and replays the full conversation history. When that
 * history contains tool_use / tool_result blocks, they get flattened to `[Tool Use: name(...)]` and
 * `[Tool Result for toolu_...: ...]` strings in the text prompt sent to the SDK.
 *
 * This test reproduces the worst-case scenario that real users hit and verifies that the SDK
 * never receives a prompt containing those flattened tool strings.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

type MockSdkMessage = Record<string, unknown>
type TestApp = { fetch: (req: Request) => Promise<Response> }

let mockMessages: MockSdkMessage[] = []
interface CapturedParams {
  prompt?: unknown
  options?: { resume?: string; forkSession?: boolean }
}
let capturedParams: CapturedParams | null = null
let queuedSessionIds: string[] = []
function getCaptured(): CapturedParams | null { return capturedParams }

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedParams = params as any
    const sessionId = queuedSessionIds.shift() || "sdk-session-default"
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const tmpDir = mkdtempSync(join(tmpdir(), "tool-flatten-regression-"))
process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { clearSharedSessions } = await import("../proxy/sessionStore")

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app as TestApp
}

async function postWithSession(
  app: TestApp,
  sessionHeader: string,
  messages: Array<{ role: string; content: any }>,
  sdkSessionId: string,
) {
  queuedSessionIds.push(sdkSessionId)
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": sessionHeader,
      "user-agent": "opencode/1.0.0",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages,
    }),
  }))
  await response.json()
}

function promptToString(prompt: unknown): string {
  if (typeof prompt === "string") return prompt
  return ""
}

/** Assert the SDK prompt contains no flattened tool-use strings */
function assertNoFlattenedToolBlocks(prompt: unknown) {
  const s = promptToString(prompt)
  expect(s).not.toContain("[Tool Use:")
  expect(s).not.toContain("[Tool Result")
  expect(s).not.toContain("[Tool Result for")
}

const history = [
  { role: "user", content: "write a hello.txt file" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll write that file." },
      { type: "tool_use", id: "toolu_001", name: "write", input: { path: "hello.txt", content: "hello" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_001", content: "File written successfully." },
    ],
  },
  { role: "assistant", content: "Done! hello.txt has been created." },
  { role: "user", content: "now read it back to me" },
]

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
  capturedParams = null
  queuedSessionIds = []
  clearSessionCache()
  clearSharedSessions()
})

describe("Issue #386 — tool_use blocks must not leak into SDK prompt as text", () => {
  it("headered session: continuation with tool_use history sends delta only (no flatten)", async () => {
    const app = createTestApp()

    // Turn 1 — establish session
    await postWithSession(app, "sess-continue", [
      { role: "user", content: "write a hello.txt file" },
    ], "sdk-continue")

    // Turn 2 — continuation with full history including tool_use/tool_result blocks
    capturedParams = null
    await postWithSession(app, "sess-continue", history, "sdk-continue")

    // Must resume (lineage=continuation) and must not have flattened tool blocks into text
    expect(getCaptured()?.options?.resume).toBe("sdk-continue")
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("headered session: proxy restart (cache cleared) must still rehydrate without flattening", async () => {
    const app = createTestApp()

    // Turn 1 — establish session
    await postWithSession(app, "sess-rehydrate", [
      { role: "user", content: "write a hello.txt file" },
    ], "sdk-rehydrate")

    // Simulate proxy restart: wipe in-memory cache (shared store remains)
    clearSessionCache()

    // Turn 2 — same session header, full history with tool_use blocks
    capturedParams = null
    await postWithSession(app, "sess-rehydrate", history, "sdk-rehydrate")

    // After restart, shared-store lookup should find the session → continuation
    // (delta only). Critically, tool_use/tool_result must NOT leak as text.
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("headered session: new session header on rehydration (session lost) must not flatten", async () => {
    const app = createTestApp()

    // Turn 1 — original session header
    await postWithSession(app, "sess-original", [
      { role: "user", content: "write a hello.txt file" },
    ], "sdk-original")

    // Client restarts and generates a NEW session header, but sends full history
    capturedParams = null
    await postWithSession(app, "sess-brand-new", history, "sdk-brand-new")

    // This is where fingerprint fallback would have saved us in the old code.
    // Whatever the final lineage decision, tool_use blocks must not be flattened.
    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })

  it("headerless session: full rehydration path must not flatten tool_use blocks", async () => {
    const app = createTestApp()

    // Turn 1 — headerless (pi-style flow)
    queuedSessionIds.push("sdk-headerless-1")
    await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "write a hello.txt file" }],
      }),
    })).then(r => r.json())

    // Turn 2 — headerless with full history (tool blocks)
    capturedParams = null
    queuedSessionIds.push("sdk-headerless-2")
    await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: history,
      }),
    })).then(r => r.json())

    assertNoFlattenedToolBlocks(getCaptured()?.prompt)
  })
})
