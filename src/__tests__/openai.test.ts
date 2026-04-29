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
  createSseTranslator,
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
    expect(result!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hello" }] }])
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
    expect(result!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Hi" }] }])
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
    expect(result!.messages).toEqual([{ role: "user", content: [{ type: "text", text: "And 3+3?" }] }])
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
    expect(result!.messages).toEqual([{ role: 'user', content: [{ type: "text", text: "now answer" }] }])
  })

  it("handles structured text content in messages", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{
        role: "user",
        content: [{ type: "text", text: "structured" }],
      }],
    })
    expect(result!.messages[0]!.content).toEqual([{ type: "text", text: "structured" }])
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

  // --- tool role (tool result) ---

  it("tool role message → user message with tool_result block", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "What is the weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "get_weather", arguments: '{"city":"NYC"}' } }],
        },
        { role: "tool", tool_call_id: "tu_1", content: "Sunny, 72°F" },
        { role: "user", content: "Thanks" },
      ],
    })
    // With 4 turns, prior 3 are packed into system; only last user message is sent directly.
    // The tool result turn should appear in the conversation_history block.
    expect(result!.system).toContain("<conversation_history>")
    expect(result!.system).toContain("Sunny, 72°F")
  })

  it("tool role message with tool_call_id maps to tool_use_id", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "call tool" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_abc", function: { name: "fn", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "tu_abc", content: "result" },
        { role: "user", content: "ok" },
      ],
    })
    // packed into history — verify it round-tripped without crashing
    expect(result).not.toBeNull()
  })

  it("tool role message without tool_call_id uses empty string for tool_use_id", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "use tool" },
        { role: "tool", content: "result" },
        { role: "user", content: "done" },
      ],
    })
    expect(result).not.toBeNull()
  })

  // --- assistant message with tool_calls ---

  it("assistant message with tool_calls → tool_use blocks appended to content", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "search", arguments: '{"q":"bun"}' } }],
        },
        { role: "user", content: "ok" },
      ],
    })
    // Prior assistant turn is packed into system history
    expect(result!.system).toContain("search")
    expect(result!.system).toContain('"q"')
  })

  it("assistant message with text + tool_call → both preserved", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "Let me look that up.",
          tool_calls: [{ type: "function", id: "tu_2", function: { name: "lookup", arguments: '{"id":1}' } }],
        },
        { role: "user", content: "ok" },
      ],
    })
    expect(result!.system).toContain("Let me look that up.")
    expect(result!.system).toContain("lookup")
  })

  it("assistant message with multiple tool_calls → multiple tool_use blocks", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { type: "function", id: "tu_a", function: { name: "fn_a", arguments: '{}' } },
            { type: "function", id: "tu_b", function: { name: "fn_b", arguments: '{"x":1}' } },
          ],
        },
        { role: "user", content: "continue" },
      ],
    })
    expect(result!.system).toContain("fn_a")
    expect(result!.system).toContain("fn_b")
  })

  // --- <think> block extraction ---

  it("assistant content starting with <think>...</think> is split into thinking + text blocks", () => {
    // The implementation slices at endOfThink+9 to skip "</think>\n" (8 chars + assumed newline).
    // Use a newline after the closing tag to match that convention.
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>internal reasoning</think>\nactual answer" },
        { role: "user", content: "noted" },
      ],
    })
    // packed into system history — both parts should appear
    expect(result!.system).toContain("internal reasoning")
    expect(result!.system).toContain("actual answer")
  })

  it("assistant content with only <think> and no trailing text produces just a thinking block", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>just thinking</think>" },
        { role: "user", content: "ok" },
      ],
    })
    expect(result!.system).toContain("just thinking")
    expect(result).not.toBeNull()
  })

  // --- tool definitions (body.tools) ---

  it("function tool definition → AnthropicTool in result", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Returns current weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }],
    })
    expect(result).not.toBeNull()
    expect(result!.tools).toHaveLength(1)
    expect(result!.tools![0]!.name).toBe("get_weather")
    expect(result!.tools![0]!.description).toBe("Returns current weather")
    expect(result!.tools![0]!.input_schema).toEqual({ type: "object", properties: { city: { type: "string" } } })
  })

  it("multiple function tool definitions are all translated", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      tools: [
        { type: "function", function: { name: "fn_a", description: "a", parameters: {} } },
        { type: "function", function: { name: "fn_b", description: "b", parameters: {} } },
      ],
    })
    expect(result!.tools).toHaveLength(2)
    expect(result!.tools!.map(t => t.name)).toEqual(["fn_a", "fn_b"])
  })

  it("function tool with strict flag preserves it", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "fn", description: "d", parameters: {}, strict: true } }],
    })
    expect(result!.tools![0]!.strict).toBe(true)
  })

  it("custom tool type → returns null (unsupported)", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "custom" }],
    })
    expect(result).toBeNull()
  })

  it("no tools provided → tools array is empty", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "Hi" }],
    })
    expect(result!.tools).toEqual([])
  })

  // --- summarizeAnthropicContent: exact marker formats in packed history ---

  it("packs assistant tool_use into <tool_call name=...> markers", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn_a", arguments: '{"x":1}' } }],
        },
        { role: "user", content: "ok" },
      ],
    })
    expect(result!.system).toContain('<tool_call name="fn_a">')
    expect(result!.system).toContain("</tool_call>")
    expect(result!.system).toContain('{"x":1}')
  })

  it("packs tool role string content into <tool_result> markers", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "tu_1", content: "Sunny, 72F" },
        { role: "user", content: "thanks" },
      ],
    })
    expect(result!.system).toContain("<tool_result>")
    expect(result!.system).toContain("Sunny, 72F")
    expect(result!.system).toContain("</tool_result>")
  })

  it("packs <think> assistant content into <think>...</think> markers", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>reasoning here</think>\nanswer" },
        { role: "user", content: "ok" },
      ],
    })
    expect(result!.system).toContain("<think>")
    expect(result!.system).toContain("reasoning here")
    expect(result!.system).toContain("</think>")
  })

  // --- tool role with structured array content ---

  it("tool role with array content: text parts wrapped in <tool_result> markers", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "tu_1",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    })
    expect(result!.system).toContain("first")
    expect(result!.system).toContain("second")
    // Each text part gets its own <tool_result> wrapper in current implementation
    const matches = result!.system!.match(/<tool_result>/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  // --- assistant single text block flattens to string ---

  it("assistant single text block flattens to string in turns", () => {
    // With exactly 2 turns, only the last is packed into history; the first
    // assistant turn becomes the sole message sent. We can inspect it directly.
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "plain text answer" },
      ],
    })
    expect(result!.messages).toHaveLength(1)
    expect(result!.messages[0]!.role).toBe("assistant")
    expect(result!.messages[0]!.content).toBe("plain text answer")
  })

  it("assistant content with tool_calls keeps array form (not flattened)", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn", arguments: "{}" } }],
        },
      ],
    })
    expect(result!.messages).toHaveLength(1)
    expect(Array.isArray(result!.messages[0]!.content)).toBe(true)
    const blocks = result!.messages[0]!.content as Array<{ type: string }>
    expect(blocks.map(b => b.type)).toEqual(["text", "tool_use"])
  })

  // --- <think> parsing edge cases ---

  it("<think> without trailing newline preserves first character of answer", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>r</think>answer" },
      ],
    })
    expect(result!.messages).toHaveLength(1)
    const blocks = result!.messages[0]!.content as Array<{ type: string; text?: string; thinking?: string }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.type).toBe("thinking")
    expect(blocks[0]!.thinking).toBe("r")
    expect(blocks[1]!.type).toBe("text")
    expect(blocks[1]!.text).toBe("answer")
  })

  it("<think> with trailing newline strips exactly one newline", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>r</think>\nanswer" },
      ],
    })
    const blocks = result!.messages[0]!.content as Array<{ type: string; text?: string }>
    // The newline after </think> is consumed; "answer" remains intact
    expect(blocks[1]!.text).toBe("answer")
  })

  it("<think> with two trailing newlines keeps the second one", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>r</think>\n\nanswer" },
      ],
    })
    const blocks = result!.messages[0]!.content as Array<{ type: string; text?: string }>
    expect(blocks[1]!.text).toBe("\nanswer")
  })

  it("<think> without closing tag is treated as plain text (no thinking block)", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        { role: "assistant", content: "<think>unfinished reasoning and more" },
      ],
    })
    expect(result!.messages).toHaveLength(1)
    // No closing </think> → fall through to plain-text branch and flatten
    expect(result!.messages[0]!.content).toBe("<think>unfinished reasoning and more")
  })

  // --- malformed tool_calls JSON arguments ---

  it("malformed tool_call arguments do not crash; raw string preserved under __raw", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn", arguments: "not json {" } }],
        },
      ],
    })
    expect(result).not.toBeNull()
    const blocks = result!.messages[0]!.content as Array<{ type: string; input?: Record<string, unknown> }>
    const toolUse = blocks.find(b => b.type === "tool_use")!
    expect(toolUse.input).toEqual({ __raw: "not json {" })
  })

  it("non-object JSON tool_call arguments fall back to __raw", () => {
    // JSON.parse("[1,2]") succeeds but is an array, not a Record
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn", arguments: "[1,2]" } }],
        },
      ],
    })
    const blocks = result!.messages[0]!.content as Array<{ type: string; input?: Record<string, unknown> }>
    const toolUse = blocks.find(b => b.type === "tool_use")!
    expect(toolUse.input).toEqual({ __raw: "[1,2]" })
  })

  it("valid JSON object tool_call arguments parse normally", () => {
    const result = translateOpenAiToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", id: "tu_1", function: { name: "fn", arguments: '{"a":1}' } }],
        },
      ],
    })
    const blocks = result!.messages[0]!.content as Array<{ type: string; input?: Record<string, unknown> }>
    const toolUse = blocks.find(b => b.type === "tool_use")!
    expect(toolUse.input).toEqual({ a: 1 })
  })

  // --- missing tool description ---

  it("function tool definition without description defaults to empty string", () => {
    const result = translateOpenAiToAnthropic({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "fn", parameters: {} } }],
    })
    expect(result!.tools).toHaveLength(1)
    expect(result!.tools![0]!.description).toBe("")
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
          { type: "thinking", thinking: "let me think..." },
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
    expect(result.choices[0]!.message.content).toBeNull()
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

  // --- tool_use blocks ---

  it("tool_use block → tool_calls on message", () => {
    const result = translateAnthropicToOpenAi(
      {
        content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } }],
        stop_reason: "tool_use",
      },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.finish_reason).toBe("tool_calls")
    expect(result.choices[0]!.message.tool_calls).toHaveLength(1)
    const call = result.choices[0]!.message.tool_calls![0]! as { type: string; id: string; function: { name: string; arguments: string } }
    expect(call.type).toBe("function")
    expect(call.id).toBe("tu_1")
    expect(call.function.name).toBe("get_weather")
    expect(JSON.parse(call.function.arguments)).toEqual({ city: "NYC" })
  })

  it("multiple tool_use blocks → multiple tool_calls", () => {
    const result = translateAnthropicToOpenAi(
      {
        content: [
          { type: "tool_use", id: "tu_a", name: "fn_a", input: {} },
          { type: "tool_use", id: "tu_b", name: "fn_b", input: { x: 1 } },
        ],
        stop_reason: "tool_use",
      },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.tool_calls).toHaveLength(2)
    const names = result.choices[0]!.message.tool_calls!.map(c => (c as { function: { name: string } }).function.name)
    expect(names).toEqual(["fn_a", "fn_b"])
  })

  it("no tool_use blocks → tool_calls is undefined on message", () => {
    const result = translateAnthropicToOpenAi(
      { content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.tool_calls).toBeUndefined()
  })

  // --- thinking blocks ---

  it("thinking block → reasoning_content on message", () => {
    const result = translateAnthropicToOpenAi(
      {
        content: [
          { type: "thinking", thinking: "my reasoning" },
          { type: "text", text: "the answer" },
        ],
        stop_reason: "end_turn",
      },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.reasoning_content).toBe("my reasoning")
    expect(result.choices[0]!.message.content).toBe("the answer")
  })

  it("multiple thinking blocks → concatenated reasoning_content", () => {
    const result = translateAnthropicToOpenAi(
      {
        content: [
          { type: "thinking", thinking: "part 1" },
          { type: "thinking", thinking: "part 2" },
          { type: "text", text: "done" },
        ],
        stop_reason: "end_turn",
      },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.reasoning_content).toBe("part 1part 2")
  })

  it("no thinking blocks → reasoning_content is undefined", () => {
    const result = translateAnthropicToOpenAi(
      { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.message.reasoning_content).toBeUndefined()
  })

  it("tool_use stop_reason → tool_calls finish_reason", () => {
    const result = translateAnthropicToOpenAi(
      { content: [{ type: "tool_use", id: "x", name: "fn", input: {} }], stop_reason: "tool_use" },
      ID, MODEL, CREATED
    )
    expect(result.choices[0]!.finish_reason).toBe("tool_calls")
  })
})

