/**
 * Tests for the Droid (Factory AI) agent adapter.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { droidAdapter } from "../proxy/adapters/droid"

// Actual system-reminder content captured from a live Droid session
const DROID_SYSTEM_REMINDER = `<system-reminder>

User system info (darwin 25.3.0)
Model: claude-sonnet-4-5-20250514
Today's date: 2026-03-28

# The commands below were executed at the start of all sessions to gather context about the environment.

% pwd
/Users/rynfar/repos/my-project

% ls
src
package.json
README.md

% git rev-parse --abbrev-ref HEAD
main

</system-reminder>`

function makeDroidBody(cwd: string = "/Users/rynfar/repos/my-project"): any {
  return {
    model: "claude-sonnet-4-5-20250514",
    max_tokens: 32000,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: DROID_SYSTEM_REMINDER.replace("/Users/rynfar/repos/my-project", cwd),
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: "Do something useful",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
      { name: "Write", description: "Write a file", input_schema: { type: "object" } },
      { name: "Bash", description: "Run a command", input_schema: { type: "object" } },
    ],
  }
}

describe("droidAdapter — identity", () => {
  it("has name 'droid'", () => {
    expect(droidAdapter.name).toBe("droid")
  })
})

describe("droidAdapter.getSessionId", () => {
  it("always returns undefined (no session header from Droid)", () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === "x-factory-session") return "factory-abc"
          if (name === "x-opencode-session") return "opencode-xyz"
          return undefined
        },
      },
    }
    expect(droidAdapter.getSessionId(mockContext as any)).toBeUndefined()
  })

  it("returns undefined even when all headers are present", () => {
    const mockContext = {
      req: {
        header: () => "some-value",
      },
    }
    expect(droidAdapter.getSessionId(mockContext as any)).toBeUndefined()
  })
})

describe("droidAdapter.extractWorkingDirectory", () => {
  it("extracts CWD from system-reminder in first user message", () => {
    const body = makeDroidBody("/Users/rynfar/repos/my-project")
    expect(droidAdapter.extractWorkingDirectory(body)).toBe("/Users/rynfar/repos/my-project")
  })

  it("extracts different CWD paths correctly", () => {
    expect(droidAdapter.extractWorkingDirectory(makeDroidBody("/home/user/code"))).toBe("/home/user/code")
    expect(droidAdapter.extractWorkingDirectory(makeDroidBody("/opt/myapp"))).toBe("/opt/myapp")
    expect(droidAdapter.extractWorkingDirectory(makeDroidBody("/Users/dev/my project with spaces"))).toBe("/Users/dev/my project with spaces")
  })

  it("returns undefined when no system-reminder present", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello, help me" }] },
      ],
    }
    expect(droidAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined when system-reminder has no pwd command", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{
            type: "text",
            text: "<system-reminder>\nUser system info\n</system-reminder>",
          }],
        },
      ],
    }
    expect(droidAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined when messages is missing", () => {
    expect(droidAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined when messages is not an array", () => {
    expect(droidAdapter.extractWorkingDirectory({ messages: "bad" })).toBeUndefined()
  })

  it("skips assistant messages, only looks at user messages", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: DROID_SYSTEM_REMINDER }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "just a question" }],
        },
      ],
    }
    expect(droidAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("finds CWD in the first user message even when multiple messages exist", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: DROID_SYSTEM_REMINDER },
            { type: "text", text: "First question" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "text", text: "Follow up" }] },
      ],
    }
    expect(droidAdapter.extractWorkingDirectory(body)).toBe("/Users/rynfar/repos/my-project")
  })

  it("handles string content in messages gracefully (no crash)", () => {
    const body = {
      messages: [
        { role: "user", content: "plain string content" },
      ],
    }
    expect(droidAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })
})

describe("droidAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(droidAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array content to text", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ]
    expect(droidAdapter.normalizeContent(content)).toBe("hello\n world")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "foo.ts" } },
    ]
    const result = droidAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("Read")
  })

  it("converts non-string/array content to string", () => {
    expect(droidAdapter.normalizeContent(42 as any)).toBe("42")
  })
})

describe("droidAdapter tool configuration", () => {
  it("getBlockedBuiltinTools includes standard SDK tools", () => {
    const blocked = droidAdapter.getBlockedBuiltinTools()
    expect(blocked).toContain("Read")
    expect(blocked).toContain("Write")
    expect(blocked).toContain("Edit")
    expect(blocked).toContain("Bash")
    expect(blocked).toContain("Glob")
    expect(blocked).toContain("Grep")
  })

  it("getAgentIncompatibleTools includes Claude-Code-only tools", () => {
    const incompatible = droidAdapter.getAgentIncompatibleTools()
    expect(incompatible).toContain("EnterPlanMode")
    expect(incompatible).toContain("ExitPlanMode")
    // ToolSearch is intentionally NOT incompatible — it is used internally by the SDK
    // for deferred tool loading and must not be blocked.
    expect(incompatible).not.toContain("ToolSearch")
  })

  it("getMcpServerName returns 'droid'", () => {
    expect(droidAdapter.getMcpServerName()).toBe("droid")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(droidAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("getAllowedMcpTools all have mcp__droid__ prefix", () => {
    for (const tool of droidAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__droid__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = droidAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__droid__read")
    expect(tools).toContain("mcp__droid__write")
    expect(tools).toContain("mcp__droid__edit")
    expect(tools).toContain("mcp__droid__bash")
    expect(tools).toContain("mcp__droid__glob")
    expect(tools).toContain("mcp__droid__grep")
  })
})

describe("droidAdapter.buildSdkAgents", () => {
  it("always returns empty object — Droid manages subagents internally", () => {
    const body = makeDroidBody()
    expect(droidAdapter.buildSdkAgents!(body, ["mcp__droid__read"])).toEqual({})
  })

  it("returns empty even with Task-like tools in the body", () => {
    const body = {
      tools: [{
        name: "task",
        description: "Available agent types:\n- build: default\n- plan: plan mode",
        input_schema: { type: "object" },
      }],
    }
    expect(droidAdapter.buildSdkAgents!(body, [])).toEqual({})
  })

  it("returns empty for empty body", () => {
    expect(droidAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("droidAdapter.buildSdkHooks", () => {
  it("always returns undefined — no hook-based agent correction needed", () => {
    const sdkAgents = { oracle: {}, explore: {} }
    expect(droidAdapter.buildSdkHooks!({}, sdkAgents)).toBeUndefined()
  })

  it("returns undefined for empty agents", () => {
    expect(droidAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })
})

describe("droidAdapter.buildSystemContextAddendum", () => {
  it("always returns empty string — no extra context for Droid", () => {
    const sdkAgents = { oracle: {}, explore: {} }
    expect(droidAdapter.buildSystemContextAddendum!({}, sdkAgents)).toBe("")
  })

  it("returns empty string for empty agents", () => {
    expect(droidAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

describe("droidAdapter.usesPassthrough", () => {
  // Save/restore env vars per test so global state doesn't leak.
  let savedMP: string | undefined
  let savedCP: string | undefined
  beforeEach(() => {
    savedMP = process.env.MERIDIAN_PASSTHROUGH
    savedCP = process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })
  afterEach(() => {
    if (savedMP !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedMP
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedCP !== undefined) process.env.CLAUDE_PROXY_PASSTHROUGH = savedCP
    else delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  it("returns false by default (no env var) — internal mode is the safe default", () => {
    expect(droidAdapter.usesPassthrough!()).toBe(false)
  })

  it("returns true when MERIDIAN_PASSTHROUGH=1 — opt-in unlock", () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    expect(droidAdapter.usesPassthrough!()).toBe(true)
  })

  it("respects CLAUDE_PROXY_PASSTHROUGH as an alias", () => {
    process.env.CLAUDE_PROXY_PASSTHROUGH = "true"
    expect(droidAdapter.usesPassthrough!()).toBe(true)
  })

  it("returns false for explicit MERIDIAN_PASSTHROUGH=0", () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    expect(droidAdapter.usesPassthrough!()).toBe(false)
  })

  it("returns false for unrecognized env values", () => {
    process.env.MERIDIAN_PASSTHROUGH = "maybe"
    expect(droidAdapter.usesPassthrough!()).toBe(false)
  })
})
