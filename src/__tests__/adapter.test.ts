/**
 * Tests for the OpenCode agent adapter.
 */
import { describe, it, expect } from "bun:test"
import { openCodeAdapter } from "../proxy/adapters/opencode"

describe("openCodeAdapter", () => {
  it("has name 'opencode'", () => {
    expect(openCodeAdapter.name).toBe("opencode")
  })

  it("extracts session ID from x-opencode-session header", () => {
    const mockContext = {
      req: {
        header: (name: string) => name === "x-opencode-session" ? "sess-123" : undefined
      }
    }
    expect(openCodeAdapter.getSessionId(mockContext as any)).toBe("sess-123")
  })

  it("returns undefined when no session header", () => {
    const mockContext = {
      req: { header: () => undefined }
    }
    expect(openCodeAdapter.getSessionId(mockContext as any)).toBeUndefined()
  })

  it("extracts profile ID from x-meridian-profile header", () => {
    const mockContext = {
      req: {
        header: (name: string) => name === "x-meridian-profile" ? "company" : undefined
      }
    }
    expect(openCodeAdapter.getProfileId(mockContext as any)).toBe("company")
  })

  it("extracts working directory from system prompt env block", () => {
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n</env>"
    }
    expect(openCodeAdapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("returns undefined when no env block", () => {
    expect(openCodeAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("normalizes string content", () => {
    expect(openCodeAdapter.normalizeContent("hello")).toBe("hello")
  })

  it("normalizes array content", () => {
    const content = [{ type: "text", text: "hello" }]
    expect(openCodeAdapter.normalizeContent(content)).toBe("hello")
  })

  it("returns blocked builtin tools", () => {
    const tools = openCodeAdapter.getBlockedBuiltinTools()
    expect(tools).toContain("Read")
    expect(tools).toContain("Write")
    expect(tools).toContain("Bash")
  })

  it("returns agent-incompatible tools", () => {
    const tools = openCodeAdapter.getAgentIncompatibleTools()
    expect(tools).toContain("TodoWrite")
    expect(tools).toContain("Agent")
    expect(tools).toContain("EnterPlanMode")
  })

  it("returns opencode as MCP server name", () => {
    expect(openCodeAdapter.getMcpServerName()).toBe("opencode")
  })

  it("returns allowed MCP tools with correct prefix", () => {
    const tools = openCodeAdapter.getAllowedMcpTools()
    expect(tools.length).toBe(6)
    for (const tool of tools) {
      expect(tool).toStartWith("mcp__opencode__")
    }
  })
})
