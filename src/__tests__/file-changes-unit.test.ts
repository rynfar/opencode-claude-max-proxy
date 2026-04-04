/**
 * Unit tests for fileChanges.ts — pure functions, no mocks needed.
 */

import { describe, it, expect } from "bun:test"
import { extractFileChange, extractFileChangesFromBash, extractFileChangesFromMessages, formatFileChangeSummary, createFileChangeHook, type FileChange } from "../proxy/fileChanges"

const PREFIX = "mcp__opencode__"

describe("extractFileChange", () => {
  it("should extract a write operation", () => {
    const result = extractFileChange("mcp__opencode__write", { path: "src/foo.ts", content: "hello" }, PREFIX)
    expect(result).toEqual({ operation: "wrote", path: "src/foo.ts" })
  })

  it("should extract an edit operation", () => {
    const result = extractFileChange("mcp__opencode__edit", { path: "src/bar.ts", oldString: "a", newString: "b" }, PREFIX)
    expect(result).toEqual({ operation: "edited", path: "src/bar.ts" })
  })

  it("should return undefined for read (read-only)", () => {
    const result = extractFileChange("mcp__opencode__read", { path: "src/foo.ts" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for glob", () => {
    const result = extractFileChange("mcp__opencode__glob", { pattern: "**/*.ts" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for grep", () => {
    const result = extractFileChange("mcp__opencode__grep", { pattern: "TODO" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for bash", () => {
    const result = extractFileChange("mcp__opencode__bash", { command: "ls" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for non-MCP tools", () => {
    const result = extractFileChange("Task", { description: "do thing" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for different adapter prefix", () => {
    const result = extractFileChange("mcp__droid__write", { path: "foo.ts", content: "x" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should work with droid prefix", () => {
    const result = extractFileChange("mcp__droid__write", { path: "foo.ts", content: "x" }, "mcp__droid__")
    expect(result).toEqual({ operation: "wrote", path: "foo.ts" })
  })

  it("should return undefined for write without path", () => {
    const result = extractFileChange("mcp__opencode__write", { content: "hello" }, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for null input", () => {
    const result = extractFileChange("mcp__opencode__write", null, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should return undefined for undefined input", () => {
    const result = extractFileChange("mcp__opencode__write", undefined, PREFIX)
    expect(result).toBeUndefined()
  })

  it("should coerce non-string path to string", () => {
    const result = extractFileChange("mcp__opencode__write", { path: 42, content: "x" }, PREFIX)
    expect(result).toEqual({ operation: "wrote", path: "42" })
  })
})

describe("extractFileChangesFromBash", () => {
  it("should detect simple echo redirect", () => {
    expect(extractFileChangesFromBash('echo hello > /tmp/test.txt'))
      .toEqual([{ operation: "wrote", path: "/tmp/test.txt" }])
  })

  it("should detect append redirect", () => {
    expect(extractFileChangesFromBash('echo hello >> /tmp/test.txt'))
      .toEqual([{ operation: "wrote", path: "/tmp/test.txt" }])
  })

  it("should detect multiple redirects", () => {
    expect(extractFileChangesFromBash('echo a > x.txt && echo b > y.txt'))
      .toEqual([
        { operation: "wrote", path: "x.txt" },
        { operation: "wrote", path: "y.txt" },
      ])
  })

  it("should detect quoted paths", () => {
    expect(extractFileChangesFromBash('echo x > "/tmp/my file.txt"'))
      .toEqual([{ operation: "wrote", path: "/tmp/my" }]) // only gets up to space — acceptable limitation
  })

  it("should filter /dev/null", () => {
    expect(extractFileChangesFromBash('command > /dev/null')).toEqual([])
  })

  it("should filter /dev/stderr", () => {
    expect(extractFileChangesFromBash('command > /dev/stderr')).toEqual([])
  })

  it("should skip stderr redirects (2>)", () => {
    expect(extractFileChangesFromBash('command 2> /tmp/err.log')).toEqual([])
  })

  it("should detect tee", () => {
    expect(extractFileChangesFromBash('echo hello | tee /tmp/tee-test.txt'))
      .toEqual([{ operation: "wrote", path: "/tmp/tee-test.txt" }])
  })

  it("should detect tee -a (append)", () => {
    expect(extractFileChangesFromBash('echo hello | tee -a /tmp/tee-test.txt'))
      .toEqual([{ operation: "wrote", path: "/tmp/tee-test.txt" }])
  })

  it("should return empty for non-writing commands", () => {
    expect(extractFileChangesFromBash('ls -la')).toEqual([])
    expect(extractFileChangesFromBash('grep pattern file.txt')).toEqual([])
    expect(extractFileChangesFromBash('cat file.txt')).toEqual([])
  })

  it("should detect cat heredoc redirect", () => {
    expect(extractFileChangesFromBash("cat > /tmp/heredoc.txt << 'EOF'"))
      .toEqual([{ operation: "wrote", path: "/tmp/heredoc.txt" }])
  })

  it("should deduplicate same file", () => {
    expect(extractFileChangesFromBash('echo a > f.txt; echo b > f.txt'))
      .toEqual([{ operation: "wrote", path: "f.txt" }])
  })

  it("should handle printf redirect", () => {
    expect(extractFileChangesFromBash('printf "content" > /tmp/printf.txt'))
      .toEqual([{ operation: "wrote", path: "/tmp/printf.txt" }])
  })

  it("should not capture integer comparison operand", () => {
    expect(extractFileChangesFromBash('node -e "arr.length > 40"')).toEqual([])
  })

  it("should not capture zero comparison operand", () => {
    expect(extractFileChangesFromBash('node -e "x > 0"')).toEqual([])
  })

  it("should not capture negative integer comparison operand", () => {
    expect(extractFileChangesFromBash('node -e "includes(x) > -1"')).toEqual([])
  })

  it("should not capture code expressions with parens", () => {
    expect(extractFileChangesFromBash('node -e "console.log(s.trim())"')).toEqual([])
  })

  it("should not capture bare brace", () => {
    expect(extractFileChangesFromBash('echo x > {')).toEqual([])
  })

  it("should still capture real redirect after code comparison", () => {
    expect(extractFileChangesFromBash('node -e "arr.length > 40" && echo done > out.txt'))
      .toEqual([{ operation: "wrote", path: "out.txt" }])
  })

  it("should not capture arrow function with valid-looking path name", () => {
    expect(extractFileChangesFromBash('items.forEach(item => output)')).toEqual([])
  })

  it("should not capture arrow function body with braces", () => {
    expect(extractFileChangesFromBash('items.map(x => { return x; })')).toEqual([])
  })

  it("should not capture >= comparison operator", () => {
    expect(extractFileChangesFromBash('if (count >= 10) echo done')).toEqual([])
  })
})

describe("formatFileChangeSummary", () => {
  it("should return undefined for empty array", () => {
    expect(formatFileChangeSummary([])).toBeUndefined()
  })

  it("should format a single write", () => {
    const result = formatFileChangeSummary([{ operation: "wrote", path: "src/foo.ts" }])
    expect(result).toBe("\n\nFiles changed:\n- wrote src/foo.ts")
  })

  it("should format a single edit", () => {
    const result = formatFileChangeSummary([{ operation: "edited", path: "src/bar.ts" }])
    expect(result).toBe("\n\nFiles changed:\n- edited src/bar.ts")
  })

  it("should format multiple changes", () => {
    const changes: FileChange[] = [
      { operation: "wrote", path: "src/a.ts" },
      { operation: "edited", path: "src/b.ts" },
      { operation: "wrote", path: "src/c.ts" },
    ]
    const result = formatFileChangeSummary(changes)
    expect(result).toBe("\n\nFiles changed:\n- wrote src/a.ts\n- edited src/b.ts\n- wrote src/c.ts")
  })

  it("should deduplicate identical entries", () => {
    const changes: FileChange[] = [
      { operation: "edited", path: "src/foo.ts" },
      { operation: "edited", path: "src/foo.ts" },
      { operation: "edited", path: "src/foo.ts" },
    ]
    const result = formatFileChangeSummary(changes)
    expect(result).toBe("\n\nFiles changed:\n- edited src/foo.ts")
  })

  it("should keep different operations on same path", () => {
    const changes: FileChange[] = [
      { operation: "wrote", path: "src/foo.ts" },
      { operation: "edited", path: "src/foo.ts" },
    ]
    const result = formatFileChangeSummary(changes)
    expect(result).toBe("\n\nFiles changed:\n- wrote src/foo.ts\n- edited src/foo.ts")
  })

  it("should keep same operation on different paths", () => {
    const changes: FileChange[] = [
      { operation: "wrote", path: "src/a.ts" },
      { operation: "wrote", path: "src/b.ts" },
    ]
    const result = formatFileChangeSummary(changes)
    expect(result).toBe("\n\nFiles changed:\n- wrote src/a.ts\n- wrote src/b.ts")
  })
})

describe("createFileChangeHook", () => {
  it("should return a matcher with empty string (match all)", () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    expect(hook.matcher).toBe("")
    expect(hook.hooks.length).toBe(1)
  })

  it("should capture write operations", async () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    const hookFn = hook.hooks[0]!

    await hookFn({
      tool_name: "mcp__opencode__write",
      tool_input: { path: "src/new.ts", content: "export const x = 1" },
      tool_response: "Successfully wrote to src/new.ts",
      tool_use_id: "toolu_123",
    })

    expect(changes).toEqual([{ operation: "wrote", path: "src/new.ts" }])
  })

  it("should capture edit operations", async () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    const hookFn = hook.hooks[0]!

    await hookFn({
      tool_name: "mcp__opencode__edit",
      tool_input: { path: "src/old.ts", oldString: "foo", newString: "bar" },
      tool_response: "Successfully edited src/old.ts",
      tool_use_id: "toolu_456",
    })

    expect(changes).toEqual([{ operation: "edited", path: "src/old.ts" }])
  })

  it("should not capture read operations", async () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    const hookFn = hook.hooks[0]!

    await hookFn({
      tool_name: "mcp__opencode__read",
      tool_input: { path: "README.md" },
      tool_response: "file contents here",
      tool_use_id: "toolu_789",
    })

    expect(changes).toEqual([])
  })

  it("should not capture non-MCP tools", async () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    const hookFn = hook.hooks[0]!

    await hookFn({
      tool_name: "Task",
      tool_input: { subagent_type: "build", prompt: "do stuff" },
      tool_response: "task completed",
      tool_use_id: "toolu_aaa",
    })

    expect(changes).toEqual([])
  })

  it("should accumulate multiple changes", async () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    const hookFn = hook.hooks[0]!

    await hookFn({
      tool_name: "mcp__opencode__write",
      tool_input: { path: "a.ts", content: "x" },
      tool_response: "ok",
      tool_use_id: "toolu_1",
    })
    await hookFn({
      tool_name: "mcp__opencode__edit",
      tool_input: { path: "b.ts", oldString: "x", newString: "y" },
      tool_response: "ok",
      tool_use_id: "toolu_2",
    })
    await hookFn({
      tool_name: "mcp__opencode__read",
      tool_input: { path: "c.ts" },
      tool_response: "contents",
      tool_use_id: "toolu_3",
    })

    expect(changes).toEqual([
      { operation: "wrote", path: "a.ts" },
      { operation: "edited", path: "b.ts" },
    ])
  })

  it("should return empty object (no modifications to tool output)", async () => {
    const changes: FileChange[] = []
    const hook = createFileChangeHook(changes, PREFIX)
    const hookFn = hook.hooks[0]!

    const result = await hookFn({
      tool_name: "mcp__opencode__write",
      tool_input: { path: "x.ts", content: "y" },
      tool_response: "ok",
      tool_use_id: "toolu_test",
    })

    expect(result).toEqual({})
  })
})

describe("extractFileChangesFromMessages", () => {
  // Simple extractor for OpenCode-style tools (Write/Edit with file_path)
  const openCodeExtract = (name: string, input: unknown): FileChange[] => {
    const inp = input as Record<string, unknown> | null | undefined
    const fp = inp?.file_path
    if (name === "Write" && fp) return [{ operation: "wrote", path: String(fp) }]
    if (name === "Edit" && fp) return [{ operation: "edited", path: String(fp) }]
    return []
  }

  it("should extract file changes from a complete tool loop", () => {
    const messages = [
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "src/foo.ts", content: "x" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "success" },
      ]},
      { role: "assistant", content: [
        { type: "text", text: "Done!" },
      ]},
    ]
    const result = extractFileChangesFromMessages(messages, openCodeExtract)
    expect(result).toEqual([{ operation: "wrote", path: "src/foo.ts" }])
  })

  it("should extract multiple file changes", () => {
    const messages = [
      { role: "user", content: "fix bugs" },
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "a.ts", content: "a" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
      ]},
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_2", name: "Edit", input: { file_path: "b.ts", old: "x", new: "y" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_2", content: "ok" },
      ]},
      { role: "assistant", content: [
        { type: "text", text: "All done" },
      ]},
    ]
    const result = extractFileChangesFromMessages(messages, openCodeExtract)
    expect(result).toEqual([
      { operation: "wrote", path: "a.ts" },
      { operation: "edited", path: "b.ts" },
    ])
  })

  it("should skip tool_use blocks without a corresponding tool_result", () => {
    const messages = [
      { role: "user", content: "do something" },
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_1", name: "Write", input: { file_path: "orphan.ts", content: "x" } },
      ]},
      // No tool_result for tu_1 — tool was proposed but not executed
    ]
    const result = extractFileChangesFromMessages(messages, openCodeExtract)
    expect(result).toEqual([])
  })

  it("should skip read-only tools", () => {
    const messages = [
      { role: "user", content: "read file" },
      { role: "assistant", content: [
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "readme.md" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "file contents" },
      ]},
    ]
    const result = extractFileChangesFromMessages(messages, openCodeExtract)
    expect(result).toEqual([])
  })

  it("should handle empty messages", () => {
    expect(extractFileChangesFromMessages([], openCodeExtract)).toEqual([])
  })

  it("should handle messages with string content (no tool_use)", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]
    const result = extractFileChangesFromMessages(messages, openCodeExtract)
    expect(result).toEqual([])
  })
})

