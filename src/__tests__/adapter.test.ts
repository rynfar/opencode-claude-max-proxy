/**
 * Tests for the OpenCode agent adapter.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { openCodeAdapter } from "../proxy/adapters/opencode"

const SAMPLE_TASK_TOOL = {
  name: "task",
  description: `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.
- oracle: Read-only consultation agent. High-IQ reasoning specialist.
- explore: Contextual grep for codebases.

When using the Task tool, you must specify a subagent_type parameter.`,
  input_schema: { type: "object", properties: {}, required: [] },
}

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

describe("openCodeAdapter.buildSdkAgents", () => {
  it("returns agent definitions when Task tool is present", () => {
    const body = { tools: [SAMPLE_TASK_TOOL] }
    const agents = openCodeAdapter.buildSdkAgents!(body, ["mcp__opencode__read"])
    expect(Object.keys(agents)).toContain("oracle")
    expect(Object.keys(agents)).toContain("explore")
    expect(Object.keys(agents)).toContain("build")
    expect(Object.keys(agents)).toContain("plan")
  })

  it("each agent has description, prompt, and model", () => {
    const body = { tools: [SAMPLE_TASK_TOOL] }
    const agents = openCodeAdapter.buildSdkAgents!(body, [])
    for (const [name, def] of Object.entries(agents)) {
      expect((def as any).description).toBeTruthy()
      expect((def as any).prompt.toLowerCase()).toContain(name.toLowerCase())
      expect((def as any).model).toBe("inherit")
    }
  })

  it("passes mcpToolNames to agent definitions", () => {
    const mcpTools = ["mcp__opencode__read", "mcp__opencode__bash"]
    const body = { tools: [SAMPLE_TASK_TOOL] }
    const agents = openCodeAdapter.buildSdkAgents!(body, mcpTools)
    expect((agents["oracle"] as any).tools).toEqual(mcpTools)
  })

  it("returns empty object when no tools in body", () => {
    const agents = openCodeAdapter.buildSdkAgents!({}, [])
    expect(Object.keys(agents)).toHaveLength(0)
  })

  it("returns empty object when tools array is empty", () => {
    const agents = openCodeAdapter.buildSdkAgents!({ tools: [] }, [])
    expect(Object.keys(agents)).toHaveLength(0)
  })

  it("returns empty object when no Task tool present", () => {
    const body = {
      tools: [
        { name: "Read", description: "Read a file", input_schema: { type: "object" } },
      ]
    }
    const agents = openCodeAdapter.buildSdkAgents!(body, [])
    expect(Object.keys(agents)).toHaveLength(0)
  })

  it("returns empty object when Task tool has no description", () => {
    const body = {
      tools: [{ name: "task", input_schema: { type: "object" } }]
    }
    const agents = openCodeAdapter.buildSdkAgents!(body, [])
    expect(Object.keys(agents)).toHaveLength(0)
  })

  it("handles Task tool with capital T", () => {
    const capitalT = { ...SAMPLE_TASK_TOOL, name: "Task" }
    const body = { tools: [capitalT] }
    const agents = openCodeAdapter.buildSdkAgents!(body, [])
    expect(Object.keys(agents).length).toBeGreaterThan(0)
  })
})

describe("openCodeAdapter.buildSdkHooks", () => {
  it("returns PreToolUse hook when agents are present", () => {
    const body = { tools: [SAMPLE_TASK_TOOL] }
    const sdkAgents = { oracle: {}, explore: {}, build: {}, plan: {} }
    const hooks = openCodeAdapter.buildSdkHooks!(body, sdkAgents)
    expect(hooks).toBeDefined()
    expect(hooks.PreToolUse).toBeDefined()
    expect(hooks.PreToolUse.length).toBeGreaterThan(0)
  })

  it("returned hook has Task matcher", () => {
    const sdkAgents = { oracle: {}, explore: {} }
    const hooks = openCodeAdapter.buildSdkHooks!({}, sdkAgents)
    const taskHook = hooks.PreToolUse.find((h: any) => h.matcher === "Task")
    expect(taskHook).toBeDefined()
    expect(taskHook.hooks.length).toBeGreaterThan(0)
  })

  it("hook function normalizes capitalized agent name", async () => {
    const sdkAgents = { oracle: {}, explore: {}, build: {} }
    const hooks = openCodeAdapter.buildSdkHooks!({}, sdkAgents)
    const hookFn = hooks.PreToolUse[0].hooks[0]
    const result = await hookFn({
      tool_input: { subagent_type: "Oracle" },
      tool_use_id: "tu_1",
      tool_name: "Task",
    })
    expect(result.hookSpecificOutput.updatedInput.subagent_type).toBe("oracle")
  })

  it("hook function applies fuzzy matching", async () => {
    const sdkAgents = { oracle: {}, explore: {}, build: {} }
    const hooks = openCodeAdapter.buildSdkHooks!({}, sdkAgents)
    const hookFn = hooks.PreToolUse[0].hooks[0]
    // "general-purpose" is a known alias → "general" not in list, falls back to lowercase
    // "code-reviewer" → "oracle" via KNOWN_ALIASES
    const result = await hookFn({
      tool_input: { subagent_type: "code-reviewer" },
      tool_use_id: "tu_2",
      tool_name: "Task",
    })
    expect(result.hookSpecificOutput.updatedInput.subagent_type).toBe("oracle")
  })

  it("hook result preserves other tool_input fields", async () => {
    const sdkAgents = { oracle: {} }
    const hooks = openCodeAdapter.buildSdkHooks!({}, sdkAgents)
    const hookFn = hooks.PreToolUse[0].hooks[0]
    const result = await hookFn({
      tool_input: { subagent_type: "oracle", description: "desc", prompt: "do it" },
      tool_use_id: "tu_3",
      tool_name: "Task",
    })
    expect(result.hookSpecificOutput.updatedInput.description).toBe("desc")
    expect(result.hookSpecificOutput.updatedInput.prompt).toBe("do it")
  })

  it("returns undefined when no agents", () => {
    const hooks = openCodeAdapter.buildSdkHooks!({}, {})
    expect(hooks).toBeUndefined()
  })
})

describe("openCodeAdapter.usesPassthrough", () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved.MERIDIAN_PASSTHROUGH = process.env.MERIDIAN_PASSTHROUGH
    saved.CLAUDE_PROXY_PASSTHROUGH = process.env.CLAUDE_PROXY_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  afterEach(() => {
    if (saved.MERIDIAN_PASSTHROUGH !== undefined) process.env.MERIDIAN_PASSTHROUGH = saved.MERIDIAN_PASSTHROUGH
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (saved.CLAUDE_PROXY_PASSTHROUGH !== undefined) process.env.CLAUDE_PROXY_PASSTHROUGH = saved.CLAUDE_PROXY_PASSTHROUGH
    else delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  it("defaults to true (passthrough mode)", () => {
    expect(openCodeAdapter.usesPassthrough!()).toBe(true)
  })

  it("returns false when MERIDIAN_PASSTHROUGH=0", () => {
    process.env.MERIDIAN_PASSTHROUGH = "0"
    expect(openCodeAdapter.usesPassthrough!()).toBe(false)
  })

  it("returns false when MERIDIAN_PASSTHROUGH=false", () => {
    process.env.MERIDIAN_PASSTHROUGH = "false"
    expect(openCodeAdapter.usesPassthrough!()).toBe(false)
  })

  it("returns true when MERIDIAN_PASSTHROUGH=1", () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    expect(openCodeAdapter.usesPassthrough!()).toBe(true)
  })

  it("falls back to CLAUDE_PROXY_PASSTHROUGH", () => {
    process.env.CLAUDE_PROXY_PASSTHROUGH = "0"
    expect(openCodeAdapter.usesPassthrough!()).toBe(false)
  })

  it("MERIDIAN_PASSTHROUGH takes precedence over CLAUDE_PROXY_PASSTHROUGH", () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    process.env.CLAUDE_PROXY_PASSTHROUGH = "0"
    expect(openCodeAdapter.usesPassthrough!()).toBe(true)
  })
})

describe("openCodeAdapter.supportsThinking", () => {
  it("returns true — OpenCode renders thinking blocks", () => {
    expect(openCodeAdapter.supportsThinking!()).toBe(true)
  })
})

describe("openCodeAdapter.buildSystemContextAddendum", () => {
  it("returns hint string when agents are present", () => {
    const sdkAgents = { oracle: {}, explore: {}, build: {} }
    const addendum = openCodeAdapter.buildSystemContextAddendum!({}, sdkAgents)
    expect(addendum).toContain("IMPORTANT")
    expect(addendum).toContain("oracle")
    expect(addendum).toContain("explore")
    expect(addendum).toContain("build")
  })

  it("mentions subagent_type parameter name", () => {
    const sdkAgents = { oracle: {} }
    const addendum = openCodeAdapter.buildSystemContextAddendum!({}, sdkAgents)
    expect(addendum).toContain("subagent_type")
  })

  it("includes case-sensitivity warning", () => {
    const sdkAgents = { oracle: {} }
    const addendum = openCodeAdapter.buildSystemContextAddendum!({}, sdkAgents)
    expect(addendum).toContain("case-sensitive")
  })

  it("returns empty string when no agents", () => {
    const addendum = openCodeAdapter.buildSystemContextAddendum!({}, {})
    expect(addendum).toBe("")
  })
})
