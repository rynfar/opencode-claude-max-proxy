/**
 * Multimodal Content Tests
 *
 * Verifies that image, document, and file content blocks are
 * preserved and passed to the SDK as structured messages.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I see the image" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sess-1",
      }
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

let savedPassthrough: string | undefined

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

describe("Multimodal content", () => {
  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
    capturedQueryParams = null
    clearSessionCache()
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("should use text prompt for text-only messages", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    })).json()

    expect(typeof capturedQueryParams.prompt).toBe("string")
  })

  it("should use structured prompt for image content", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR..." } },
        ],
      }],
    })).json()

    // Should be an AsyncIterable, not a string
    expect(typeof capturedQueryParams.prompt).not.toBe("string")
    expect(capturedQueryParams.prompt[Symbol.asyncIterator]).toBeDefined()
  })

  it("should use structured prompt for document content", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "summarize this" },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER..." } },
        ],
      }],
    })).json()

    expect(typeof capturedQueryParams.prompt).not.toBe("string")
  })

  it("should use structured prompt for file content", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "review this" },
          { type: "file", source: { type: "base64", data: "..." } },
        ],
      }],
    })).json()

    expect(typeof capturedQueryParams.prompt).not.toBe("string")
  })

  it("should use structured prompt for images nested inside tool_result content", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_123", name: "read", input: { path: "/tmp/test.png" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: [
                { type: "text", text: "Read image file [image/png]" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
              ],
            },
            { type: "text", text: "describe the image" },
          ],
        },
      ],
    })).json()

    expect(typeof capturedQueryParams.prompt).not.toBe("string")

    const messages: any[] = []
    for await (const msg of capturedQueryParams.prompt) {
      messages.push(msg)
    }

    expect(messages.some((m: any) =>
      typeof m.message?.content === "string" && m.message.content.includes("Tool Use")
    )).toBe(false)

    const multimodalUserMsg = messages.find((m: any) =>
      Array.isArray(m.message?.content) &&
      m.message.content.some((b: any) => b.type === "image")
    )
    expect(multimodalUserMsg).toBeDefined()
    expect(multimodalUserMsg.message.content.some((b: any) => b.type === "text" && b.text.includes("Read image file"))).toBe(true)
    expect(multimodalUserMsg.message.content.some((b: any) => b.type === "image")).toBe(true)
  })

  it("should include all message roles in structured messages", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }] },
        { role: "assistant", content: [{ type: "text", text: "I see it" }] },
        { role: "user", content: "what color is it?" },
      ],
    })).json()

    // Collect all messages from the async iterable
    const messages: any[] = []
    for await (const msg of capturedQueryParams.prompt) {
      messages.push(msg)
    }

    // Should have all 3 messages (system context now in SDK option, not in prompt)
    expect(messages.length).toBeGreaterThanOrEqual(3)
    // All should have the user type wrapper (SDK requirement)
    for (const msg of messages) {
      expect(msg.type).toBe("user")
      expect(msg.message).toBeDefined()
    }
  })

  it("should strip cache_control from content blocks", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" }, cache_control: { type: "ephemeral" } },
        ],
      }],
    })).json()

    const messages: any[] = []
    for await (const msg of capturedQueryParams.prompt) {
      messages.push(msg)
    }

    // Find the message with image content
    const imageMsg = messages.find((m: any) =>
      Array.isArray(m.message.content) &&
      m.message.content.some((b: any) => b.type === "image")
    )
    expect(imageMsg).toBeDefined()
    for (const block of imageMsg.message.content) {
      expect(block.cache_control).toBeUndefined()
    }
  })

  it("should pass system context via systemPrompt option, not in structured messages", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      system: "You are a helpful assistant.",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      }],
    })).json()

    // System context should be in SDK option, not injected as a structured message
    expect(capturedQueryParams.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a helpful assistant.",
    })

    const messages: any[] = []
    for await (const msg of capturedQueryParams.prompt) {
      messages.push(msg)
    }

    // No message should contain the system context (it's in the SDK option now)
    const hasSystemMsg = messages.some((m: any) =>
      typeof m.message.content === "string" && m.message.content.includes("You are a helpful assistant.")
    )
    expect(hasSystemMsg).toBe(false)
  })

  it("should fall back to text prompt with image placeholder when no multimodal", async () => {
    const app = createTestApp()
    await (await post(app, {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    })).json()

    expect(typeof capturedQueryParams.prompt).toBe("string")
    expect(capturedQueryParams.prompt).toContain("hello")
  })
})
