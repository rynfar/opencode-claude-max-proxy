/**
 * Tests for the SDK query options builder.
 */
import { describe, it, expect } from "bun:test"
import { buildQueryOptions, type QueryContext } from "../proxy/query"
import { openCodeAdapter } from "../proxy/adapters/opencode"

function makeContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Hello",
    model: "sonnet[1m]",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    isUndo: false,
    adapter: openCodeAdapter,
    ...overrides,
  }
}

describe("buildQueryOptions", () => {
  it("builds basic non-streaming options", () => {
    const result = buildQueryOptions(makeContext())
    expect(result.prompt).toBe("Hello")
    expect(result.options.model).toBe("sonnet[1m]")
    expect(result.options.cwd).toBe("/tmp/test")
    expect(result.options.maxTurns).toBe(200)
    expect(result.options.permissionMode).toBe("bypassPermissions")
    expect((result.options as any).includePartialMessages).toBeUndefined()
  })

  it("sets includePartialMessages for streaming", () => {
    const result = buildQueryOptions(makeContext({ stream: true }))
    expect((result.options as any).includePartialMessages).toBe(true)
  })

  it("sets maxTurns to 1 in passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect(result.options.maxTurns).toBe(1)
  })

  it("includes system prompt as preset in normal mode", () => {
    const result = buildQueryOptions(makeContext({ systemContext: "Be helpful" }))
    const sp = (result.options as any).systemPrompt
    expect(sp).toBeDefined()
    expect(sp.type).toBe("preset")
    expect(sp.append).toBe("Be helpful")
  })

  it("uses raw system prompt in passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, systemContext: "Be helpful" }))
    const sp = (result.options as any).systemPrompt
    expect(sp).toBe("Be helpful")
  })

  it("omits system prompt when empty", () => {
    const result = buildQueryOptions(makeContext({ systemContext: "" }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("includes resume session ID when provided", () => {
    const result = buildQueryOptions(makeContext({ resumeSessionId: "sdk-123" }))
    expect((result.options as any).resume).toBe("sdk-123")
  })

  it("omits resume when not provided", () => {
    const result = buildQueryOptions(makeContext())
    expect((result.options as any).resume).toBeUndefined()
  })

  it("sets fork options for undo", () => {
    const result = buildQueryOptions(makeContext({
      isUndo: true,
      undoRollbackUuid: "uuid-abc",
    }))
    expect((result.options as any).forkSession).toBe(true)
    expect((result.options as any).resumeSessionAt).toBe("uuid-abc")
  })

  it("includes agents when provided", () => {
    const agents = { explore: { model: "sonnet" } }
    const result = buildQueryOptions(makeContext({ sdkAgents: agents }))
    expect((result.options as any).agents).toEqual(agents)
  })

  it("omits agents when empty", () => {
    const result = buildQueryOptions(makeContext({ sdkAgents: {} }))
    expect((result.options as any).agents).toBeUndefined()
  })

  it("uses adapter's blocked tools in normal mode", () => {
    const result = buildQueryOptions(makeContext())
    const disallowed = (result.options as any).disallowedTools as string[]
    expect(disallowed).toContain("Read")
    expect(disallowed).toContain("TodoWrite")
    expect(disallowed).toContain("Agent")
  })

  it("uses adapter's allowed MCP tools in normal mode", () => {
    const result = buildQueryOptions(makeContext())
    const allowed = (result.options as any).allowedTools as string[]
    expect(allowed).toContain("mcp__opencode__read")
    expect(allowed).toContain("mcp__opencode__bash")
  })

  it("uses passthrough MCP tools when in passthrough mode", () => {
    const mockPassthroughMcp = {
      toolNames: ["mcp__passthrough__custom_tool"],
      server: {} as any,
    }
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      passthroughMcp: mockPassthroughMcp,
    }))
    const allowed = (result.options as any).allowedTools as string[]
    expect(allowed).toContain("mcp__passthrough__custom_tool")
  })

  it("strips API keys from environment", () => {
    const result = buildQueryOptions(makeContext({
      cleanEnv: { HOME: "/home/user", SOME_VAR: "value" },
    }))
    const env = (result.options as any).env
    expect(env.HOME).toBe("/home/user")
    expect(env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  it("disables Claude.ai MCP servers in passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    const env = (result.options as any).env
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false")
  })

  it("does not disable Claude.ai MCP servers in normal mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: false }))
    const env = (result.options as any).env
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBeUndefined()
  })

  it("includes hooks when provided", () => {
    const hooks = { PreToolUse: [{ matcher: "Task", hooks: [] }] }
    const result = buildQueryOptions(makeContext({ sdkHooks: hooks }))
    expect((result.options as any).hooks).toEqual(hooks)
  })
})
