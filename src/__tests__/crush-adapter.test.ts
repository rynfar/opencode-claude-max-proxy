/**
 * Tests for the Crush (Charm) agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { crushAdapter } from "../proxy/adapters/crush"

describe("crushAdapter — identity", () => {
  it("has name 'crush'", () => {
    expect(crushAdapter.name).toBe("crush")
  })
})

describe("crushAdapter.getSessionId", () => {
  it("always returns undefined — Crush sends no session header", () => {
    const ctx = {
      req: { header: () => "any-value" },
    }
    expect(crushAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("returns undefined even when x-opencode-session is present", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(crushAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("crushAdapter.extractWorkingDirectory", () => {
  it("always returns undefined — Crush does not embed CWD in request body", () => {
    expect(crushAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined even when system prompt is present", () => {
    const body = {
      system: [{ type: "text", text: "You are Crush, a powerful AI..." }],
      messages: [{ role: "user", content: "hello" }],
    }
    expect(crushAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined for any request body", () => {
    const body = {
      model: "claude-sonnet-4-6",
      stream: true,
      system: [{ type: "text", text: "You are Crush..." }],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "<system_reminder>todo list empty</system_reminder>" },
          { type: "text", text: "Read src/proxy/server.ts" },
        ],
      }],
      tools: [
        { name: "bash", description: "Run a command" },
        { name: "view", description: "View a file" },
      ],
    }
    expect(crushAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })
})

describe("crushAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(crushAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array of text blocks", () => {
    const content = [
      { type: "text", text: "<system_reminder>todo list empty</system_reminder>" },
      { type: "text", text: "Say hello" },
    ]
    const result = crushAdapter.normalizeContent(content)
    expect(result).toContain("system_reminder")
    expect(result).toContain("Say hello")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = crushAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })

  it("handles non-string/array content", () => {
    expect(crushAdapter.normalizeContent(null as any)).toBe("null")
  })
})

describe("crushAdapter tool configuration", () => {
  it("getBlockedBuiltinTools includes SDK capitalized tool names", () => {
    const blocked = crushAdapter.getBlockedBuiltinTools()
    // Crush uses lowercase (bash, edit, write) — these won't be blocked.
    // SDK built-ins (Bash, Edit, Write) ARE blocked — they'd conflict.
    expect(blocked).toContain("Read")
    expect(blocked).toContain("Write")
    expect(blocked).toContain("Edit")
    expect(blocked).toContain("Bash")
    expect(blocked).toContain("Glob")
    expect(blocked).toContain("Grep")
  })

  it("getBlockedBuiltinTools does NOT include Crush's lowercase tool names", () => {
    const blocked = crushAdapter.getBlockedBuiltinTools()
    // Crush's actual tools are lowercase — they should NOT be blocked
    expect(blocked).not.toContain("bash")
    expect(blocked).not.toContain("edit")
    expect(blocked).not.toContain("write")
    expect(blocked).not.toContain("view")
    expect(blocked).not.toContain("grep")
  })

  it("getAgentIncompatibleTools includes Claude-Code-only tools", () => {
    const incompatible = crushAdapter.getAgentIncompatibleTools()
    expect(incompatible).toContain("EnterPlanMode")
    expect(incompatible).toContain("ExitPlanMode")
    // ToolSearch is intentionally NOT incompatible — it is used internally by the SDK
    // for deferred tool loading and must not be blocked.
    expect(incompatible).not.toContain("ToolSearch")
  })

  it("getMcpServerName returns 'crush'", () => {
    expect(crushAdapter.getMcpServerName()).toBe("crush")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(crushAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("getAllowedMcpTools all have mcp__crush__ prefix", () => {
    for (const tool of crushAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__crush__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = crushAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__crush__read")
    expect(tools).toContain("mcp__crush__write")
    expect(tools).toContain("mcp__crush__edit")
    expect(tools).toContain("mcp__crush__bash")
    expect(tools).toContain("mcp__crush__glob")
    expect(tools).toContain("mcp__crush__grep")
  })
})

describe("crushAdapter.buildSdkAgents", () => {
  it("always returns empty object — Crush uses its own 'agent' tool for subagents", () => {
    const body = {
      tools: [{ name: "agent", description: "Launch a subagent" }],
    }
    expect(crushAdapter.buildSdkAgents!(body, [])).toEqual({})
  })

  it("returns empty for any body", () => {
    expect(crushAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("crushAdapter.buildSdkHooks", () => {
  it("always returns undefined — Crush handles tool execution itself", () => {
    expect(crushAdapter.buildSdkHooks!({}, {})).toBeUndefined()
    expect(crushAdapter.buildSdkHooks!({}, { agent: {} })).toBeUndefined()
  })
})

describe("crushAdapter.buildSystemContextAddendum", () => {
  it("always returns empty string", () => {
    expect(crushAdapter.buildSystemContextAddendum!({}, {})).toBe("")
    expect(crushAdapter.buildSystemContextAddendum!({}, { agent: {} })).toBe("")
  })
})

describe("crushAdapter.usesPassthrough", () => {
  it("is not defined — defers to CLAUDE_PROXY_PASSTHROUGH env var", () => {
    // Crush handles its own tool execution loop (standard Anthropic tool_use cycle)
    // so passthrough mode is correct for Crush. The env var (PASSTHROUGH=1 in
    // the launchd service) already sets this correctly — no override needed.
    expect(crushAdapter.usesPassthrough).toBeUndefined()
  })
})
