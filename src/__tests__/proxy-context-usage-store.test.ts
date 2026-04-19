/**
 * Isolated test for the context-usage shared store path.
 *
 * This file runs in its own `bun test` invocation (see package.json "test" script)
 * so it gets a dedicated module instance and is not affected by other test files
 * that also call setSessionStoreDir().
 *
 * It verifies that GET /v1/sessions/:claudeSessionId/context-usage returns usage
 * that was persisted only in the shared file store (not in-memory LRU), which
 * simulates querying a different proxy instance or after a restart.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage } from "./helpers"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (_params: unknown) => (async function* () { yield assistantMessage([{ type: "text", text: "ok" }]) })(),
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
const { setSessionStoreDir, storeSharedSession } = await import("../proxy/sessionStore")

describe("GET /v1/sessions/:claudeSessionId/context-usage — shared store", () => {
  let tmpSessionDir: string

  beforeEach(() => {
    tmpSessionDir = mkdtempSync(join(tmpdir(), "context-usage-store-"))
    setSessionStoreDir(tmpSessionDir)
    clearSessionCache()
  })

  afterEach(() => {
    setSessionStoreDir(null)
    clearSessionCache()
    try { rmSync(tmpSessionDir, { recursive: true, force: true }) } catch {}
  })

  it("returns usage persisted in the shared session store", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const claudeSessionId = "sess_shared_usage_001"

    storeSharedSession(
      "shared-key-usage",
      claudeSessionId,
      1,
      "lineage",
      ["msg-hash"],
      [null],
      { input_tokens: 77, output_tokens: 11 }
    )

    const res = await app.fetch(
      new Request(`http://localhost/v1/sessions/${claudeSessionId}/context-usage`)
    )

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const usage = body.context_usage as Record<string, unknown>
    expect(body.session_id).toBe(claudeSessionId)
    expect(usage.input_tokens).toBe(77)
    expect(usage.output_tokens).toBe(11)
  })

  it("returns the last usage iteration from the shared session store", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const claudeSessionId = "sess_shared_usage_iterations_001"

    storeSharedSession(
      "shared-key-usage-iterations",
      claudeSessionId,
      1,
      "lineage",
      ["msg-hash"],
      [null],
      {
        input_tokens: 9000,
        cache_creation_input_tokens: 250000,
        cache_read_input_tokens: 700000,
        output_tokens: 1200,
        iterations: [
          {
            input_tokens: 9000,
            cache_creation_input_tokens: 250000,
            cache_read_input_tokens: 700000,
            output_tokens: 1200,
            type: "message",
          },
          {
            input_tokens: 1200,
            cache_creation_input_tokens: 800,
            cache_read_input_tokens: 3400,
            output_tokens: 80,
            type: "message",
          },
        ],
      }
    )

    const res = await app.fetch(
      new Request(`http://localhost/v1/sessions/${claudeSessionId}/context-usage`)
    )

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    const usage = body.context_usage as Record<string, unknown>
    expect(body.session_id).toBe(claudeSessionId)
    expect(usage.input_tokens).toBe(1200)
    expect(usage.cache_creation_input_tokens).toBe(800)
    expect(usage.cache_read_input_tokens).toBe(3400)
    expect(usage.output_tokens).toBe(80)
    expect(usage.type).toBe("message")
    expect(usage.iterations).toBeUndefined()
  })
})
