/**
 * Unit tests for src/proxy/openai.ts — pure translation functions.
 * No I/O, no mocks required.
 */

import { describe, it, expect } from "bun:test"
import {
  extractOpenAiContent,
  translateOpenAiToAnthropic,
  translateAnthropicToOpenAi,
  translateAnthropicSseEvent,
  buildModelList,
} from "../proxy/openai"

// ---------------------------------------------------------------------------
// extractOpenAiContent
// ---------------------------------------------------------------------------

describe("extractOpenAiContent", () => {
  it("returns string content as-is", () => {
    expect(extractOpenAiContent("hello world")).toBe("hello world")
  })

  it("extracts text from content array", () => {
    expect(extractOpenAiContent([
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ])).toBe("hello world")
  })

  it("summarizes image parts in text extraction", () => {
    expect(extractOpenAiContent([
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      { type: "text", text: "only this" },
    ])).toBe("[Image attached]only this")
  })

  it("returns empty string for empty array", () => {
    expect(extractOpenAiContent([])).toBe("")
  })
})

// ---------------------------------------------------------------------------
// translateOpenAiToAnthropic
// ---------------------------------------------------------------------------

describe("translateOpenAiToAnthropic", () => {
  it("returns null for missing messages", () => {
    expect(translateOpenAiToAnthropic({})).toBeNull()
  })

  it("returns null for empty messages array", () => {
    expect(translateOpenAiToAnthropic({ messages: [] })).toBeNull()
  })

  it("translates a single user message", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hello" }],
    })
    expect(result).not.toBeNull()
    expect(result!.messages).toEqual([{ role: "user", content: "Hello" }])
    expect(result!.system).toBeUndefined()
  })

  it("extracts system message into system field", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    })
    expect(result!.system).toBe("You are helpful.")
    expect(result!.messages).toEqual([{ role: "user", content: "Hi" }])
  })

  it("concatenates multiple system messages", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "system", content: "Rule 1." },
        { role: "system", content: "Rule 2." },
        { role: "user", content: "Hi" },
      ],
    })
    expect(result!.system).toBe("Rule 1.\nRule 2.")
  })

  it("packs multi-turn history into system context", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "What is 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "And 3+3?" },
      ],
    })
    // Only the last message is sent
    expect(result!.messages).toEqual([{ role: "user", content: "And 3+3?" }])
    // Prior turns packed into system
    expect(result!.system).toContain("<conversation_history>")
    expect(result!.system).toContain("user: What is 2+2?")
    expect(result!.system).toContain("assistant: 4")
  })

  it("prepends system message before conversation history", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Turn 1" },
        { role: "assistant", content: "OK" },
        { role: "user", content: "Turn 2" },
      ],
    })
    expect(result!.system).toMatch(/^Be concise\./)
    expect(result!.system).toContain("<conversation_history>")
  })

  it("defaults model to claude-sonnet-4-6", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
    })
    expect(result!.model).toBe("claude-sonnet-4-6")
  })

  it("passes through specified model", () => {
    const result = translateOpenAiToAnthropic({
      model: "claude-haiku-4-5-20251001",
      messages: [{ role: "user", content: "Hi" }],
    })
    expect(result!.model).toBe("claude-haiku-4-5-20251001")
  })

  it("defaults max_tokens to 8192", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
    })
    expect(result!.max_tokens).toBe(8192)
  })

  it("uses max_completion_tokens as fallback", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      max_completion_tokens: 4096,
    })
    expect(result!.max_tokens).toBe(4096)
  })

  it("max_tokens takes precedence over max_completion_tokens", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      max_completion_tokens: 4096,
    })
    expect(result!.max_tokens).toBe(1024)
  })

  it("forwards temperature when present", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.7,
    })
    expect(result!.temperature).toBe(0.7)
  })

  it("does not include temperature when absent", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
    })
    expect(result!.temperature).toBeUndefined()
  })

  it("forwards top_p when present", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      top_p: 0.9,
    })
    expect(result!.top_p).toBe(0.9)
  })

  it("maps assistant role correctly", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "How are you?" },
      ],
    })
    expect(result!.system).toContain("assistant: Hello")
  })

  it("keeps multimodal history as placeholders in packed system context", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
          ],
        },
        { role: "assistant", content: "I see it" },
        { role: "user", content: "now answer" },
      ],
    })

    expect(result!.system).toContain('user: look[Image attached]')
    expect(result!.messages).toEqual([{ role: 'user', content: 'now answer' }])
  })

  it("handles structured text content in messages", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "structured" }],
      }],
    })
    expect(result!.messages[0]!.content).toBe("structured")
  })

  it("preserves data-url image blocks in the last user message", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
        ],
      }],
    })

    expect(result!.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
      ],
    }])
  })

  it("adds an explicit placeholder for unsupported external image urls", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://example.com/test.png" } },
        ],
      }],
    })

    expect(result!.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "text", text: "[Unsupported image_url omitted: only data URLs are currently supported]" },
      ],
    }])
  })

  it("sets stream from body", () => {
    const resultStream = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    })
    expect(resultStream!.stream).toBe(true)

    const resultNoStream = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    })
    expect(resultNoStream!.stream).toBe(false)
  })

  it("defaults stream to false when omitted", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
    })
    expect(result!.stream).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// translateAnthropicToOpenAi
// ---------------------------------------------------------------------------