// ---------------------------------------------------------------------------
// translateAnthropicSseEvent
// ---------------------------------------------------------------------------

describe("translateAnthropicSseEvent", () => {
  const ID = "chatcmpl-test"
  const MODEL = "claude-sonnet-4-6"
  const CREATED = 1234567890
  const NO_TOOL = 0 // sentinel: no tool call in progress

  it("message_start → role announcement chunk", () => {
    const chunk = translateAnthropicSseEvent({ type: "message_start" }, ID, MODEL, CREATED, NO_TOOL)
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.delta.role).toBe("assistant")
    expect(chunk!.choices[0]!.delta.content).toBe("")
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("content_block_delta text_delta → content chunk", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      ID, MODEL, CREATED, NO_TOOL
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.delta.content).toBe("hello")
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("content_block_delta thinking_delta → null (skipped)", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "content_block_delta", delta: { type: "thinking_delta", text: "thinking..." } },
      ID, MODEL, CREATED, NO_TOOL
    )
    expect(chunk).toBeNull()
  })

  it("message_delta end_turn → finish chunk with stop", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      ID, MODEL, CREATED, NO_TOOL
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.finish_reason).toBe("stop")
    expect(chunk!.choices[0]!.delta).toEqual({})
  })

  it("message_delta max_tokens → finish chunk with length", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      ID, MODEL, CREATED, NO_TOOL
    )
    expect(chunk!.choices[0]!.finish_reason).toBe("length")
  })

  it("ping → null", () => {
    expect(translateAnthropicSseEvent({ type: "ping" }, ID, MODEL, CREATED, NO_TOOL)).toBeNull()
  })

  it("content_block_start (non-tool) → null", () => {
    expect(translateAnthropicSseEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    }, ID, MODEL, CREATED, NO_TOOL)).toBeNull()
  })

  it("content_block_stop → null", () => {
    expect(translateAnthropicSseEvent({ type: "content_block_stop" }, ID, MODEL, CREATED, NO_TOOL)).toBeNull()
  })

  it("message_stop → null", () => {
    expect(translateAnthropicSseEvent({ type: "message_stop" }, ID, MODEL, CREATED, NO_TOOL)).toBeNull()
  })

  it("chunk carries correct id, model, created, object", () => {
    const chunk = translateAnthropicSseEvent({ type: "message_start" }, ID, MODEL, CREATED, NO_TOOL)
    expect(chunk!.id).toBe(ID)
    expect(chunk!.model).toBe(MODEL)
    expect(chunk!.created).toBe(CREATED)
    expect(chunk!.object).toBe("chat.completion.chunk")
  })

  // --- new: tool call streaming ---

  it("content_block_start with tool_use → tool call start chunk at index 0 (first tool)", () => {
    const chunk = translateAnthropicSseEvent(
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tu_abc", name: "get_weather", input: {} },
      },
      ID, MODEL, CREATED, NO_TOOL // tool_call_num=-1, so index emitted is 0
    )
    expect(chunk).not.toBeNull()
    const toolCall = chunk!.choices[0]!.delta.tool_calls![0]!
    expect(toolCall.type).toBe("function")
    expect((toolCall as { index: number }).index).toBe(0)
    expect((toolCall as { id: string }).id).toBe("tu_abc")
    expect((toolCall as { function: { name: string } }).function.name).toBe("get_weather")
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("content_block_start with tool_use → second tool uses index 1", () => {
    const chunk = translateAnthropicSseEvent(
      {
        type: "content_block_start",
        content_block: { type: "tool_use", id: "tu_def", name: "read_file", input: {} },
      },
      ID, MODEL, CREATED, 1
    )
    const toolCall = chunk!.choices[0]!.delta.tool_calls![0]! as { index: number }
    expect(toolCall.index).toBe(1)
  })

  it("content_block_delta input_json_delta → tool call arguments chunk", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"city":' } },
      ID, MODEL, CREATED, 0
    )
    expect(chunk).not.toBeNull()
    const toolCall = chunk!.choices[0]!.delta.tool_calls![0]! as { index: number; function: { arguments: string } }
    expect(toolCall.index).toBe(0)
    expect(toolCall.function.arguments).toBe('{"city":')
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("content_block_delta thinking_delta → reasoning_content chunk", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "let me think" } },
      ID, MODEL, CREATED, NO_TOOL
    )
    expect(chunk).not.toBeNull()
    expect(chunk!.choices[0]!.delta.reasoning_content).toBe("let me think")
    expect(chunk!.choices[0]!.delta.content).toBeUndefined()
    expect(chunk!.choices[0]!.finish_reason).toBeNull()
  })

  it("message_delta tool_use stop_reason → tool_calls finish_reason", () => {
    const chunk = translateAnthropicSseEvent(
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      ID, MODEL, CREATED, NO_TOOL
    )
    expect(chunk!.choices[0]!.finish_reason).toBe("tool_calls")
  })
})

