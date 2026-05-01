/**
 * Tests for the SDK query options builder.
 */
import { describe, it, expect } from "bun:test"
import { buildQueryOptions, type QueryContext } from "../proxy/query"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"

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
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS,
    incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME,
    allowedMcpTools: ALLOWED_MCP_TOOLS,
    ...overrides,
  }
}

describe("buildQueryOptions", () => {
  it("forces node as the executable to avoid bun auto-detection on embedded hosts", () => {
    // The SDK defaults to spawning 'bun' whenever process.versions.bun is set,
    // even when bun is not in PATH (e.g. OpenCode embeds Bun in its native binary).
    // Explicitly setting executable: 'node' prevents ENOENT spawn failures.
    const result = buildQueryOptions(makeContext())
    expect((result.options as any).executable).toBe("node")
  })

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

  it("sets maxTurns to 3 in passthrough mode (thinking + tool_use + handoff fits in 3 turns)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect(result.options.maxTurns).toBe(3)
  })

  it("sets maxTurns to 3 in passthrough mode with resume (rehydration fits within base budget)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, resumeSessionId: "sess-123" }))
    expect(result.options.maxTurns).toBe(3)
  })

  it("sets maxTurns to 3 in passthrough mode with deferred tools (ToolSearch fits within base budget)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, hasDeferredTools: true }))
    expect(result.options.maxTurns).toBe(3)
  })

  it("sets maxTurns to 4 in passthrough mode when resume AND deferred tools are both active", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      resumeSessionId: "sess-123",
      hasDeferredTools: true,
    }))
    expect(result.options.maxTurns).toBe(4)
  })

  it("sets maxTurns to 6 in passthrough mode with advisor (base 3 + 3 for advisor call/result/answer)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, advisorModel: "claude-opus-4-7" }))
    expect(result.options.maxTurns).toBe(6)
  })

  it("sets maxTurns to 6 in passthrough mode with advisor + resume", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, advisorModel: "claude-opus-4-7", resumeSessionId: "sess-123" }))
    expect(result.options.maxTurns).toBe(6)
  })

  it("sets maxTurns to 6 in passthrough mode with advisor + deferred tools", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, advisorModel: "claude-opus-4-7", hasDeferredTools: true }))
    expect(result.options.maxTurns).toBe(6)
  })

  it("sets maxTurns to 7 in passthrough mode with advisor + resume + deferred tools (all three active)", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      advisorModel: "claude-opus-4-7",
      resumeSessionId: "sess-123",
      hasDeferredTools: true,
    }))
    expect(result.options.maxTurns).toBe(7)
  })

  it("does not bump maxTurns in non-passthrough mode when advisor is set", () => {
    const result = buildQueryOptions(makeContext({ advisorModel: "claude-opus-4-7" }))
    expect(result.options.maxTurns).toBe(200)
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
      hasDeferredTools: false,
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

  it("sets ENABLE_TOOL_SEARCH=true when hasDeferredTools is true", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, hasDeferredTools: true }))
    const env = (result.options as any).env
    expect(env.ENABLE_TOOL_SEARCH).toBe("true")
  })

  it("sets ENABLE_TOOL_SEARCH=false when hasDeferredTools is false", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true, hasDeferredTools: false }))
    const env = (result.options as any).env
    expect(env.ENABLE_TOOL_SEARCH).toBe("false")
  })

  // ── systemPrompt × settingSources matrix ──────────────────────────

  it("uses preset with append when systemContext + settingSources both set", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "Be helpful",
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toBe("Be helpful")
  })

  it("uses preset with append in passthrough + settingSources", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Be helpful",
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toBe("Be helpful")
  })

  it("uses bare preset when settingSources set but no systemContext", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "",
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toBeUndefined()
  })

  it("omits systemPrompt when no systemContext and no settingSources", () => {
    const result = buildQueryOptions(makeContext({ systemContext: "", settingSources: [] }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("passes settingSources and memory settings to SDK options", () => {
    const result = buildQueryOptions(makeContext({
      settingSources: ["user", "project"],
      memory: true,
      dreaming: true,
    }))
    const opts = result.options as any
    expect(opts.settingSources).toEqual(["user", "project"])
    expect(opts.settings.autoMemoryEnabled).toBe(true)
    expect(opts.settings.autoDreamEnabled).toBe(true)
  })

  it("omits settingSources and settings when settingSources empty", () => {
    const result = buildQueryOptions(makeContext({ settingSources: [] }))
    const opts = result.options as any
    expect(opts.settingSources).toBeUndefined()
    expect(opts.settings).toBeUndefined()
  })

  // sharedMemory env handling — see issue #453 (and upstream
  // anthropics/claude-code#20553). Setting CLAUDE_CONFIG_DIR=$HOME/.claude
  // explicitly — even though it's the default — changes the SDK's Keychain
  // lookup key and breaks OAuth. So when sharedMemory is on, we DO NOT set
  // CLAUDE_CONFIG_DIR; we instead strip any inherited custom value so the
  // SDK falls back to its own default (which is ~/.claude).

  it("does NOT set CLAUDE_CONFIG_DIR when sharedMemory=true and profile env is empty (regression #453)", () => {
    const result = buildQueryOptions(makeContext({ sharedMemory: true, cleanEnv: {} }))
    const env = (result.options as any).env
    // Was the bug: previously this asserted env.CLAUDE_CONFIG_DIR contained
    // ".claude". Setting it explicitly broke macOS Keychain auth.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it("strips inherited CLAUDE_CONFIG_DIR when sharedMemory=true (custom profile case)", () => {
    // sharedMemory's intent is "use the SDK's default ~/.claude so memories
    // sync with Claude Code". When a profile inherits a custom config dir,
    // we need that custom path REMOVED — not overridden — so the SDK's own
    // default takes over without the explicit-set bug.
    const result = buildQueryOptions(makeContext({
      sharedMemory: true,
      cleanEnv: { CLAUDE_CONFIG_DIR: "/custom/profile/dir", SOMETHING_ELSE: "keep-me" },
    }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    // Other inherited env vars are preserved.
    expect(env.SOMETHING_ELSE).toBe("keep-me")
  })

  it("preserves CLAUDE_CONFIG_DIR from profile when sharedMemory=false", () => {
    const result = buildQueryOptions(makeContext({
      sharedMemory: false,
      cleanEnv: { CLAUDE_CONFIG_DIR: "/custom/profile/dir" },
    }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/profile/dir")
  })

  it("omits CLAUDE_CONFIG_DIR when sharedMemory is false and profile env is empty", () => {
    const result = buildQueryOptions(makeContext({ sharedMemory: false, cleanEnv: {} }))
    const env = (result.options as any).env
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  // ── codeSystemPrompt / clientSystemPrompt controls ────────────────

  it("forces preset when codeSystemPrompt is true even in passthrough", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      codeSystemPrompt: true,
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toBe("Agent instructions")
  })

  it("skips preset when codeSystemPrompt is false in normal mode", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: false,
      systemContext: "Agent instructions",
      codeSystemPrompt: false,
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp).toBe("Agent instructions")
  })

  it("omits systemPrompt entirely when codeSystemPrompt false and no systemContext", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "",
      codeSystemPrompt: false,
    }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("shows preset without append when codeSystemPrompt true but clientSystemPrompt false", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "Agent instructions",
      codeSystemPrompt: true,
      clientSystemPrompt: false,
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.preset).toBe("claude_code")
    expect(sp.append).toBeUndefined()
  })

  it("strips client prompt when clientSystemPrompt is false in passthrough", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      clientSystemPrompt: false,
    }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })

  it("includes client prompt when clientSystemPrompt is true (default)", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      clientSystemPrompt: true,
    }))
    expect((result.options as any).systemPrompt).toBe("Agent instructions")
  })

  it("all three controls work together: preset + client + settingSources", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      systemContext: "Agent instructions",
      codeSystemPrompt: true,
      clientSystemPrompt: true,
      settingSources: ["user", "project"],
    }))
    const sp = (result.options as any).systemPrompt
    expect(sp.type).toBe("preset")
    expect(sp.append).toBe("Agent instructions")
    const opts = result.options as any
    expect(opts.settingSources).toEqual(["user", "project"])
  })

  it("disabling both prompts produces no systemPrompt", () => {
    const result = buildQueryOptions(makeContext({
      systemContext: "Agent instructions",
      codeSystemPrompt: false,
      clientSystemPrompt: false,
    }))
    expect((result.options as any).systemPrompt).toBeUndefined()
  })
})
