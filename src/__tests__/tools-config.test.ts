/**
 * Tests for tool configuration constants.
 * Guards against accidental changes to tool blocking lists.
 */
import { describe, it, expect } from "bun:test"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"

describe("tool configuration", () => {
  it("BLOCKED_BUILTIN_TOOLS contains expected core tools", () => {
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Read")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Write")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Edit")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Bash")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Glob")
    expect(BLOCKED_BUILTIN_TOOLS).toContain("Grep")
  })

  it("CLAUDE_CODE_ONLY_TOOLS contains schema-incompatible tools", () => {
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("TodoWrite")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("AskUserQuestion")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("Agent")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("WebSearch")
  })

  it("CLAUDE_CODE_ONLY_TOOLS contains SDK-only tools", () => {
    // ToolSearch is intentionally NOT in CLAUDE_CODE_ONLY_TOOLS — it is used
    // internally by the SDK for deferred tool loading and must not be blocked.
    expect(CLAUDE_CODE_ONLY_TOOLS).not.toContain("ToolSearch")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("EnterPlanMode")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("EnterWorktree")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("Monitor")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("PushNotification")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("RemoteTrigger")
    expect(CLAUDE_CODE_ONLY_TOOLS).toContain("ScheduleWakeup")
  })

  it("MCP_SERVER_NAME is opencode", () => {
    expect(MCP_SERVER_NAME).toBe("opencode")
  })

  it("ALLOWED_MCP_TOOLS uses MCP_SERVER_NAME prefix", () => {
    for (const tool of ALLOWED_MCP_TOOLS) {
      expect(tool).toStartWith(`mcp__${MCP_SERVER_NAME}__`)
    }
  })

  it("ALLOWED_MCP_TOOLS contains all 6 MCP tools", () => {
    expect(ALLOWED_MCP_TOOLS).toHaveLength(6)
    expect(ALLOWED_MCP_TOOLS).toContain("mcp__opencode__read")
    expect(ALLOWED_MCP_TOOLS).toContain("mcp__opencode__write")
    expect(ALLOWED_MCP_TOOLS).toContain("mcp__opencode__edit")
    expect(ALLOWED_MCP_TOOLS).toContain("mcp__opencode__bash")
    expect(ALLOWED_MCP_TOOLS).toContain("mcp__opencode__glob")
    expect(ALLOWED_MCP_TOOLS).toContain("mcp__opencode__grep")
  })
})
