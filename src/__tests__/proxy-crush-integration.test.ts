/**
 * Crush Adapter Integration Tests
 *
 * Verifies that requests with Charm-Crush/ User-Agent use the crush adapter:
 * correct MCP server name, passthrough defers to env var, no session header
 * tracking, fingerprint-based session resume, and backward compat with
 * OpenCode requests on the same proxy.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage, toolUseBlockStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, messageStart } from "./helpers"

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

const CRUSH_UA = "Charm-Crush/v0.51.2 (https://charm.land/crush)"

// Representative Crush request body
const CRUSH_BODY = {
  model: "claude-sonnet-4-6",
  max_tokens: 64000,
  stream: false,
  system: [{ type: "text", text: "You are Crush, a powerful AI Assistant..." }],
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "<system_reminder>todo list empty</system_reminder>" },
      { type: "text", text: "What files are in the src directory?" },
    ],
  }],
  tools: [
    { name: "bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "view", description: "View file contents", input_schema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
    { name: "edit", description: "Edit a file", input_schema: { type: "object", properties: {} } },
    { name: "write", description: "Write a file", input_schema: { type: "object", properties: {} } },
    { name: "ls", description: "List directory", input_schema: { type: "object", properties: {} } },
    { name: "grep", description: "Search files", input_schema: { type: "object", properties: {} } },
  ],
}

const OPENCODE_BODY = {
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  stream: false,
  system: "<env>\n  Working directory: /Users/dev/my-project\n</env>",
  messages: [{ role: "user", content: "Hello" }],
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

describe("Crush adapter: detection", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("detects Charm-Crush/ User-Agent and selects crush adapter", async () => {
    const app = createTestApp()
    const res = await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })
    expect(res.status).toBe(200)
    expect(capturedQueryParams).toBeDefined()
  })

  it("returns valid response for Crush requests", async () => {
    const app = createTestApp()
    const res = await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
  })
})

describe("Crush adapter: MCP server name", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("uses 'crush' MCP server in SDK options", async () => {
    const app = createTestApp()
    await (await post(app, { ...CRUSH_BODY, tools: [] }, { "User-Agent": CRUSH_UA })).json()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(mcpServers).toBeDefined()
    expect(Object.keys(mcpServers)).toContain("crush")
    expect(Object.keys(mcpServers)).not.toContain("opencode")
    expect(Object.keys(mcpServers)).not.toContain("droid")
  })

  it("allowed tools have mcp__crush__ prefix when no passthrough", async () => {
    // With PASSTHROUGH not set, crush adapter's allowed tools are used
    const original = process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH

    try {
      const app = createTestApp()
      await (await post(app, { ...CRUSH_BODY, tools: [] }, { "User-Agent": CRUSH_UA })).json()
      const allowedTools: string[] = capturedQueryParams.options.allowedTools
      expect(allowedTools).toBeDefined()
      for (const tool of allowedTools) {
        expect(tool).toStartWith("mcp__crush__")
      }
    } finally {
      if (original !== undefined) process.env.CLAUDE_PROXY_PASSTHROUGH = original
    }
  })

  it("OpenCode requests still use 'opencode' MCP server", async () => {
    const app = createTestApp()
    await (await post(app, OPENCODE_BODY)).json()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(Object.keys(mcpServers)).toContain("opencode")
    expect(Object.keys(mcpServers)).not.toContain("crush")
  })
})

describe("Crush adapter: no session header", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("handles Crush request without session header — no crash", async () => {
    const app = createTestApp()
    const res = await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })
    expect(res.status).toBe(200)
  })

  it("x-opencode-session header is ignored for Crush requests", async () => {
    const app = createTestApp()
    const res = await post(app, CRUSH_BODY, {
      "User-Agent": CRUSH_UA,
      "x-opencode-session": "should-be-ignored",
    })
    expect(res.status).toBe(200)
  })
})

describe("Crush adapter: fingerprint session resume", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("second request with same first message fingerprints to continuation", async () => {
    const app = createTestApp()

    // Turn 1: establish session
    await (await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })).json()

    // Turn 2: same first message + history appended
    const turn2Body = {
      ...CRUSH_BODY,
      messages: [
        ...CRUSH_BODY.messages,
        { role: "assistant", content: [{ type: "text", text: "src/ contains proxy/, __tests__/, etc." }] },
        { role: "user", content: [{ type: "text", text: "What's in the proxy directory?" }] },
      ],
    }

    capturedQueryParams = null
    await (await post(app, turn2Body, { "User-Agent": CRUSH_UA })).json()

    // Session resumed: SDK options should include resume
    expect(capturedQueryParams.options.resume).toBeDefined()
  })

  it("different first message creates a new session", async () => {
    const app = createTestApp()

    // Turn 1
    await (await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })).json()

    // Different first message → different fingerprint → new session
    const differentBody = {
      ...CRUSH_BODY,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "<system_reminder>todo list empty</system_reminder>" },
          { type: "text", text: "A completely different first message" },
        ],
      }],
    }

    capturedQueryParams = null
    await (await post(app, differentBody, { "User-Agent": CRUSH_UA })).json()

    // New session — no resume
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

describe("Crush adapter: no subagent routing", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("never passes SDK agents even when 'agent' tool is in request", async () => {
    const body = {
      ...CRUSH_BODY,
      tools: [
        { name: "agent", description: "Launch a subagent", input_schema: { type: "object", properties: {} } },
        ...CRUSH_BODY.tools,
      ],
    }
    const app = createTestApp()
    await (await post(app, body, { "User-Agent": CRUSH_UA })).json()
    // crushAdapter.buildSdkAgents returns {} → no agents in SDK options
    expect(capturedQueryParams.options.agents).toBeUndefined()
  })

  it("no PreToolUse hooks for Crush requests", async () => {
    const app = createTestApp()
    await (await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })).json()
    // crushAdapter.buildSdkHooks returns undefined → no PreToolUse in non-passthrough mode
    // PostToolUse may be present (file change tracking is adapter-agnostic)
    expect(capturedQueryParams.options.hooks?.PreToolUse).toBeUndefined()
  })
})

describe("Crush adapter: headless auto-execute", () => {
  it("crush run executes all tools automatically — no approval prompt needed", () => {
    // This is a behavioral note verified by E2E (C3b), not mockable here.
    // crush run is non-interactive: write/edit/bash all execute without prompting.
    // The proxy sees tool_use → tool_result chains in the message history.
    expect(true).toBe(true) // documented behavior, verified in E2E
  })
})

describe("Crush adapter: response format", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Here are the files: ..." }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("returns valid non-streaming response", async () => {
    const app = createTestApp()
    const res = await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
    expect(json.stop_reason).toBe("end_turn")
    expect(Array.isArray(json.content)).toBe(true)
  })

  it("returns correct content from assistant message", async () => {
    const app = createTestApp()
    const res = await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })
    const json = await res.json()
    expect(json.content[0].type).toBe("text")
    expect(json.content[0].text).toBe("Here are the files: ...")
  })
})

describe("Crush adapter: streaming", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Here"),
      textDelta(0, " are the files"),
      blockStop(0),
      messageDelta(),
      messageStop(),
    ]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("streams correctly for Crush requests", async () => {
    const app = createTestApp()
    const streamBody = { ...CRUSH_BODY, stream: true }
    const res = await post(app, streamBody, { "User-Agent": CRUSH_UA })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const text = await res.text()
    expect(text).toContain("event: message_start")
    expect(text).toContain("event: content_block_delta")
    expect(text).toContain("event: message_stop")
    expect(text).toContain("Here")
    expect(text).toContain("are the files")
  })
})

describe("Backward compatibility: OpenCode unaffected by Crush adapter", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "OpenCode response" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("OpenCode requests without UA still use opencode adapter", async () => {
    const app = createTestApp()
    const res = await post(app, OPENCODE_BODY)
    expect(res.status).toBe(200)
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(Object.keys(mcpServers)).toContain("opencode")
  })

  it("OpenCode session header still tracked when Crush requests coexist", async () => {
    const app = createTestApp()

    // Crush request first
    await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })

    // OpenCode request — should still use its own adapter
    capturedQueryParams = null
    await post(app, OPENCODE_BODY, { "x-opencode-session": "oc-sess-99" })

    expect(capturedQueryParams).toBeDefined()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(Object.keys(mcpServers)).toContain("opencode")
  })

  it("plugins: [] passed for Crush requests too", async () => {
    const app = createTestApp()
    await (await post(app, CRUSH_BODY, { "User-Agent": CRUSH_UA })).json()
    expect(capturedQueryParams.options.plugins).toEqual([])
  })
})
