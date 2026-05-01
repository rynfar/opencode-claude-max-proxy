/**
 * Working Directory Tests
 *
 * The proxy must pass the correct working directory to the Claude SDK
 * so that Claude's system prompt shows the user's project directory,
 * not the proxy's installation directory.
 *
 * Configurable via CLAUDE_PROXY_WORKDIR env var. When the resolved cwd
 * doesn't exist on the proxy host (remote-server case, issue #381) we
 * fall back to process.cwd() to keep the SDK spawn from dying with
 * ENOENT.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import { tmpdir } from "node:os"
import { assistantMessage } from "./helpers"

let mockMessages: any[] = []
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
  const req = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return app.fetch(req)
}

describe("Working directory", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hi" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("should pass cwd option to the SDK query", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 100,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.cwd).toBeDefined()
    expect(typeof capturedQueryParams.options.cwd).toBe("string")
  })

  it("should use CLAUDE_PROXY_WORKDIR when set and the path exists", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    // tmpdir() always exists; using a fake path triggers the existsSync
    // fallback (covered separately below).
    const realPath = tmpdir()
    process.env.CLAUDE_PROXY_WORKDIR = realPath

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(realPath)
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
      else delete process.env.CLAUDE_PROXY_WORKDIR
    }
  })

  it("should fall back to process.cwd() when CLAUDE_PROXY_WORKDIR points at a non-existent path (#381)", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    process.env.CLAUDE_PROXY_WORKDIR = "/this/definitely/does/not/exist/zzz"

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
      else delete process.env.CLAUDE_PROXY_WORKDIR
    }
  })

  it("should fall back to process.cwd() when client-supplied cwd doesn't exist (#381 remote-host case)", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.MERIDIAN_WORKDIR

    try {
      const app = createTestApp()
      // Simulate OpenCode embedding a remote machine's path in <env>.
      // The path doesn't exist on the proxy host — without the fallback,
      // the SDK would fail with ENOENT (reported as "binary not found").
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        system: "<env>\nWorking directory: /Users/remoteclient/proj\nIs directory a git repo: yes\n</env>",
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })

  it("should use the client-supplied cwd when it exists on the proxy host (same-host case)", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.MERIDIAN_WORKDIR

    try {
      const realPath = tmpdir()
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        system: `<env>\nWorking directory: ${realPath}\nIs directory a git repo: yes\n</env>`,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(realPath)
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })

  it("should default to process.cwd() when CLAUDE_PROXY_WORKDIR is not set", async () => {
    const original = process.env.CLAUDE_PROXY_WORKDIR
    delete process.env.CLAUDE_PROXY_WORKDIR

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 100,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      expect(capturedQueryParams.options.cwd).toBe(process.cwd())
    } finally {
      if (original) process.env.CLAUDE_PROXY_WORKDIR = original
    }
  })
})
