/**
 * Integration tests for OpenAI-compatible endpoints.
 *
 * Tests /v1/chat/completions (streaming + non-streaming) and /v1/models
 * through the full HTTP layer with a mocked SDK.
 *
 * These tests verify:
 *   1. Correct OpenAI response shapes (no regressions in the translation)
 *   2. Proper routing to the internal /v1/messages handler
 *   3. Error handling (empty messages, upstream errors)
 *   4. Existing /v1/messages behavior is unaffected (no regressions)
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"
import {
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  assistantMessage,
  parseSSE,
} from "./helpers"

let mockMessages: unknown[] = []
let capturedPromptMessages: unknown[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt }: { prompt: string | AsyncIterable<unknown> }) => {
    return (async function* () {
      capturedPromptMessages = []
      if (typeof prompt === "string") {
        capturedPromptMessages.push(prompt)
      } else {
        for await (const msg of prompt) {
          capturedPromptMessages.push(msg)
        }
      }
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function postChatCompletion(app: ReturnType<typeof createTestApp>, body: Record<string, unknown>) {
  return app.fetch(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

// ---------------------------------------------------------------------------
// Non-streaming
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — non-streaming", () => {
  beforeEach(() => {
    mockMessages = []
    capturedPromptMessages = []
    clearSessionCache()
  })

  it("returns OpenAI completion shape for a simple message", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Hello!" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 50,
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.object).toBe("chat.completion")
    expect(typeof body.id).toBe("string")
    expect((body.id as string).startsWith("chatcmpl-")).toBe(true)
    expect(body.model).toBe("claude-haiku-4-5-20251001")
    const choices = body.choices as Array<Record<string, unknown>>
    expect(choices).toBeArray()
    expect(choices[0]!.message).toEqual({ role: "assistant", content: "Hello!" })
    expect(choices[0]!.finish_reason).toBe("stop")
    const usage = body.usage as Record<string, number>
    expect(typeof usage.prompt_tokens).toBe("number")
    expect(typeof usage.completion_tokens).toBe("number")
    expect(typeof usage.total_tokens).toBe("number")
  })

  it("returns 400 for missing messages field", async () => {
    const app = createTestApp()
    const res = await postChatCompletion(app, {
      model: "claude-haiku-4-5-20251001",
      stream: false,
      // messages intentionally omitted
    })
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body.type).toBe("error")
  })

  it("returns 400 for empty messages array", async () => {
    const app = createTestApp()
    const res = await postChatCompletion(app, {
      model: "claude-haiku-4-5-20251001",
      stream: false,
      messages: [],
    })
    expect(res.status).toBe(400)
  })

  it("filters thinking blocks from response", async () => {
    mockMessages = [assistantMessage([
      { type: "thinking", thinking: "internal thoughts" },
      { type: "text", text: "public answer" },
    ])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [{ role: "user", content: "think" }],
    })

    const body = await res.json() as Record<string, unknown>
    const choices = body.choices as Array<Record<string, unknown>>
    expect((choices[0]!.message as Record<string, unknown>).content).toBe("public answer")
  })

  it("handles system message correctly", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [
        { role: "system", content: "You are a pirate." },
        { role: "user", content: "Hello" },
      ],
    })

    expect(res.status).toBe(200)
  })

  it("response has Content-Type application/json", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.headers.get("content-type")).toContain("application/json")
  })

  it("preserves data-url image_url blocks for the SDK prompt", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: false,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        ],
      }],
    })

    expect(res.status).toBe(200)
    expect(capturedPromptMessages).toEqual([{
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
        ],
      },
      parent_tool_use_id: null,
    }])
  })
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("POST /v1/chat/completions — streaming", () => {
  beforeEach(() => {
    mockMessages = []
    capturedPromptMessages = []
    clearSessionCache()
  })

  async function readStream(res: Response): Promise<string> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    return text
  }

  it("returns text/event-stream content type", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "hi"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
  })

  it("emits OpenAI SSE chunks with correct shape", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "hello"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const dataLines = text.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
    expect(dataLines.length).toBeGreaterThan(0)

    const firstChunk = JSON.parse(dataLines[0]!.slice(6)) as Record<string, unknown>
    expect(firstChunk.object).toBe("chat.completion.chunk")
    expect(typeof firstChunk.id).toBe("string")
    expect((firstChunk.id as string).startsWith("chatcmpl-")).toBe(true)

    const choices = firstChunk.choices as Array<Record<string, unknown>>
    expect(choices[0]!.delta).toHaveProperty("role", "assistant")
  })

  it("emits text content chunks", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0),
      textDelta(0, "Hello"), textDelta(0, " World"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const contentChunks = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as Record<string, unknown>)
      .filter(c => {
        const choices = c.choices as Array<Record<string, unknown>>
        const delta = choices[0]!.delta as Record<string, unknown>
        return typeof delta.content === "string" && delta.content.length > 0
      })
      .map(c => {
        const choices = c.choices as Array<Record<string, unknown>>
        return (choices[0]!.delta as Record<string, unknown>).content as string
      })

    expect(contentChunks.join("")).toBe("Hello World")
  })

  it("emits finish_reason stop in final chunk", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "done"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const chunks = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => JSON.parse(l.slice(6)) as Record<string, unknown>)

    const finishChunk = chunks.find(c => {
      const choices = c.choices as Array<Record<string, unknown>>
      return choices[0]!.finish_reason !== null
    })
    expect(finishChunk).toBeDefined()
    const choices = finishChunk!.choices as Array<Record<string, unknown>>
    expect(choices[0]!.finish_reason).toBe("stop")
  })

  it("ends stream with data: [DONE]", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0), textDelta(0, "ok"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    expect(text).toContain("data: [DONE]")
  })

  it("all chunks share the same completion id", async () => {
    mockMessages = [
      messageStart("msg_1"), textBlockStart(0),
      textDelta(0, "a"), textDelta(0, "b"),
      blockStop(0), messageDelta("end_turn"), messageStop(),
    ]
    const app = createTestApp()

    const res = await postChatCompletion(app, {
      stream: true,
      messages: [{ role: "user", content: "Hi" }],
    })

    const text = await readStream(res)
    const ids = text.split("\n")
      .filter(l => l.startsWith("data: ") && l !== "data: [DONE]")
      .map(l => (JSON.parse(l.slice(6)) as Record<string, unknown>).id as string)

    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(1)
    expect([...uniqueIds][0]).toMatch(/^chatcmpl-/)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

describe("GET /v1/models", () => {
  it("returns model list in OpenAI format", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.object).toBe("list")
    const data = body.data as Array<Record<string, unknown>>
    expect(data).toBeArray()
    expect(data.length).toBeGreaterThan(0)
  })

  it("includes claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await res.json() as Record<string, unknown>
    const ids = (body.data as Array<Record<string, unknown>>).map(m => m.id)
    expect(ids).toContain("claude-sonnet-4-6")
    expect(ids).toContain("claude-opus-4-6")
    expect(ids).toContain("claude-haiku-4-5-20251001")
  })

  it("each model has required fields", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await res.json() as Record<string, unknown>
    for (const model of body.data as Array<Record<string, unknown>>) {
      expect(model.object).toBe("model")
      expect(typeof model.id).toBe("string")
      expect(typeof model.context_window).toBe("number")
      expect(typeof model.created).toBe("number")
    }
  })

  it("context_window is a positive number for all models", async () => {
    // Subscription-dependent value tested in openai.test.ts unit tests
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    const body = await res.json() as Record<string, unknown>
    for (const model of body.data as Array<Record<string, unknown>>) {
      expect(model.context_window as number).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Regression: existing /v1/messages still works
// ---------------------------------------------------------------------------

describe("Regression: /v1/messages unaffected", () => {
  beforeEach(() => {
    mockMessages = []
    clearSessionCache()
  })

  it("still returns Anthropic format from /v1/messages", async () => {
    mockMessages = [assistantMessage([{ type: "text", text: "Anthropic response" }])]
    const app = createTestApp()

    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 50,
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      }),
    }))

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // Anthropic format has "type": "message", not "object": "chat.completion"
    expect(body.type).toBe("message")
    expect(body.role).toBe("assistant")
    expect(body.object).toBeUndefined()
  })

  it("/v1/messages 400 for missing messages still works", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", stream: false }),
    }))
    expect(res.status).toBe(400)
  })
})
