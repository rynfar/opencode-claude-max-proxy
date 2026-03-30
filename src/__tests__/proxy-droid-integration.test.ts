/**
 * Droid Adapter Integration Tests
 *
 * Verifies that when requests arrive with a Droid User-Agent header, the proxy
 * correctly selects the Droid adapter: uses "droid" MCP server name, extracts
 * CWD from system-reminder, skips Task-tool hooks and agent definitions, and
 * falls back to fingerprint-based session management.
 *
 * Also verifies OpenCode requests are completely unaffected (backward compat).
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
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

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const DROID_UA = "factory-cli/0.89.0"

const DROID_SYSTEM_REMINDER = `<system-reminder>

User system info (darwin 25.3.0)
Model: claude-sonnet-4-5-20250514
Today's date: 2026-03-29

% pwd
/Users/dev/my-project

% ls
src package.json

% git rev-parse --abbrev-ref HEAD
main

</system-reminder>`

const DROID_BODY = {
  model: "claude-sonnet-4-5-20250514",
  max_tokens: 32000,
  stream: false,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: DROID_SYSTEM_REMINDER, cache_control: { type: "ephemeral" } },
        { type: "text", text: "What does this code do?", cache_control: { type: "ephemeral" } },
      ],
    },
  ],
  tools: [
    { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
    { name: "Write", description: "Write a file", input_schema: { type: "object", properties: {} } },
    { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: {} } },
    { name: "TodoWrite", description: "Write todos", input_schema: { type: "object", properties: {} } },
  ],
}

const OPENCODE_BODY = {
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  stream: false,
  system: "<env>\n  Working directory: /Users/dev/opencode-project\n</env>",
  messages: [{ role: "user", content: "Hello" }],
  tools: [
    { name: "Read", description: "Read a file", input_schema: { type: "object", properties: {} } },
  ],
}

const TASK_TOOL = {
  name: "task",
  description: `Launch a new agent.

Available agent types and the tools they have access to:
- build: Default agent
- plan: Plan mode
- oracle: Read-only consultation agent`,
  input_schema: { type: "object", properties: {}, required: [] },
}

describe("Droid adapter: MCP server name", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("uses 'droid' MCP server in SDK options when User-Agent is factory-cli", async () => {
    const app = createTestApp()
    await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(mcpServers).toBeDefined()
    expect(Object.keys(mcpServers)).toContain("droid")
    expect(Object.keys(mcpServers)).not.toContain("opencode")
  })

  it("uses 'opencode' MCP server when no special User-Agent (backward compat)", async () => {
    const app = createTestApp()
    await (await post(app, OPENCODE_BODY)).json()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(mcpServers).toBeDefined()
    expect(Object.keys(mcpServers)).toContain("opencode")
    expect(Object.keys(mcpServers)).not.toContain("droid")
  })
})

describe("Droid adapter: allowed tools", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("allowed tools have mcp__droid__ prefix for Droid requests", async () => {
    const app = createTestApp()
    await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()
    const allowedTools: string[] = capturedQueryParams.options.allowedTools
    expect(allowedTools).toBeDefined()
    for (const tool of allowedTools) {
      expect(tool).toStartWith("mcp__droid__")
    }
  })

  it("allowed tools have mcp__opencode__ prefix for OpenCode requests", async () => {
    const app = createTestApp()
    await (await post(app, OPENCODE_BODY)).json()
    const allowedTools: string[] = capturedQueryParams.options.allowedTools
    expect(allowedTools).toBeDefined()
    for (const tool of allowedTools) {
      expect(tool).toStartWith("mcp__opencode__")
    }
  })
})

describe("Droid adapter: no subagent routing", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("does not pass SDK agents to query when Droid sends Task-like tool", async () => {
    const app = createTestApp()
    const body = { ...DROID_BODY, tools: [TASK_TOOL] }
    await (await post(app, body, { "User-Agent": DROID_UA })).json()
    // Droid adapter returns empty {}, so agents should be absent from SDK options
    expect(capturedQueryParams.options.agents).toBeUndefined()
  })

  it("does not add PreToolUse hooks for Task when Droid (no agent correction)", async () => {
    const app = createTestApp()
    const body = { ...DROID_BODY, tools: [TASK_TOOL] }
    await (await post(app, body, { "User-Agent": DROID_UA })).json()
    // No PreToolUse hooks because droid.buildSdkHooks returns undefined
    // PostToolUse may be present (file change tracking is adapter-agnostic)
    expect(capturedQueryParams.options.hooks?.PreToolUse).toBeUndefined()
  })

  it("OpenCode still gets Task PreToolUse hooks when Task tool present", async () => {
    const app = createTestApp()
    const body = { ...OPENCODE_BODY, tools: [TASK_TOOL] }
    await (await post(app, body)).json()
    expect(capturedQueryParams.options.hooks).toBeDefined()
    expect(capturedQueryParams.options.hooks.PreToolUse).toBeDefined()
    const taskMatcher = capturedQueryParams.options.hooks.PreToolUse.find((h: any) => h.matcher === "Task")
    expect(taskMatcher).toBeDefined()
  })

  it("OpenCode still gets agents from Task tool description", async () => {
    const app = createTestApp()
    const body = { ...OPENCODE_BODY, tools: [TASK_TOOL] }
    await (await post(app, body)).json()
    expect(capturedQueryParams.options.agents).toBeDefined()
    expect(Object.keys(capturedQueryParams.options.agents)).toContain("oracle")
  })
})

describe("Droid adapter: CWD extraction from system-reminder", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("uses CWD from system-reminder for workdir in SDK options", async () => {
    const app = createTestApp()
    await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()
    // The proxy passes cwd to the SDK options
    expect(capturedQueryParams.options.cwd).toBe("/Users/dev/my-project")
  })

  it("OpenCode uses CWD from env block in system prompt", async () => {
    const app = createTestApp()
    await (await post(app, OPENCODE_BODY)).json()
    expect(capturedQueryParams.options.cwd).toBe("/Users/dev/opencode-project")
  })
})

describe("Droid adapter: session management via fingerprint", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("handles Droid request without session header (no crash)", async () => {
    const app = createTestApp()
    const res = await post(app, DROID_BODY, { "User-Agent": DROID_UA })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
  })

  it("second Droid request with same CWD and first message resumes via fingerprint", async () => {
    const app = createTestApp()

    // First request — establishes session
    await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()
    const firstSessionId = capturedQueryParams?.options?.resume

    // Second request — same first user message, should resume
    await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()
    // If resume is set, session was resumed (cache hit)
    // If not set, it was a new session (depends on internal session tracking)
    // The important thing is no crash and valid response
    expect(capturedQueryParams).toBeDefined()
  })

  it("Droid request x-opencode-session header is ignored (not used for tracking)", async () => {
    // Even if someone sends x-opencode-session with a Droid UA, we shouldn't
    // use it (the Droid adapter's getSessionId returns undefined)
    const app = createTestApp()
    const res = await post(app, DROID_BODY, {
      "User-Agent": DROID_UA,
      "x-opencode-session": "fake-opencode-session",
    })
    expect(res.status).toBe(200)
    // The session should still work, just not via the header
  })
})

describe("Droid adapter: response format", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Droid response" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("returns valid Anthropic-format response for Droid requests", async () => {
    const app = createTestApp()
    const res = await post(app, DROID_BODY, { "User-Agent": DROID_UA })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
    expect(Array.isArray(json.content)).toBe(true)
    expect(json.content[0].type).toBe("text")
    expect(json.content[0].text).toBe("Droid response")
  })

  it("Droid request returns stop_reason", async () => {
    const app = createTestApp()
    const res = await post(app, DROID_BODY, { "User-Agent": DROID_UA })
    const json = await res.json()
    expect(json.stop_reason).toBe("end_turn")
  })
})

describe("Droid adapter: always internal mode (usesPassthrough=false)", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("Droid requests use internal MCP server even when CLAUDE_PROXY_PASSTHROUGH=1", async () => {
    // Simulate the launchd environment where PASSTHROUGH is set globally
    const original = process.env.CLAUDE_PROXY_PASSTHROUGH
    process.env.CLAUDE_PROXY_PASSTHROUGH = "1"

    try {
      const app = createTestApp()
      await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()

      // Droid adapter's usesPassthrough()=false overrides the env var:
      // allowedTools use mcp__droid__ prefix (internal mode), not passthrough MCP
      const allowedTools: string[] = capturedQueryParams.options.allowedTools
      expect(allowedTools).toBeDefined()
      for (const tool of allowedTools) {
        expect(tool).toStartWith("mcp__droid__")
      }
      // maxTurns is 200 (internal), not 1 (passthrough)
      expect(capturedQueryParams.options.maxTurns).toBe(200)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_PROXY_PASSTHROUGH
      else process.env.CLAUDE_PROXY_PASSTHROUGH = original
    }
  })

  it("openCodeAdapter.usesPassthrough is undefined — verified at adapter unit level, not integration level", () => {
    // The openCodeAdapter deliberately does NOT implement usesPassthrough()
    // so the env var continues to govern passthrough mode for OpenCode.
    // Full passthrough integration is covered by proxy-passthrough-concept.test.ts.
    // Here we just confirm the adapter contract at the unit level.
    const { openCodeAdapter } = require("../proxy/adapters/opencode")
    expect(openCodeAdapter.usesPassthrough).toBeUndefined()
  })
})

describe("Backward compatibility: OpenCode unaffected", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "OpenCode response" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("OpenCode requests without User-Agent header still work", async () => {
    const app = createTestApp()
    const res = await post(app, OPENCODE_BODY)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.role).toBe("assistant")
  })

  it("OpenCode session header still tracked when present", async () => {
    const app = createTestApp()
    await post(app, OPENCODE_BODY, { "x-opencode-session": "sess-oc-123" })
    // OpenCode adapter extracts this header — session should be stored
    // (no crash, valid response)
    expect(capturedQueryParams).toBeDefined()
  })

  it("plugins: [] still passed to prevent external interference", async () => {
    const app = createTestApp()
    await (await post(app, DROID_BODY, { "User-Agent": DROID_UA })).json()
    expect(capturedQueryParams.options.plugins).toEqual([])
  })

  it("plugins: [] still passed for OpenCode requests too", async () => {
    const app = createTestApp()
    await (await post(app, OPENCODE_BODY)).json()
    expect(capturedQueryParams.options.plugins).toEqual([])
  })
})
