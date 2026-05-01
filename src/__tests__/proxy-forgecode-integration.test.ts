/**
 * ForgeCode Adapter Integration Tests
 *
 * Verifies that requests with x-meridian-agent: forgecode header use the
 * forgecode adapter: correct MCP server name, fingerprint-based session resume,
 * no session header tracking, streaming support, and backward compat with
 * OpenCode requests on the same proxy.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { assistantMessage, textBlockStart, textDelta, blockStop, messageDelta, messageStop, messageStart } from "./helpers"

// Use a real, existent directory so server.ts:resolveSdkWorkingDirectory's
// existsSync check passes — otherwise the SDK cwd silently falls back to
// process.cwd() (the fix for issue #381).
const FORGECODE_PROJECT_DIR = join(tmpdir(), "meridian-test-forgecode-project")
mkdirSync(FORGECODE_PROJECT_DIR, { recursive: true })

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

const FORGECODE_HEADERS = { "x-meridian-agent": "forgecode" }

// Representative ForgeCode request body
const FORGECODE_BODY = {
  model: "claude-sonnet-4-6",
  max_tokens: 64000,
  stream: false,
  system: [
    {
      type: "text",
      text: `<system_information>\n<operating_system>Darwin</operating_system>\n<current_working_directory>${FORGECODE_PROJECT_DIR}</current_working_directory>\n<default_shell>/bin/zsh</default_shell>\n<home_directory>/Users/dev</home_directory>\n</system_information>`,
    },
  ],
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "What files are in the src directory?" },
    ],
  }],
  tools: [
    { name: "read", description: "Read file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "write", description: "Write file", input_schema: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } },
    { name: "patch", description: "Single edit", input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["file_path", "old_string", "new_string"] } },
    { name: "multi_patch", description: "Multiple edits", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "shell", description: "Execute shell command", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "fs_search", description: "Search files", input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  ],
}

const OPENCODE_BODY = {
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  stream: false,
  system: `<env>\n  Working directory: ${FORGECODE_PROJECT_DIR}\n</env>`,
  messages: [{ role: "user", content: "Hello" }],
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

describe("ForgeCode adapter: detection via x-meridian-agent", () => {
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

  it("detects x-meridian-agent: forgecode and selects forgecode adapter", async () => {
    const app = createTestApp()
    const res = await post(app, FORGECODE_BODY, FORGECODE_HEADERS)
    expect(res.status).toBe(200)
    expect(capturedQueryParams).toBeDefined()
  })

  it("returns valid response for ForgeCode requests", async () => {
    const app = createTestApp()
    const res = await post(app, FORGECODE_BODY, FORGECODE_HEADERS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
  })

  it("header override is case-insensitive", async () => {
    const app = createTestApp()
    const res = await post(app, FORGECODE_BODY, { "x-meridian-agent": "ForgeCode" })
    // ForgeCode is lowercased by detection — "forgecode" is in the map
    expect(res.status).toBe(200)
  })
})

describe("ForgeCode adapter: MCP server name", () => {
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

  it("uses 'forgecode' MCP server in SDK options", async () => {
    const app = createTestApp()
    await (await post(app, { ...FORGECODE_BODY, tools: [] }, FORGECODE_HEADERS)).json()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(mcpServers).toBeDefined()
    expect(Object.keys(mcpServers)).toContain("forgecode")
    expect(Object.keys(mcpServers)).not.toContain("opencode")
    expect(Object.keys(mcpServers)).not.toContain("droid")
  })

  it("allowed tools have mcp__forgecode__ prefix when no passthrough", async () => {
    const original = process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH

    try {
      const app = createTestApp()
      await (await post(app, { ...FORGECODE_BODY, tools: [] }, FORGECODE_HEADERS)).json()
      const allowedTools: string[] = capturedQueryParams.options.allowedTools
      expect(allowedTools).toBeDefined()
      for (const tool of allowedTools) {
        expect(tool).toStartWith("mcp__forgecode__")
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
    expect(Object.keys(mcpServers)).not.toContain("forgecode")
  })
})

describe("ForgeCode adapter: no session header", () => {
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

  it("handles ForgeCode request without session header — no crash", async () => {
    const app = createTestApp()
    const res = await post(app, FORGECODE_BODY, FORGECODE_HEADERS)
    expect(res.status).toBe(200)
  })

  it("x-opencode-session header is ignored for ForgeCode requests", async () => {
    const app = createTestApp()
    const res = await post(app, FORGECODE_BODY, {
      ...FORGECODE_HEADERS,
      "x-opencode-session": "should-be-ignored",
    })
    expect(res.status).toBe(200)
  })
})

describe("ForgeCode adapter: fingerprint session resume", () => {
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
    await (await post(app, FORGECODE_BODY, FORGECODE_HEADERS)).json()

    // Turn 2: same first message + history appended
    const turn2Body = {
      ...FORGECODE_BODY,
      messages: [
        ...FORGECODE_BODY.messages,
        { role: "assistant", content: [{ type: "text", text: "src/ contains proxy/, __tests__/, etc." }] },
        { role: "user", content: [{ type: "text", text: "What's in the proxy directory?" }] },
      ],
    }

    capturedQueryParams = null
    await (await post(app, turn2Body, FORGECODE_HEADERS)).json()

    // Session resumed: SDK options should include resume
    expect(capturedQueryParams.options.resume).toBeDefined()
  })

  it("different first message creates a new session", async () => {
    const app = createTestApp()

    // Turn 1
    await (await post(app, FORGECODE_BODY, FORGECODE_HEADERS)).json()

    // Different first message → different fingerprint → new session
    const differentBody = {
      ...FORGECODE_BODY,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "A completely different first message" },
        ],
      }],
    }

    capturedQueryParams = null
    await (await post(app, differentBody, FORGECODE_HEADERS)).json()

    // New session — no resume
    expect(capturedQueryParams.options.resume).toBeUndefined()
  })
})

describe("ForgeCode adapter: no subagent routing", () => {
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

  it("never passes SDK agents even when 'task' tool is in request", async () => {
    const body = {
      ...FORGECODE_BODY,
      tools: [
        { name: "task", description: "Delegate to sub-agent", input_schema: { type: "object", properties: {} } },
        ...FORGECODE_BODY.tools,
      ],
    }
    const app = createTestApp()
    await (await post(app, body, FORGECODE_HEADERS)).json()
    expect(capturedQueryParams.options.agents).toBeUndefined()
  })

  it("no PreToolUse hooks for ForgeCode requests", async () => {
    const app = createTestApp()
    await (await post(app, FORGECODE_BODY, FORGECODE_HEADERS)).json()
    expect(capturedQueryParams.options.hooks?.PreToolUse).toBeUndefined()
  })
})

describe("ForgeCode adapter: response format", () => {
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
    const res = await post(app, FORGECODE_BODY, FORGECODE_HEADERS)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.type).toBe("message")
    expect(json.role).toBe("assistant")
    expect(json.stop_reason).toBe("end_turn")
    expect(Array.isArray(json.content)).toBe(true)
  })

  it("returns correct content from assistant message", async () => {
    const app = createTestApp()
    const res = await post(app, FORGECODE_BODY, FORGECODE_HEADERS)
    const json = await res.json()
    expect(json.content[0].type).toBe("text")
    expect(json.content[0].text).toBe("Here are the files: ...")
  })
})

describe("ForgeCode adapter: streaming", () => {
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

  it("streams correctly for ForgeCode requests", async () => {
    const app = createTestApp()
    const streamBody = { ...FORGECODE_BODY, stream: true }
    const res = await post(app, streamBody, FORGECODE_HEADERS)

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

describe("ForgeCode adapter: CWD extraction through proxy", () => {
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

  it("extracts CWD from ForgeCode system prompt XML tag", async () => {
    const app = createTestApp()
    await (await post(app, FORGECODE_BODY, FORGECODE_HEADERS)).json()
    // The proxy extracts CWD from the adapter and uses it for fingerprinting
    // and as the working directory for the SDK query
    expect(capturedQueryParams).toBeDefined()
    expect(capturedQueryParams.options.cwd).toBe(FORGECODE_PROJECT_DIR)
  })
})

describe("Backward compatibility: OpenCode unaffected by ForgeCode adapter", () => {
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

  it("OpenCode session header still tracked when ForgeCode requests coexist", async () => {
    const app = createTestApp()

    // ForgeCode request first
    await post(app, FORGECODE_BODY, FORGECODE_HEADERS)

    // OpenCode request — should still use its own adapter
    capturedQueryParams = null
    await post(app, OPENCODE_BODY, { "x-opencode-session": "oc-sess-99" })

    expect(capturedQueryParams).toBeDefined()
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(Object.keys(mcpServers)).toContain("opencode")
  })

  it("plugins: [] passed for ForgeCode requests too", async () => {
    const app = createTestApp()
    await (await post(app, FORGECODE_BODY, FORGECODE_HEADERS)).json()
    expect(capturedQueryParams.options.plugins).toEqual([])
  })
})
