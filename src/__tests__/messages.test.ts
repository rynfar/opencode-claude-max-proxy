/**
 * Unit tests for message parsing utilities.
 */
import { describe, it, expect } from "bun:test"
import { extractAdvisorToolDefinition, getLastUserMessage, normalizeContent, summarizeContentBlockForPrompt } from "../proxy/messages"

describe("normalizeContent", () => {
  it("returns string content as-is", () => {
    expect(normalizeContent("hello")).toBe("hello")
  })

  it("extracts text from text content blocks", () => {
    const content = [{ type: "text", text: "hello world" }]
    expect(normalizeContent(content)).toBe("hello world")
  })

  it("handles tool_use blocks", () => {
    const content = [{ type: "tool_use", id: "tu_1", name: "Read", input: { file: "a.ts" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_use:tu_1:Read:")
    expect(result).toContain('"file":"a.ts"')
  })

  it("handles tool_result blocks with string content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }]
    const result = normalizeContent(content)
    expect(result).toBe("tool_result:tu_1:file contents")
  })

  it("handles tool_result blocks with object content", () => {
    const content = [{ type: "tool_result", tool_use_id: "tu_1", content: { key: "val" } }]
    const result = normalizeContent(content)
    expect(result).toContain("tool_result:tu_1:")
    expect(result).toContain('"key":"val"')
  })

  it("handles server_tool_use blocks", () => {
    const content = [{ type: "server_tool_use", id: "srv_1", name: "advisor", input: {} }]
    const result = normalizeContent(content)
    expect(result).toBe("server_tool_use:srv_1:advisor:{}")
  })

  it("handles advisor_tool_result blocks", () => {
    const content = [{ type: "advisor_tool_result", content: [{ type: "advisor_result", text: "Plan first." }] }]
    const result = normalizeContent(content)
    expect(result).toContain("advisor_tool_result:")
    expect(result).toContain("advisor_result")
  })

  it("handles mixed content blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]
    expect(normalizeContent(content)).toBe("hello\nworld")
  })

  it("JSON stringifies unknown block types", () => {
    const content = [{ type: "image", data: "base64" }]
    const result = normalizeContent(content)
    expect(result).toContain('"type":"image"')
  })

  it("produces stable hashes when cache_control is added to text blocks", () => {
    const without = [{ type: "text", text: "hello" }]
    const withCC = [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }]
    // text blocks extract only .text, so cache_control is already ignored
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to tool_result content blocks", () => {
    const without = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result" }] }]
    const withCC = [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "result", cache_control: { type: "ephemeral" } }] }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("produces stable hashes when cache_control is added to unknown block types", () => {
    const without = [{ type: "image", data: "base64" }]
    const withCC = [{ type: "image", data: "base64", cache_control: { type: "ephemeral" } }]
    expect(normalizeContent(without)).toBe(normalizeContent(withCC))
  })

  it("converts non-string non-array to string", () => {
    expect(normalizeContent(42)).toBe("42")
    expect(normalizeContent(null)).toBe("null")
    expect(normalizeContent(true)).toBe("true")
  })
})

describe("summarizeContentBlockForPrompt", () => {
  it("summarizes server tool use blocks", () => {
    expect(
      summarizeContentBlockForPrompt({ type: "server_tool_use", name: "advisor", input: {} })
    ).toBe("[Server Tool Use: advisor({})]")
  })

  it("summarizes advisor tool results", () => {
    expect(
      summarizeContentBlockForPrompt({ type: "advisor_tool_result", content: [{ type: "advisor_result", text: "Think bigger" }] })
    ).toContain("Advisor Tool Result")
  })
})

describe("extractAdvisorToolDefinition", () => {
  it("extracts a valid advisor tool definition", () => {
    expect(extractAdvisorToolDefinition([
      { type: "advisor_20260301", name: "advisor", model: "claude-opus-4-7", max_uses: 2 },
    ])).toEqual({
      type: "advisor_20260301",
      name: "advisor",
      model: "claude-opus-4-7",
      max_uses: 2,
    })
  })

  it("returns undefined when no advisor tool is present", () => {
    expect(extractAdvisorToolDefinition([{ name: "Read" }])).toBeUndefined()
  })

  it("rejects malformed advisor tool definitions", () => {
    expect(() => extractAdvisorToolDefinition([
      { type: "advisor_20260301", name: "not-advisor", model: "claude-opus-4-7" },
    ])).toThrow("Advisor tool must be named 'advisor'")
  })
})

describe("getLastUserMessage", () => {
  it("returns the last user message", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("second")
  })

  it("returns last message as fallback when no user messages", () => {
    const messages = [
      { role: "assistant", content: "reply" },
    ]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("reply")
  })

  it("handles empty array", () => {
    const result = getLastUserMessage([])
    expect(result).toHaveLength(0)
  })

  it("returns single user message from single-message array", () => {
    const messages = [{ role: "user", content: "only" }]
    const result = getLastUserMessage(messages)
    expect(result).toHaveLength(1)
    expect(result[0]!.content).toBe("only")
  })
})