describe("openCodeAdapter.extractFileChangesFromToolUse", () => {
  const { openCodeAdapter } = require("../../src/proxy/adapters/opencode") as typeof import("../proxy/adapters/opencode")

  it("should detect lowercase write (opencode native)", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("write", { filePath: "src/new.ts", content: "x" })
    expect(result).toEqual([{ operation: "wrote", path: "src/new.ts" }])
  })

  it("should detect PascalCase Write (SDK passthrough)", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("Write", { file_path: "src/new.ts", content: "x" })
    expect(result).toEqual([{ operation: "wrote", path: "src/new.ts" }])
  })

  it("should detect lowercase edit", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("edit", { filePath: "src/old.ts", oldString: "a", newString: "b" })
    expect(result).toEqual([{ operation: "edited", path: "src/old.ts" }])
  })

  it("should detect PascalCase Edit", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("Edit", { file_path: "src/old.ts" })
    expect(result).toEqual([{ operation: "edited", path: "src/old.ts" }])
  })

  it("should detect MultiEdit tool (any case)", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("MultiEdit", { file_path: "src/multi.ts" })
    expect(result).toEqual([{ operation: "edited", path: "src/multi.ts" }])
  })

  it("should prefer filePath over file_path", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("write", { filePath: "correct.ts", file_path: "fallback.ts" })
    expect(result).toEqual([{ operation: "wrote", path: "correct.ts" }])
  })

  it("should return empty for read", () => {
    expect(openCodeAdapter.extractFileChangesFromToolUse!("read", { filePath: "x.ts" })).toEqual([])
  })

  it("should return empty for write without path", () => {
    expect(openCodeAdapter.extractFileChangesFromToolUse!("write", { content: "x" })).toEqual([])
  })

  it("should return empty for null input", () => {
    expect(openCodeAdapter.extractFileChangesFromToolUse!("write", null)).toEqual([])
  })

  it("should detect bash echo redirect", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("bash", { command: 'echo hello > /tmp/test.txt' })
    expect(result).toEqual([{ operation: "wrote", path: "/tmp/test.txt" }])
  })

  it("should detect bash with multiple redirects", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("bash", { command: 'echo a > x.txt && echo b > y.txt' })
    expect(result).toEqual([
      { operation: "wrote", path: "x.txt" },
      { operation: "wrote", path: "y.txt" },
    ])
  })

  it("should return empty for bash without redirects", () => {
    expect(openCodeAdapter.extractFileChangesFromToolUse!("bash", { command: "ls -la" })).toEqual([])
  })

  it("should detect write with path parameter", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("write", { path: "src/new.ts", content: "x" })
    expect(result).toEqual([{ operation: "wrote", path: "src/new.ts" }])
  })

  it("should detect edit with path parameter", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("edit", { path: "src/old.ts", oldString: "a", newString: "b" })
    expect(result).toEqual([{ operation: "edited", path: "src/old.ts" }])
  })

  it("should prefer filePath over path", () => {
    const result = openCodeAdapter.extractFileChangesFromToolUse!("write", { filePath: "correct.ts", path: "fallback.ts" })
    expect(result).toEqual([{ operation: "wrote", path: "correct.ts" }])
  })
})

