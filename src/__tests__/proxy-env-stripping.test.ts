/**
 * Environment Variable Stripping Tests
 *
 * Verifies that ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and ANTHROPIC_AUTH_TOKEN
 * are stripped from the environment passed to SDK subprocesses, preventing:
 *   1. Infinite loops when the proxy sets these vars for OpenCode
 *   2. The subprocess using a fake "dummy" API key instead of native Claude Max auth
 *
 * Related: https://github.com/rynfar/meridian/issues/XXX
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

// Capture the env passed to query()
let capturedQueryOptions: any = null
const savedEnv: Record<string, string | undefined> = {}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryOptions = params.options
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
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const BASIC_REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

describe("Environment variable stripping", () => {
  beforeEach(() => {
    capturedQueryOptions = null
    clearSessionCache()
    // Save current env
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    // Restore env
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it("should strip ANTHROPIC_API_KEY from subprocess env", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("should strip ANTHROPIC_BASE_URL from subprocess env", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it("should strip ANTHROPIC_AUTH_TOKEN from subprocess env", async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "some-token"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("should strip all three Anthropic env vars simultaneously", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-123"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(capturedQueryOptions.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(capturedQueryOptions.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it("should preserve other env vars", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    process.env.MY_CUSTOM_VAR = "keep-me"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.MY_CUSTOM_VAR).toBe("keep-me")
    delete process.env.MY_CUSTOM_VAR
  })

  it("should set ENABLE_TOOL_SEARCH to false", async () => {
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  it("should still strip CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", async () => {
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "true"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  })

  // Regression: #441 — Claude calls SDK-only `PowerShell` tool that OpenCode
  // can't execute. Triggered by `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` inherited
  // from settings.json or shell env. Setting to "0" doesn't help — the var
  // must be removed entirely.
  it("should strip CLAUDE_CODE_USE_POWERSHELL_TOOL=1 (regression #441)", async () => {
    process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL = "1"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBeUndefined()
    delete process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
  })

  it("should strip CLAUDE_CODE_USE_POWERSHELL_TOOL=0 too (full removal, not just disable)", async () => {
    // Per the upstream behavior the reporter documented: even setting it to
    // "0" can leak the PowerShell tool to the model. Belt-and-suspenders:
    // we strip the var entirely regardless of value.
    process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL = "0"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.CLAUDE_CODE_USE_POWERSHELL_TOOL).toBeUndefined()
    delete process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL
  })

  it("should work in streaming mode too", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    const app = createTestApp()
    const res = await post(app, { ...BASIC_REQUEST, stream: true })
    // Consume the stream to trigger the query
    await res.text()
    expect(capturedQueryOptions).toBeDefined()
    expect(capturedQueryOptions.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(capturedQueryOptions.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })
})

describe("SDK model pin injection (fixes #419)", () => {
  const modelEnvKeys = [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "MERIDIAN_DEFAULT_OPUS_MODEL",
    "MERIDIAN_DEFAULT_SONNET_MODEL",
    "MERIDIAN_DEFAULT_HAIKU_MODEL",
  ]
  const savedModelEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    capturedQueryOptions = null
    clearSessionCache()
    for (const k of modelEnvKeys) {
      savedModelEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedModelEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("injects Meridian's canonical model pins when no shell env is set", async () => {
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-7")
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-6")
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-5")
  })

  it("shell ANTHROPIC_DEFAULT_* values win over Meridian's pins", async () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-1-20250805"
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-20250514"
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-custom"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-4-1-20250805")
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4-20250514")
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-4-custom")
  })

  it("MERIDIAN_DEFAULT_OPUS_MODEL overrides the canonical pin but not a shell ANTHROPIC_DEFAULT_OPUS_MODEL", async () => {
    process.env.MERIDIAN_DEFAULT_OPUS_MODEL = "claude-opus-custom"
    const app = createTestApp()
    await post(app, BASIC_REQUEST)
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-custom")

    // Now add a shell env — it wins over MERIDIAN_ too.
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-shell-wins"
    clearSessionCache()
    const app2 = createTestApp()
    await post(app2, BASIC_REQUEST)
    expect(capturedQueryOptions.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-shell-wins")
  })
})