describe("translateAnthropicToOpenAi", () => {
  const ID = "chatcmpl-test"
  const MODEL = "claude-sonnet-4-6"
  const CREATED = 1234567890

  it("returns correct OpenAI completion shape", () => {
    const result = translateAnthropicToOpenAi(
      { content: [{ type: "text", text: "Hello!" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } },
      ID, MODEL, CREATED
    )
    expect(result.id).toBe(ID)
    expect(result.object).toBe("chat.completion")
    expect(result.created).toBe(CREATED)
    expect(result.model).toBe(MODEL)
    expect(result.choices[0]!.message.role).toBe("assistant")
    expect(result.choices[0]!.message.content).toBe("Hello!")
    expect(result.choices[0]!.finish_reason).toBe("stop")
    expect(result.usage.prompt_tokens).toBe(10)
    expect(result.usage.completion_tokens).toBe(5)
    expect(result.usage.total_tokens).toBe(15)
  })

  it("maps max_tokens stop_reason to length finish_reason", () => {
    const result = translateAnthropicToOpenAi(
      { content: [{ type: "text", text: "truncated" }], stop_reason: "max_tokens" },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.finish_reason).toBe("length")
  })

  it("filters out thinking blocks", () => {
    const result = translateAnthropicToOpenAi(
      {
        content: [
          { type: "thinking", text: "let me think..." },
          { type: "text", text: "actual answer" },
        ],
        stop_reason: "end_turn",
      },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.content).toBe("actual answer")
  })

  it("handles empty content", () => {
    const result = translateAnthropicToOpenAi(
      { content: [], stop_reason: "end_turn" },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.content).toBe("")
  })

  it("handles missing usage", () => {
    const result = translateAnthropicToOpenAi(
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
      ID, MODEL, CREATED
    )
    expect(result.usage.prompt_tokens).toBe(0)
    expect(result.usage.completion_tokens).toBe(0)
    expect(result.usage.total_tokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// translateAnthropicSseEvent
// ---------------------------------------------------------------------------

describe("translateAnthropicSseEvent", () => {
  const ID = "chatcmpl-test"
  const MODEL = "claude-sonnet-4-6"
  const CREATED = 1234567890

  it("message_start → role announcement chunk", () => {
    const chunk = translateAnthropicSseEvent({ type: "message_start" }, ID, MODEL, CREATED)
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.delta.role).toBe("assistant")
    expect(chunk!.choices[0]!.delta.content).toBe("")
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("content_block_delta text_delta → content chunk", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      ID, MODEL, CREATED
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.delta.content).toBe("hello")
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("content_block_delta thinking_delta → null (skipped)", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "content_block_delta", delta: { type: "thinking_delta", text: "thinking..." } },
      ID, MODEL, CREATED
    )
    expect(chunk).toBeNull()
  })

  it("message_delta end_turn → finish chunk with stop", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ID, MODEL, CREATED
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.finish_reason).toBe("stop")
    expect(chunk!.choices[0]!.delta).toEqual({})
  })

  it("message_delta max_tokens → finish chunk with length", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      ID, MODEL, CREATED
    )
    expect(chunk!.choices[0]!.finish_reason).toBe("length")
  })

  it("ping → null", () => {
    expect(translateAnthropicSseEvent({ type: "ping" }, ID, MODEL, CREATED)).toBeNull()
  })

  it("content_block_start → null", () => {
    expect(translateAnthropicSseEvent({ type: "content_block_start" }, ID, MODEL, CREATED)).toBeNull()
  })

  it("content_block_stop → null", () => {
    expect(translateAnthropicSseEvent({ type: "content_block_stop" }, ID, MODEL, CREATED)).toBeNull()
  })

  it("message_stop → null", () => {
    expect(translateAnthropicSseEvent({ type: "message_stop" }, ID, MODEL, CREATED)).toBeNull()
  })

  it("chunk carries correct id, model, created, object", () => {
    const chunk = translateAnthropicSseEvent({ type: "message_start" }, ID, MODEL, CREATED)
    expect(chunk!.id).toBe(ID)
    expect(chunk!.model).toBe(MODEL)
    expect(chunk!.created).toBe(CREATED)
    expect(chunk!.object).toBe("chat.completion.chunk")
  })
})

// ---------------------------------------------------------------------------
// buildModelList
// ---------------------------------------------------------------------------

describe("buildModelList", () => {
  it("returns 3 models", () => {
    expect(buildModelList(true).length).toBe(3)
    expect(buildModelList(false).length).toBe(3)
  })

  it("Max subscription gets 1M context for opus, 200k for sonnet", () => {
    const models = buildModelList(true)
    const sonnet = models.find(m => m.id === "claude-sonnet-4-6")!
    const opus = models.find(m => m.id === "claude-opus-4-6")!
    expect(sonnet.context_window).toBe(200_000)
    expect(opus.context_window).toBe(1_000_000)
  })

  it("non-Max gets 200k context for sonnet and opus", () => {
    const models = buildModelList(false)
    const sonnet = models.find(m => m.id === "claude-sonnet-4-6")!
    const opus = models.find(m => m.id === "claude-opus-4-6")!
    expect(sonnet.context_window).toBe(200_000)
    expect(opus.context_window).toBe(200_000)
  })

  it("haiku is always 200k regardless of subscription", () => {
    expect(buildModelList(true).find(m => m.id === "claude-haiku-4-5-20251001")!.context_window).toBe(200_000)
    expect(buildModelList(false).find(m => m.id === "claude-haiku-4-5-20251001")!.context_window).toBe(200_000)
  })

  it("all models have correct object type", () => {
    buildModelList(true).forEach(m => expect(m.object).toBe("model"))
  })

  it("uses provided timestamp", () => {
    const ts = 9999999
    buildModelList(true, ts).forEach(m => expect(m.created).toBe(ts))
  })
})