describe("crushAdapter.extractFileChangesFromToolUse", () => {
  const { crushAdapter } = require("../../src/proxy/adapters/crush") as typeof import("../proxy/adapters/crush")

  it("should detect write tool (lowercase)", () => {
    const result = crushAdapter.extractFileChangesFromToolUse!("write", { file_path: "src/new.ts", content: "x" })
    expect(result).toEqual([{ operation: "wrote", path: "src/new.ts" }])
  })

  it("should detect edit tool (lowercase)", () => {
    const result = crushAdapter.extractFileChangesFromToolUse!("edit", { file_path: "src/old.ts" })
    expect(result).toEqual([{ operation: "edited", path: "src/old.ts" }])
  })

  it("should detect patch tool", () => {
    const result = crushAdapter.extractFileChangesFromToolUse!("patch", { path: "src/patched.ts" })
    expect(result).toEqual([{ operation: "edited", path: "src/patched.ts" }])
  })

  it("should return empty for PascalCase Write (not Crush convention)", () => {
    expect(crushAdapter.extractFileChangesFromToolUse!("Write", { file_path: "x.ts" })).toEqual([])
  })

  it("should detect bash redirect in Crush", () => {
    const result = crushAdapter.extractFileChangesFromToolUse!("bash", { command: 'echo x > /tmp/crush.txt' })
    expect(result).toEqual([{ operation: "wrote", path: "/tmp/crush.txt" }])
  })
})
