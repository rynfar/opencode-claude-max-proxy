/**
 * File Change Visibility Integration Tests
 *
 * Verifies that the PostToolUse hook captures file operations (write/edit/bash)
 * and injects a summary into the response — both streaming and non-streaming.
 *
 * GitHub issue #189: "Build command lacks file change visibility"
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  toolUseBlockStart,
  textDelta,
  inputJsonDelta,
  blockStop,
  messageDelta,
  messageStop,
  parseSSE,
} from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params

    // If PostToolUse hooks are registered, call them for MCP tool events
    // This simulates what the SDK does internally when tools execute
    return (async function* () {
      const postToolUseHooks = params.options?.hooks?.PostToolUse
      for (const msg of mockMessages) {
        yield msg

        // After yielding an assistant message with tool results, fire PostToolUse
        // for any MCP tool blocks (simulating the SDK's internal tool execution)
        if (msg.type === "assistant" && postToolUseHooks) {
          for (const block of msg.message?.content || []) {
            if (block.type === "tool_use" && block.name?.startsWith("mcp__")) {
              for (const matcher of postToolUseHooks) {
                for (const hookFn of matcher.hooks) {
                  await hookFn({
                    hook_event_name: "PostToolUse",
                    tool_name: block.name,
                    tool_input: block.input,
                    tool_response: `Success: ${block.name}`,
                    tool_use_id: block.id,
                  })
                }
              }
            }
          }
        }

        // For streaming: fire PostToolUse after tool_use content_block_start
        if (msg.type === "stream_event" && postToolUseHooks) {
          const event = msg.event
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && event.content_block?.name?.startsWith("mcp__")) {
            const toolName = event.content_block.name
            const toolInput = event.content_block.input || {}
            const toolId = event.content_block.id
            for (const matcher of postToolUseHooks) {
              for (const hookFn of matcher.hooks) {
                await hookFn({
                  hook_event_name: "PostToolUse",
                  tool_name: toolName,
                  tool_input: toolInput,
                  tool_response: `Success: ${toolName}`,
                  tool_use_id: toolId,
                })
              }
            }
          }
        }
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
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

async function postStream(app: any, body: any) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let result = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result += decoder.decode(value, { stream: true })
  }
  return parseSSE(result)
}

describe("File change visibility: PostToolUse hook registration", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
  })

  it("should register PostToolUse hooks in SDK options", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(capturedQueryParams.options.hooks).toBeDefined()
    expect(capturedQueryParams.options.hooks.PostToolUse).toBeDefined()
    expect(capturedQueryParams.options.hooks.PostToolUse.length).toBeGreaterThan(0)
  })

  it("should register PostToolUse alongside PreToolUse when Task tool is present", async () => {
    const TASK_TOOL = {
      name: "task",
      description: "Launch a new agent.\n\nAvailable agent types and the tools they have access to:\n- build: Default agent\n- explore: Explorer",
      input_schema: {
        type: "object",
        properties: { subagent_type: { type: "string" }, description: { type: "string" } },
        required: ["subagent_type", "description"],
      },
    }

    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
      tools: [TASK_TOOL],
    })).json()

    expect(capturedQueryParams.options.hooks.PreToolUse).toBeDefined()
    expect(capturedQueryParams.options.hooks.PostToolUse).toBeDefined()
  })

  it("should not register PostToolUse in passthrough mode", async () => {
    const origPassthrough = process.env.MERIDIAN_PASSTHROUGH
    const origCPPassthrough = process.env.CLAUDE_PROXY_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"

    try {
      const app = createTestApp()
      await (await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })).json()

      const hooks = capturedQueryParams.options.hooks
      expect(hooks.PreToolUse).toBeDefined()
      expect(hooks.PostToolUse).toBeUndefined()
    } finally {
      if (origPassthrough !== undefined) {
        process.env.MERIDIAN_PASSTHROUGH = origPassthrough
      } else {
        delete process.env.MERIDIAN_PASSTHROUGH
      }
      if (origCPPassthrough !== undefined) {
        process.env.CLAUDE_PROXY_PASSTHROUGH = origCPPassthrough
      }
    }
  })
})

describe("File change visibility: non-streaming response", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
    clearSessionCache()
  })

  it("should append file change summary to response when files are written", async () => {
    // Simulate SDK executing mcp__opencode__write internally, then returning text
    mockMessages = [
      // First the SDK calls the write tool (internal, won't be in final content)
      assistantMessage([
        { type: "tool_use", id: "toolu_w1", name: "mcp__opencode__write", input: { path: "src/new-file.ts", content: "export const x = 1" } },
      ]),
      // Then SDK returns the text response after tool execution
      assistantMessage([
        { type: "text", text: "I created the file for you." },
      ]),
    ]

    const app = createTestApp()
    const response = await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Create a file" }],
    })).json()

    // The response should include file change summary in the text
    const textBlocks = response.content.filter((b: any) => b.type === "text")
    const allText = textBlocks.map((b: any) => b.text).join("")
    expect(allText).toContain("Files changed:")
    expect(allText).toContain("wrote src/new-file.ts")
  })

  it("should append file change summary when files are edited", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_e1", name: "mcp__opencode__edit", input: { path: "src/existing.ts", oldString: "foo", newString: "bar" } },
      ]),
      assistantMessage([
        { type: "text", text: "I fixed the bug." },
      ]),
    ]

    const app = createTestApp()
    const response = await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Fix the bug" }],
    })).json()

    const textBlocks = response.content.filter((b: any) => b.type === "text")
    const allText = textBlocks.map((b: any) => b.text).join("")
    expect(allText).toContain("Files changed:")
    expect(allText).toContain("edited src/existing.ts")
  })

  it("should not include summary when only reads occur", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_r1", name: "mcp__opencode__read", input: { path: "README.md" } },
      ]),
      assistantMessage([
        { type: "text", text: "The README says hello." },
      ]),
    ]

    const app = createTestApp()
    const response = await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Read README" }],
    })).json()

    const textBlocks = response.content.filter((b: any) => b.type === "text")
    const allText = textBlocks.map((b: any) => b.text).join("")
    expect(allText).not.toContain("Files changed:")
  })

  it("should show multiple file changes", async () => {
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_w1", name: "mcp__opencode__write", input: { path: "src/a.ts", content: "a" } },
      ]),
      assistantMessage([
        { type: "tool_use", id: "toolu_e1", name: "mcp__opencode__edit", input: { path: "src/b.ts", oldString: "x", newString: "y" } },
      ]),
      assistantMessage([
        { type: "tool_use", id: "toolu_w2", name: "mcp__opencode__write", input: { path: "src/c.ts", content: "c" } },
      ]),
      assistantMessage([
        { type: "text", text: "All done." },
      ]),
    ]

    const app = createTestApp()
    const response = await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Create multiple files" }],
    })).json()

    const textBlocks = response.content.filter((b: any) => b.type === "text")
    const allText = textBlocks.map((b: any) => b.text).join("")
    expect(allText).toContain("wrote src/a.ts")
    expect(allText).toContain("edited src/b.ts")
    expect(allText).toContain("wrote src/c.ts")
  })
})

describe("File change visibility: streaming response", () => {
  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
    clearSessionCache()
  })

  it("should emit file change text block before message_stop in stream", async () => {
    // Multi-turn: MCP write tool → text response
    mockMessages = [
      messageStart(),
      // MCP tool (internal, filtered from stream)
      toolUseBlockStart(0, "mcp__opencode__write", "toolu_sw1"),
      inputJsonDelta(0, '{"path":"src/streamed.ts","content":"hello"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
      // After tool execution, SDK returns text
      messageStart(),
      textBlockStart(0),
      textDelta(0, "File created."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    // Override input on the tool block for the hook to read
    const toolBlock = (mockMessages[1] as any).event.content_block
    toolBlock.input = { path: "src/streamed.ts", content: "hello" }

    const app = createTestApp()
    const events = await postStream(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Create a file" }],
    })

    // Should have a text delta containing the file change summary
    const allTextDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    const allText = allTextDeltas.map((e) => (e.data as any).delta.text).join("")
    expect(allText).toContain("Files changed:")
    expect(allText).toContain("wrote src/streamed.ts")

    // File change block should come BEFORE message_stop
    const lastEvent = events[events.length - 1]
    expect(lastEvent?.event).toBe("message_stop")
  })

  it("should not emit file change block when no files changed", async () => {
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Hello there!"),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const events = await postStream(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Say hello" }],
    })

    const allTextDeltas = events.filter(
      (e) => e.event === "content_block_delta" && (e.data as any).delta?.type === "text_delta"
    )
    const allText = allTextDeltas.map((e) => (e.data as any).delta.text).join("")
    expect(allText).not.toContain("Files changed:")
  })

  it("should use correct block index for file change text block", async () => {
    // Text block at index 0, then MCP tool (skipped), then file change block should be index 1
    mockMessages = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Working on it."),
      blockStop(0),
      // MCP tool (hidden)
      toolUseBlockStart(1, "mcp__opencode__edit", "toolu_idx"),
      inputJsonDelta(1, '{"path":"src/idx.ts","oldString":"a","newString":"b"}'),
      blockStop(1),
      messageDelta("tool_use"),
      messageStop(),
      // Final text
      messageStart(),
      textBlockStart(0),
      textDelta(0, "Done."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    // Set input on tool block
    const toolBlock = (mockMessages[4] as any).event.content_block
    toolBlock.input = { path: "src/idx.ts", oldString: "a", newString: "b" }

    const app = createTestApp()
    const events = await postStream(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Edit a file" }],
    })

    // Find the file change block start
    const blockStarts = events.filter((e) => e.event === "content_block_start")
    const fileChangeBlock = blockStarts.find(
      (e) => {
        const text = (e.data as any).content_block?.text
        return text !== undefined && (e.data as any).content_block?.type === "text"
      }
    )

    // All block indices should be monotonically increasing
    const indices = blockStarts.map((e) => (e.data as any).index)
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!)
    }
  })
})

describe("File change visibility: MERIDIAN_NO_FILE_CHANGES opt-out", () => {
  let origMeridian: string | undefined
  let origClaude: string | undefined

  beforeEach(() => {
    mockMessages = []
    capturedQueryParams = null
    clearSessionCache()
    origMeridian = process.env.MERIDIAN_NO_FILE_CHANGES
    origClaude = process.env.CLAUDE_PROXY_NO_FILE_CHANGES
  })

  afterEach(() => {
    if (origMeridian !== undefined) process.env.MERIDIAN_NO_FILE_CHANGES = origMeridian
    else delete process.env.MERIDIAN_NO_FILE_CHANGES
    if (origClaude !== undefined) process.env.CLAUDE_PROXY_NO_FILE_CHANGES = origClaude
    else delete process.env.CLAUDE_PROXY_NO_FILE_CHANGES
  })

  it("should suppress PostToolUse hook registration when MERIDIAN_NO_FILE_CHANGES=1", async () => {
    process.env.MERIDIAN_NO_FILE_CHANGES = "1"
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]

    const app = createTestApp()
    await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Do something" }],
    })

    expect(capturedQueryParams?.options?.hooks?.PostToolUse).toBeUndefined()
  })

  it("should suppress file change summary in non-streaming response when MERIDIAN_NO_FILE_CHANGES=1", async () => {
    process.env.MERIDIAN_NO_FILE_CHANGES = "1"
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_w1", name: "mcp__opencode__write", input: { path: "src/new-file.ts", content: "export const x = 1" } },
      ]),
      assistantMessage([{ type: "text", text: "I created the file." }]),
    ]

    const app = createTestApp()
    const response = await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Create a file" }],
    })).json()

    const allText = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
    expect(allText).not.toContain("Files changed:")
    expect(allText).toContain("I created the file.")
  })

  it("should suppress file change SSE block in streaming response when MERIDIAN_NO_FILE_CHANGES=1", async () => {
    process.env.MERIDIAN_NO_FILE_CHANGES = "1"
    mockMessages = [
      messageStart(),
      toolUseBlockStart(0, "mcp__opencode__write", "toolu_w2"),
      inputJsonDelta(0, '{"path":"src/out.ts","content":"export {}"}'),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop(),
      messageStart(),
      textBlockStart(0),
      textDelta(0, "File written."),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop(),
    ]

    const app = createTestApp()
    const events = await postStream(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "Write a file" }],
    })

    // No file change text block should be present
    const textBlockStarts = events.filter(
      (e) => e.event === "content_block_start" && (e.data as any).content_block?.type === "text"
    )
    const fileChangeBlocks = textBlockStarts.filter((e) => {
      const deltas = events.filter(
        (d) => d.event === "content_block_delta" && (d.data as any).index === (e.data as any).index
      )
      return deltas.some((d) => (d.data as any).delta?.text?.includes("Files changed:"))
    })
    expect(fileChangeBlocks).toHaveLength(0)
  })

  it("should suppress summary when CLAUDE_PROXY_NO_FILE_CHANGES=1 (fallback env var)", async () => {
    process.env.CLAUDE_PROXY_NO_FILE_CHANGES = "1"
    mockMessages = [
      assistantMessage([
        { type: "tool_use", id: "toolu_w3", name: "mcp__opencode__write", input: { path: "src/f.ts", content: "x" } },
      ]),
      assistantMessage([{ type: "text", text: "Done." }]),
    ]

    const app = createTestApp()
    const response = await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "Write a file" }],
    })).json()

    const allText = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("")
    expect(allText).not.toContain("Files changed:")
  })
})
