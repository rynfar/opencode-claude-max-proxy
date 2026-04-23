/**
 * PreToolUse Hook Tests
 *
 * The proxy uses the SDK's PreToolUse hook to fix agent names BEFORE
 * the SDK's internal Task handler processes them. This replaces:
 * - canUseTool deny hack (caused "Tool execution aborted")
 * - Stream-level subagent_type normalization (was a bandaid)
 * - Dual execution (SDK + OpenCode both running Task)
 *
 * The hook rewrites the Task tool's subagent_type input using
 * fuzzyMatchAgentName, so the SDK processes the correct agent name.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null
let savedPassthrough: string | undefined

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

const TASK_TOOL = {
  name: "task",
  description: `Launch a new agent.

Available agent types and the tools they have access to:
- build: Default agent
- plan: Plan mode
- general: General-purpose agent
- explore: Contextual grep for codebases
- oracle: Read-only consultation agent
- librarian: Documentation search agent
- sisyphus-junior: Focused task executor`,
  input_schema: {
    type: "object",
    properties: {
      subagent_type: { type: "string" },
      description: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["subagent_type", "description", "prompt"],
  },
}

describe("PreToolUse hook: agent name correction", () => {
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("should include PreToolUse hooks in SDK options", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    expect(capturedQueryParams.options.hooks).toBeDefined()
    expect(capturedQueryParams.options.hooks.PreToolUse).toBeDefined()
    expect(capturedQueryParams.options.hooks.PreToolUse.length).toBeGreaterThan(0)
  })

  it("should include a Task matcher in PreToolUse hooks", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    const preToolUse = capturedQueryParams.options.hooks.PreToolUse
    const taskMatcher = preToolUse.find((h: any) => h.matcher === "Task")
    expect(taskMatcher).toBeDefined()
    expect(taskMatcher.hooks.length).toBeGreaterThan(0)
  })

  it("hook should rewrite capitalized agent names", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    const taskMatcher = capturedQueryParams.options.hooks.PreToolUse.find((h: any) => h.matcher === "Task")
    const hookFn = taskMatcher.hooks[0]

    // Simulate SDK calling the hook with capitalized agent
    const result = await hookFn({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "Explore", description: "test", prompt: "test" },
      tool_use_id: "toolu_test",
    }, undefined, { signal: new AbortController().signal })

    expect(result.hookSpecificOutput.updatedInput.subagent_type).toBe("explore")
  })

  it("hook should fuzzy match invalid agent names", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    const taskMatcher = capturedQueryParams.options.hooks.PreToolUse.find((h: any) => h.matcher === "Task")
    const hookFn = taskMatcher.hooks[0]

    // general-purpose → general
    const result1 = await hookFn({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "general-purpose", description: "test", prompt: "test" },
      tool_use_id: "toolu_test1",
    }, undefined, { signal: new AbortController().signal })
    // "general-purpose" is registered as an alias agent pointing to the "general"
    // definition, so the fuzzy matcher returns it as a valid exact match.
    expect(result1.hookSpecificOutput.updatedInput.subagent_type).toBe("general-purpose")

    // code-reviewer → oracle
    const result2 = await hookFn({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "code-reviewer", description: "test", prompt: "test" },
      tool_use_id: "toolu_test2",
    }, undefined, { signal: new AbortController().signal })
    expect(result2.hookSpecificOutput.updatedInput.subagent_type).toBe("oracle")
  })

  it("hook should not modify already-valid agent names", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    const taskMatcher = capturedQueryParams.options.hooks.PreToolUse.find((h: any) => h.matcher === "Task")
    const hookFn = taskMatcher.hooks[0]

    const result = await hookFn({
      hook_event_name: "PreToolUse",
      tool_name: "Task",
      tool_input: { subagent_type: "oracle", description: "test", prompt: "test" },
      tool_use_id: "toolu_test3",
    }, undefined, { signal: new AbortController().signal })

    expect(result.hookSpecificOutput.updatedInput.subagent_type).toBe("oracle")
  })
})

describe("SDK agents option", () => {
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("should pass agents extracted from Task tool to SDK", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    expect(capturedQueryParams.options.agents).toBeDefined()
    const agentNames = Object.keys(capturedQueryParams.options.agents)
    expect(agentNames).toContain("oracle")
    expect(agentNames).toContain("explore")
    expect(agentNames).toContain("build")
    expect(agentNames).toContain("plan")
    expect(agentNames).toContain("librarian")
    expect(agentNames).toContain("sisyphus-junior")
  })

  it("each SDK agent should have description and prompt from Task tool", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    const oracle = capturedQueryParams.options.agents["oracle"]
    expect(oracle.description).toContain("Read-only consultation")
    expect(oracle.prompt).toContain("oracle")
    expect(oracle.model).toBe("inherit")
  })

  it("should not pass agents when no Task tool in request", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(capturedQueryParams.options.agents).toBeUndefined()
  })

  it("should pass plugins: [] to prevent external interference", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(capturedQueryParams.options.plugins).toEqual([])
  })
})

describe("PreToolUse hook: cleanup of old hacks", () => {
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("should NOT include canUseTool deny for Task", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    // canUseTool should either not exist or not deny Task
    if (capturedQueryParams.options.canUseTool) {
      const result = await capturedQueryParams.options.canUseTool("Task", {}, { signal: new AbortController().signal })
      expect(result.behavior).not.toBe("deny")
    }
  })

  it("should work without Task tool in request (no hooks needed)", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      // No tools at all
    })).json()

    // Should still work, hooks may or may not be present
    expect(capturedQueryParams).toBeDefined()
  })
})

describe("PreToolUse hook: passthrough ToolSearch", () => {
  // Regression test for the Zod validation bug where returning `undefined`
  // from the passthrough PreToolUse hook caused the SDK to throw
  // `ZodError: expected object, received undefined` and cascade into
  // `Reached maximum number of turns (2)`. The hook must return an object
  // (at minimum `{}`) so the SDK can continue handling ToolSearch internally.
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("returns an object (not undefined) for ToolSearch so the SDK's Zod schema accepts it", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    const allMatcher = capturedQueryParams.options.hooks.PreToolUse.find((h: any) => h.matcher === "")
    expect(allMatcher).toBeDefined()
    const hookFn = allMatcher.hooks[0]

    const result = await hookFn({
      hook_event_name: "PreToolUse",
      tool_name: "ToolSearch",
      tool_input: { query: "select:Read", max_results: 5 },
      tool_use_id: "toolu_tool_search",
    }, undefined, { signal: new AbortController().signal })

    expect(result).toBeDefined()
    expect(typeof result).toBe("object")
    expect(result).not.toBeNull()
    // No `decision` — ToolSearch must pass through to the SDK's internal handler,
    // not be blocked for client forwarding like other tools.
    expect((result as any).decision).toBeUndefined()
  })

  it("still blocks non-ToolSearch tools for client-side execution", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    const allMatcher = capturedQueryParams.options.hooks.PreToolUse.find((h: any) => h.matcher === "")
    const hookFn = allMatcher.hooks[0]

    const result = await hookFn({
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.txt" },
      tool_use_id: "toolu_read",
    }, undefined, { signal: new AbortController().signal })

    expect(result.decision).toBe("block")
    expect(result.reason).toBe("Forwarding to client for execution")
  })
})