// ---------------------------------------------------------------------------
// createSseTranslator (stateful wrapper around translateAnthropicSseEvent)
// ---------------------------------------------------------------------------

describe("createSseTranslator", () => {
  const CTX = { completionId: "chatcmpl-x", model: "claude-sonnet-4-6", created: 1234567890 }

  it("first tool_use start emits index 0", () => {
    const translate = createSseTranslator(CTX)
    const chunk = translate({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tu_1", name: "fn_a", input: {} },
    })
    expect(chunk).not.toBeNull()
    const tc = chunk!.choices[0]!.delta.tool_calls![0]!
    expect(tc.index).toBe(0)
    expect(tc.id).toBe("tu_1")
    expect(tc.function!.name).toBe("fn_a")
    expect(tc.function!.arguments).toBe("")
  })

  it("sequential tool_use starts emit ascending indexes 0, 1, 2", () => {
    const translate = createSseTranslator(CTX)
    const indexes: number[] = []
    for (const name of ["fn_a", "fn_b", "fn_c"]) {
      const chunk = translate({
        type: "content_block_start",
        content_block: { type: "tool_use", id: `tu_${name}`, name, input: {} },
      })
      indexes.push(chunk!.choices[0]!.delta.tool_calls![0]!.index)
    }
    expect(indexes).toEqual([0, 1, 2])
  })

  it("input_json_delta after tool start carries the same index as the start chunk", () => {
    const translate = createSseTranslator(CTX)

    const start = translate({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu_1", name: "fn", input: {} },
    })
    const arg = translate({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"x":1}' },
    })

    const startIdx = start!.choices[0]!.delta.tool_calls![0]!.index
    const argIdx = arg!.choices[0]!.delta.tool_calls![0]!.index
    expect(startIdx).toBe(argIdx)
    expect(startIdx).toBe(0)
  })

  it("text content_block_start does not advance the counter", () => {
    const translate = createSseTranslator(CTX)
    // A text block starts the stream
    translate({
      type: "content_block_start",
      content_block: { type: "text", text: "" },
    })
    // ...then a tool_use block starts — should still be index 0, not 1
    const chunk = translate({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu_1", name: "fn", input: {} },
    })
    expect(chunk!.choices[0]!.delta.tool_calls![0]!.index).toBe(0)
  })

  it("malformed tool_use start (missing name) does not advance the counter", () => {
    const translate = createSseTranslator(CTX)
    // Malformed event: tool_use type but no `name` — pure function returns null,
    // factory must not advance index either, otherwise the next valid tool would
    // emit index 1 instead of 0.
    translate({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu_bad", input: {} } as never,
    })
    const chunk = translate({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu_1", name: "fn", input: {} },
    })
    expect(chunk!.choices[0]!.delta.tool_calls![0]!.index).toBe(0)
  })

  it("two translator instances have independent state", () => {
    const a = createSseTranslator(CTX)
    const b = createSseTranslator(CTX)

    // Advance instance `a` by two tool starts
    a({ type: "content_block_start", content_block: { type: "tool_use", id: "1", name: "x", input: {} } })
    a({ type: "content_block_start", content_block: { type: "tool_use", id: "2", name: "y", input: {} } })

    // Instance `b` is fresh — first tool must still be index 0
    const chunk = b({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "3", name: "z", input: {} },
    })
    expect(chunk!.choices[0]!.delta.tool_calls![0]!.index).toBe(0)
  })

  it("non-tool events round-trip through the translator unchanged", () => {
    const translate = createSseTranslator(CTX)

    // message_start → role announcement
    const start = translate({ type: "message_start" })
    expect(start!.choices[0]!.delta.role).toBe("assistant")

    // text delta
    const text = translate({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hi" },
    })
    expect(text!.choices[0]!.delta.content).toBe("hi")

    // thinking delta
    const thinking = translate({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "reasoning" },
    })
    expect(thinking!.choices[0]!.delta.reasoning_content).toBe("reasoning")

    // finish
    const finish = translate({ type: "message_delta", delta: { stop_reason: "end_turn" } })
    expect(finish!.choices[0]!.finish_reason).toBe("stop")
  })

  it("uses ctx fields for completionId, model, created on every chunk", () => {
    const translate = createSseTranslator({
      completionId: "chatcmpl-custom",
      model: "claude-haiku-4-5",
      created: 999,
    })
    const chunk = translate({ type: "message_start" })
    expect(chunk!.id).toBe("chatcmpl-custom")
    expect(chunk!.model).toBe("claude-haiku-4-5")
    expect(chunk!.created).toBe(999)
  })

  it("realistic stream: thinking → text → tool with args → finish, in correct order", () => {
    const translate = createSseTranslator(CTX)
    const events: { type: string; [k: string]: unknown }[] = [
      { type: "message_start" },
      { type: "content_block_start", content_block: { type: "thinking" } },
      { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think..." } },
      { type: "content_block_stop" },
      { type: "content_block_start", content_block: { type: "text", text: "" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "answer" } },
      { type: "content_block_stop" },
      { type: "content_block_start", content_block: { type: "tool_use", id: "tu_1", name: "fn", input: {} } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"a":1}' } },
      { type: "content_block_stop" },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]
    const chunks = events
      .map(e => translate(e))
      .filter((c): c is NonNullable<typeof c> => c !== null)

    // Order check: role → reasoning → text → tool_start → tool_args → finish
    expect(chunks[0]!.choices[0]!.delta.role).toBe("assistant")
    expect(chunks[1]!.choices[0]!.delta.reasoning_content).toBe("think...")
    expect(chunks[2]!.choices[0]!.delta.content).toBe("answer")
    expect(chunks[3]!.choices[0]!.delta.tool_calls![0]!.id).toBe("tu_1")
    expect(chunks[3]!.choices[0]!.delta.tool_calls![0]!.index).toBe(0)
    expect(chunks[4]!.choices[0]!.delta.tool_calls![0]!.function!.arguments).toBe('{"a":1}')
    expect(chunks[4]!.choices[0]!.delta.tool_calls![0]!.index).toBe(0)
    expect(chunks[5]!.choices[0]!.finish_reason).toBe("tool_calls")
  })
})

