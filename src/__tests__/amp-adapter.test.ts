/**
 * Tests for the Amp agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { ampAdapter } from "../proxy/adapters/amp"

describe("ampAdapter — identity", () => {
  it("has name 'amp'", () => {
    expect(ampAdapter.name).toBe("amp")
  })

  it("getMcpServerName returns 'amp'", () => {
    expect(ampAdapter.getMcpServerName()).toBe("amp")
  })
})

describe("ampAdapter.getSessionId", () => {
  it("reads x-amp-thread-id header", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-amp-thread-id" ? "T-019d01b5-f70d-73ea-9445-f6d358f7213e" : undefined,
      },
    }
    expect(ampAdapter.getSessionId(ctx as any)).toBe("T-019d01b5-f70d-73ea-9445-f6d358f7213e")
  })

  it("returns undefined when header is absent", () => {
    const ctx = { req: { header: () => undefined } }
    expect(ampAdapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("does not fall back to other agents' headers", () => {
    const ctx = {
      req: {
        header: (name: string) =>
          name === "x-opencode-session" ? "sess-abc" : undefined,
      },
    }
    expect(ampAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("ampAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(ampAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array of text blocks", () => {
    const content = [
      { type: "text", text: "First block" },
      { type: "text", text: "Second block" },
    ]
    const result = ampAdapter.normalizeContent(content)
    expect(result).toContain("First block")
    expect(result).toContain("Second block")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = ampAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })

  it("handles null content", () => {
    expect(ampAdapter.normalizeContent(null as any)).toBe("null")
  })
})

describe("ampAdapter tool configuration", () => {
  it("getBlockedBuiltinTools includes SDK PascalCase tool names", () => {
    const blocked = ampAdapter.getBlockedBuiltinTools()
    expect(blocked).toContain("Read")
    expect(blocked).toContain("Write")
    expect(blocked).toContain("Edit")
    expect(blocked).toContain("Bash")
    expect(blocked).toContain("Glob")
    expect(blocked).toContain("Grep")
  })

  it("getBlockedBuiltinTools does NOT include Amp's snake_case tool names", () => {
    const blocked = ampAdapter.getBlockedBuiltinTools()
    expect(blocked).not.toContain("read_file")
    expect(blocked).not.toContain("edit_file")
    expect(blocked).not.toContain("create_file")
    expect(blocked).not.toContain("bash")
    expect(blocked).not.toContain("todo_write")
  })

  it("getAgentIncompatibleTools includes Claude-Code-only tools", () => {
    const incompatible = ampAdapter.getAgentIncompatibleTools()
    expect(incompatible).toContain("EnterPlanMode")
    expect(incompatible).toContain("CronCreate")
    expect(incompatible).toContain("EnterWorktree")
  })

  it("getMcpServerName returns 'amp'", () => {
    expect(ampAdapter.getMcpServerName()).toBe("amp")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(ampAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("getAllowedMcpTools all have mcp__amp__ prefix", () => {
    for (const tool of ampAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__amp__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = ampAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__amp__read")
    expect(tools).toContain("mcp__amp__write")
    expect(tools).toContain("mcp__amp__edit")
    expect(tools).toContain("mcp__amp__bash")
    expect(tools).toContain("mcp__amp__glob")
    expect(tools).toContain("mcp__amp__grep")
  })
})

describe("ampAdapter behavior flags", () => {
  it("usesPassthrough returns true", () => {
    expect(ampAdapter.usesPassthrough!()).toBe(true)
  })

  it("supportsThinking returns true", () => {
    expect(ampAdapter.supportsThinking!()).toBe(true)
  })

  it("shouldTrackFileChanges returns false (Amp surfaces edits natively)", () => {
    expect(ampAdapter.shouldTrackFileChanges!()).toBe(false)
  })

  it("buildSdkAgents returns empty object", () => {
    expect(ampAdapter.buildSdkAgents!({}, [])).toEqual({})
  })

  it("buildSdkHooks returns undefined", () => {
    expect(ampAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })

  it("buildSystemContextAddendum returns empty string", () => {
    expect(ampAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

describe("ampAdapter.extractFileChangesFromToolUse", () => {
  it("detects create_file as 'wrote'", () => {
    const changes = ampAdapter.extractFileChangesFromToolUse!("create_file", { path: "/tmp/new.ts", content: "x" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/new.ts" }])
  })

  it("detects create_file with file_path field", () => {
    const changes = ampAdapter.extractFileChangesFromToolUse!("create_file", { file_path: "/tmp/new.ts" })
    expect(changes).toEqual([{ operation: "wrote", path: "/tmp/new.ts" }])
  })

  it("detects edit_file as 'edited'", () => {
    const changes = ampAdapter.extractFileChangesFromToolUse!("edit_file", { path: "/tmp/existing.ts", old_str: "a", new_str: "b" })
    expect(changes).toEqual([{ operation: "edited", path: "/tmp/existing.ts" }])
  })

  it("detects bash command with redirect", () => {
    const changes = ampAdapter.extractFileChangesFromToolUse!("bash", { command: "echo hello > /tmp/out.txt" })
    expect(changes.length).toBeGreaterThan(0)
    expect(changes[0]!.path).toBe("/tmp/out.txt")
  })

  it("returns empty for read_file (no mutation)", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("read_file", { path: "/tmp/x" })).toEqual([])
  })

  it("returns empty for glob/grep/search (no mutation)", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("glob", { pattern: "*.ts" })).toEqual([])
    expect(ampAdapter.extractFileChangesFromToolUse!("grep", { query: "TODO" })).toEqual([])
    expect(ampAdapter.extractFileChangesFromToolUse!("search", { q: "x" })).toEqual([])
  })

  it("returns empty for todo_write / task (not file ops)", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("todo_write", { todos: [] })).toEqual([])
    expect(ampAdapter.extractFileChangesFromToolUse!("task", { description: "do x" })).toEqual([])
  })

  it("returns empty for create_file with no path", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("create_file", { content: "x" })).toEqual([])
  })

  it("returns empty for bash with no command", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("bash", {})).toEqual([])
  })

  it("returns empty for null input", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("create_file", null)).toEqual([])
  })

  it("returns empty for unknown tool", () => {
    expect(ampAdapter.extractFileChangesFromToolUse!("fetch", { url: "https://example.com" })).toEqual([])
  })
})
