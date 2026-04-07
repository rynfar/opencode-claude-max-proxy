import { describe, expect, it, mock } from "bun:test"

// Provide a minimal SDK mock so createPassthroughMcpServer can register tools
// without hitting the real SDK (which may not be available in CI or may have
// been mocked differently by a sibling test file).
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: () => ({
    type: "sdk",
    name: "test",
    instance: { tool: () => {}, registerTool: () => ({}) },
  }),
}))

import { createPassthroughMcpServer } from "../proxy/passthroughTools"

describe("createPassthroughMcpServer tool ordering", () => {
  it("produces the same toolNames regardless of input order", () => {
    const toolsA = [
      { name: "write", description: "Write a file" },
      { name: "bash", description: "Run a command" },
      { name: "read", description: "Read a file" },
    ]
    const toolsB = [
      { name: "read", description: "Read a file" },
      { name: "write", description: "Write a file" },
      { name: "bash", description: "Run a command" },
    ]

    const resultA = createPassthroughMcpServer(toolsA)
    const resultB = createPassthroughMcpServer(toolsB)

    expect(resultA.toolNames).toEqual(resultB.toolNames)
    // Should be sorted alphabetically
    expect(resultA.toolNames).toEqual([
      "mcp__oc__bash",
      "mcp__oc__read",
      "mcp__oc__write",
    ])
  })

  it("returns hasDeferredTools=true when any tool has defer_loading", () => {
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "custom", description: "Custom tool", defer_loading: true },
    ]
    const result = createPassthroughMcpServer(tools)
    expect(result.hasDeferredTools).toBe(true)
  })

  it("returns hasDeferredTools=false when no tools have defer_loading", () => {
    const tools = [
      { name: "read", description: "Read a file" },
      { name: "write", description: "Write a file" },
    ]
    const result = createPassthroughMcpServer(tools)
    expect(result.hasDeferredTools).toBe(false)
  })
})