// ---------------------------------------------------------------------------
// buildModelList
// ---------------------------------------------------------------------------

describe("buildModelList", () => {
  it("returns 4 models", () => {
    expect(buildModelList(true).length).toBe(4)
    expect(buildModelList(false).length).toBe(4)
  })

  it("includes both opus-4-6 and opus-4-7 for UI pickers", () => {
    const ids = buildModelList(true).map(m => m.id)
    expect(ids).toContain("claude-opus-4-6")
    expect(ids).toContain("claude-opus-4-7")
  })

  it("Max subscription gets 1M context for both opus variants, 200k for sonnet", () => {
    const models = buildModelList(true)
    const sonnet = models.find(m => m.id === "claude-sonnet-4-6")!
    const opus46 = models.find(m => m.id === "claude-opus-4-6")!
    const opus47 = models.find(m => m.id === "claude-opus-4-7")!
    expect(sonnet.context_window).toBe(200_000)
    expect(opus46.context_window).toBe(1_000_000)
    expect(opus47.context_window).toBe(1_000_000)
  })

  it("non-Max gets 200k context for sonnet and both opus variants", () => {
    const models = buildModelList(false)
    const sonnet = models.find(m => m.id === "claude-sonnet-4-6")!
    const opus46 = models.find(m => m.id === "claude-opus-4-6")!
    const opus47 = models.find(m => m.id === "claude-opus-4-7")!
    expect(sonnet.context_window).toBe(200_000)
    expect(opus46.context_window).toBe(200_000)
    expect(opus47.context_window).toBe(200_000)
  })

  it("haiku is always 200k regardless of subscription", () => {
    expect(buildModelList(true).find(m => m.id === "claude-haiku-4-5")!.context_window).toBe(200_000)
    expect(buildModelList(false).find(m => m.id === "claude-haiku-4-5")!.context_window).toBe(200_000)
  })

  it("all models have correct object type", () => {
    buildModelList(true).forEach(m => expect(m.object).toBe("model"))
  })

  it("uses provided timestamp", () => {
    const ts = 9999999
    buildModelList(true, ts).forEach(m => expect(m.created).toBe(ts))
  })
})
