/**
 * Unit tests for message parsing utilities.
 */
import { describe, it, expect } from "bun:test"
import { normalizeContent, getLastUserMessage, extractTrailingUserContent } from "../proxy/messages"

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

describe("extractTrailingUserContent — persistent-mode turn delta", () => {
  // Q: Pi's queued follow-up flow. Each HTTP request ends with exactly one
  // trailing user message — either tool_results from the previous turn or
  // a fresh user prompt. Already covered implicitly by scenarios C/D/E/F;
  // this test formalises the contract so the fix doesn't regress it.
  it("scenario Q — single trailing tool_result user message returns its content array", () => {
    const toolResultBlock = { type: "tool_result", tool_use_id: "toolu_Q1", content: "example-host" }
    const messages = [
      { role: "user", content: "read /etc/hostname and reply DONE." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_Q1", name: "read", input: { path: "/etc/hostname" } }] },
      { role: "user", content: [toolResultBlock] },
    ]
    const result = extractTrailingUserContent(messages)
    expect(result).toEqual([toolResultBlock])
  })

  it("scenario Q — follow-up request with a new user text after a completed turn returns just that text", () => {
    const messages = [
      { role: "user", content: "read /etc/hostname and reply DONE." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_Q2", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_Q2", content: "example-host" }] },
      { role: "assistant", content: "DONE." },
      { role: "user", content: "How many characters is that?" },
    ]
    const result = extractTrailingUserContent(messages)
    expect(result).toEqual("How many characters is that?")
  })

  // P: Pi's steer flow. The steering queue flushes between turn_end and the
  // next LLM call, appending a fresh `role: "user"` agent message AFTER the
  // toolResult aggregation — so pi's Anthropic payload ends with two
  // consecutive user messages. Meridian's persistent dispatcher MUST see
  // both content arrays; otherwise the tool_results are stranded and the
  // SDK's pending MCP handlers never resolve.
  //
  // Real-world repro: pi session
  // `/Users/cartwmic/.pi/agent/sessions/--Users-cartwmic-git-oxide-clone--/
  //  2026-04-21T03-27-41-113Z_019dae14-5439-7192-ab30-695664a572f5.jsonl`.
  it("scenario P — tool_results + trailing steer text returns BOTH content arrays concatenated", () => {
    const toolResultBlock = { type: "tool_result", tool_use_id: "toolu_P1", content: "example-host" }
    const steerBlock = { type: "text", text: "Before replying, tell me the hostname length." }
    const messages = [
      { role: "user", content: "read /etc/hostname and reply DONE." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_P1", name: "read", input: { path: "/etc/hostname" } }] },
      { role: "user", content: [toolResultBlock] },
      { role: "user", content: [steerBlock] },
    ]
    const result = extractTrailingUserContent(messages)
    // Both the tool_result (to resolve the pending handler) and the steer
    // text (to push as new user input) must reach `classifyPassthroughRequest`.
    expect(result).toEqual([toolResultBlock, steerBlock])
  })

  it("scenario P — three parallel tool_results + trailing steer aggregates all four blocks in wire order", () => {
    const tr = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content })
    const steer = { type: "text", text: "superpowers skills are gone, we'll have to try our best to implement the plan as specified" }
    const messages = [
      { role: "user", content: "do parallel bashes" },
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_A", name: "bash", input: {} },
        { type: "tool_use", id: "toolu_B", name: "bash", input: {} },
        { type: "tool_use", id: "toolu_C", name: "bash", input: {} },
      ] },
      { role: "user", content: [tr("toolu_A", "A-output"), tr("toolu_B", "B-output"), tr("toolu_C", "C-output")] },
      { role: "user", content: [steer] },
    ]
    const result = extractTrailingUserContent(messages)
    expect(result).toEqual([tr("toolu_A", "A-output"), tr("toolu_B", "B-output"), tr("toolu_C", "C-output"), steer])
  })

  it("normalizes a trailing user message with a string content into a text block when aggregating with prior arrays", () => {
    const toolResultBlock = { type: "tool_result", tool_use_id: "toolu_S1", content: "example-host" }
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_S1", name: "read", input: {} }] },
      { role: "user", content: [toolResultBlock] },
      { role: "user", content: "steer as plain string" },
    ]
    const result = extractTrailingUserContent(messages)
    expect(result).toEqual([toolResultBlock, { type: "text", text: "steer as plain string" }])
  })

  it("returns undefined for empty messages array", () => {
    expect(extractTrailingUserContent([])).toBeUndefined()
  })

  it("stops at the first non-user message when walking backward", () => {
    const messages = [
      { role: "user", content: "ignored-older" },
      { role: "assistant", content: "boundary" },
      { role: "user", content: "kept-A" },
      { role: "user", content: "kept-B" },
    ]
    const result = extractTrailingUserContent(messages)
    expect(result).toEqual([
      { type: "text", text: "kept-A" },
      { type: "text", text: "kept-B" },
    ])
  })
})
