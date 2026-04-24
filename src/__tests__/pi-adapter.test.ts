/**
 * Tests for the Pi coding agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { piAdapter } from "../proxy/adapters/pi"

describe("piAdapter — identity", () => {
  it("has name 'pi'", () => {
    expect(piAdapter.name).toBe("pi")
  })
})

describe("piAdapter.getSessionId", () => {
  it("always returns undefined — Pi sends no session header", () => {
    const ctx = {
      req: { header: () => "any-value" },
    }
    expect(piAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("returns undefined even when x-opencode-session is present", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(piAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("piAdapter.extractWorkingDirectory", () => {
  it("extracts CWD from string system prompt", () => {
    const body = {
      system: "You are an expert coding assistant.\nCurrent working directory: /Users/test/project\nMore instructions here.",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("extracts CWD from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "You are an expert coding assistant." },
        { type: "text", text: "Current working directory: /tmp/my-repo" },
      ],
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/tmp/my-repo")
  })

  it("extracts CWD case-insensitively", () => {
    const body = {
      system: "current working directory: /home/user/project",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/home/user/project")
  })

  it("returns undefined when system prompt is missing", () => {
    expect(piAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined when system prompt has no CWD line", () => {
    const body = {
      system: "You are a helpful assistant. No directory info here.",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined for empty string system", () => {
    expect(piAdapter.extractWorkingDirectory({ system: "" })).toBeUndefined()
  })

  it("returns undefined for empty array system", () => {
    expect(piAdapter.extractWorkingDirectory({ system: [] })).toBeUndefined()
  })

  it("handles system array with non-text blocks", () => {
    const body = {
      system: [
        { type: "image", source: {} },
        { type: "text", text: "Current working directory: /opt/app" },
      ],
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/opt/app")
  })

  it("trims trailing whitespace from CWD", () => {
    const body = {
      system: "Current working directory: /Users/test/project   \nNext line",
    }
    expect(piAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })
})

describe("piAdapter.extractClientWorkingDirectory", () => {
  it("mirrors extractWorkingDirectory — returns the parsed CWD", () => {
    const body = {
      system: "You are an expert coding assistant.\nCurrent working directory: /Users/test/project",
    }
    expect(piAdapter.extractClientWorkingDirectory!(body)).toBe("/Users/test/project")
  })

  it("extracts from array system prompt", () => {
    const body = {
      system: [
        { type: "text", text: "System intro." },
        { type: "text", text: "Current working directory: /tmp/my-repo" },
      ],
    }
    expect(piAdapter.extractClientWorkingDirectory!(body)).toBe("/tmp/my-repo")
  })

  it("returns undefined when system prompt lacks the CWD line", () => {
    expect(
      piAdapter.extractClientWorkingDirectory!({ system: "no cwd line here" })
    ).toBeUndefined()
  })

  it("returns undefined when system prompt is missing", () => {
    expect(piAdapter.extractClientWorkingDirectory!({})).toBeUndefined()
  })

  it("returns the same value as extractWorkingDirectory for any body", () => {
    // This parity guarantee is load-bearing: the default resolution in
    // server.ts collapses the two paths for same-host clients. If they
    // diverged, buildCwdNote would emit a spurious <env> addendum.
    const bodies = [
      { system: "Current working directory: /a" },
      { system: [{ type: "text", text: "Current working directory: /b" }] },
      { system: "no directory here" },
      {},
    ]
    for (const body of bodies) {
      expect(piAdapter.extractClientWorkingDirectory!(body))
        .toBe(piAdapter.extractWorkingDirectory(body))
    }
  })
})

describe("piAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(piAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array of text blocks", () => {
    const content = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ]
    const result = piAdapter.normalizeContent(content)
    expect(result).toContain("First block")
    expect(result).toContain("Second block")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = piAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })

  it("handles null content", () => {
    expect(piAdapter.normalizeContent(null as any)).toBe("null")
  })
})

describe("piAdapter tool configuration", () => {
  it("getBlockedBuiltinTools includes SDK PascalCase tool names", () => {
    const blocked = piAdapter.getBlockedBuiltinTools()
    expect(blocked).toContain("Read")
    expect(blocked).toContain("Write")
    expect(blocked).toContain("Edit")
    expect(blocked).toContain("Bash")
    expect(blocked).toContain("Glob")
    expect(blocked).toContain("Grep")
  })

  it("getBlockedBuiltinTools does NOT include Pi's lowercase tool names", () => {
    const blocked = piAdapter.getBlockedBuiltinTools()
    expect(blocked).not.toContain("bash")
    expect(blocked).not.toContain("edit")
    expect(blocked).not.toContain("write")
    expect(blocked).not.toContain("read")
    expect(blocked).not.toContain("grep")
  })

  it("getAgentIncompatibleTools includes Claude-Code-only tools", () => {
    const incompatible = piAdapter.getAgentIncompatibleTools()
    expect(incompatible).toContain("EnterPlanMode")
    expect(incompatible).toContain("ExitPlanMode")
    // ToolSearch is intentionally NOT incompatible — it is used internally by the SDK
    // for deferred tool loading and must not be blocked.
    expect(incompatible).not.toContain("ToolSearch")
    expect(incompatible).toContain("CronCreate")
    expect(incompatible).toContain("EnterWorktree")
  })

  it("getMcpServerName returns 'pi'", () => {
    expect(piAdapter.getMcpServerName()).toBe("pi")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(piAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("getAllowedMcpTools all have mcp__pi__ prefix", () => {
    for (const tool of piAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__pi__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = piAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__pi__read")
    expect(tools).toContain("mcp__pi__write")
    expect(tools).toContain("mcp__pi__edit")
    expect(tools).toContain("mcp__pi__bash")
    expect(tools).toContain("mcp__pi__glob")
    expect(tools).toContain("mcp__pi__grep")
  })
})

describe("piAdapter.buildSdkAgents", () => {
  it("always returns empty object", () => {
    expect(piAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("piAdapter.buildSdkHooks", () => {
  it("always returns undefined", () => {
    expect(piAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })
})

describe("piAdapter.buildSystemContextAddendum", () => {
  it("always returns empty string", () => {
    expect(piAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

describe("piAdapter.usesPassthrough", () => {
  it("is not defined — defers to CLAUDE_PROXY_PASSTHROUGH env var", () => {
    expect(piAdapter.usesPassthrough).toBeUndefined()
  })
})

describe("piAdapter.extractFileChangesFromToolUse", () => {
  it("detects write with filePath", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("write", { filePath: "/tmp/test.ts", content: "hello" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects write with file_path fallback", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("write", { file_path: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects write with path fallback", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("write", { path: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/test.ts" }])
  })

  it("detects edit with filePath", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("edit", { filePath: "/tmp/test.ts" })
    expect(changes).toEqual([{ operation: "edited", path: "/tmp/test.ts" }])
  })

  it("detects bash commands with output redirects", () => {
    const changes = piAdapter.extractFileChangesFromToolUse!("bash", { command: "echo hello > /tmp/out.txt" })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]!.path).toBe("/tmp/out.txt")
  })

  it("returns empty for read tool", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("read", { filePath: "/tmp/test.ts" })).toEqual([])
  })

  it("returns empty for grep tool", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("grep", { pattern: "TODO" })).toEqual([])
  })

  it("returns empty for write with no path", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("write", { content: "hello" })).toEqual([])
  })

  it("returns empty for bash with no command", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("bash", {})).toEqual([])
  })

  it("returns empty for null input", () => {
    expect(piAdapter.extractFileChangesFromToolUse!("write", null)).toEqual([])
  })
})
