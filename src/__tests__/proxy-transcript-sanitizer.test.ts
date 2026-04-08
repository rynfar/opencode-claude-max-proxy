/**
 * Transcript Wrapper Sanitizer Tests
 *
 * Verifies that internal orchestration wrappers from OpenCode, oh-my-opencode,
 * and similar layers are stripped before they reach the model as text content.
 *
 * Related: https://github.com/rynfar/meridian/issues/167
 */

import { describe, it, expect } from "bun:test"
import { sanitizeTranscriptWrappers, sanitizeMessages } from "../proxy/sanitize"

describe("sanitizeTranscriptWrappers", () => {
  it("strips <system-reminder> blocks", () => {
    const input = "hello\n<system-reminder>internal system note</system-reminder>\nworld"
    expect(sanitizeTranscriptWrappers(input)).toBe("hello\n\nworld")
  })

  it("strips multiline <system-reminder> blocks", () => {
    const input = "<system-reminder>\nline one\nline two\n</system-reminder>real content"
    expect(sanitizeTranscriptWrappers(input)).toBe("real content")
  })

  it("strips <task_metadata> blocks", () => {
    const input = "<task_metadata>some metadata</task_metadata>actual content"
    expect(sanitizeTranscriptWrappers(input)).toBe("actual content")
  })

  it("strips leaked <thinking> wrappers from text", () => {
    const input = "text<thinking>model thoughts leaked as text</thinking>more text"
    expect(sanitizeTranscriptWrappers(input)).toBe("textmore text")
  })

  it("strips <tool_output> wrappers", () => {
    const input = 'before<tool_output name="bash">result here</tool_output>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  it("strips self-closing <tool_exec /> wrappers", () => {
    const input = 'text<tool_exec name="read" />more'
    expect(sanitizeTranscriptWrappers(input)).toBe("textmore")
  })

  it("strips paired <tool_exec> wrappers", () => {
    const input = '<tool_exec name="bash">ls -la</tool_exec>output'
    expect(sanitizeTranscriptWrappers(input)).toBe("output")
  })

  it("strips OMO_INTERNAL_INITIATOR comment", () => {
    const input = "<!-- OMO_INTERNAL_INITIATOR -->proceed"
    expect(sanitizeTranscriptWrappers(input)).toBe("proceed")
  })

  it("strips OH-MY-OPENCODE system directive", () => {
    const input = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE use tool X]do the thing"
    expect(sanitizeTranscriptWrappers(input)).toBe("do the thing")
  })

  it("strips background_output markers", () => {
    const input = "⚙ background_output [task_id=abc123]\nreal content"
    expect(sanitizeTranscriptWrappers(input)).toBe("real content")
  })

  it("strips stray H: transcript prefixes at line start", () => {
    const input = "H: [Tool Result for toolu_abc: done]"
    expect(sanitizeTranscriptWrappers(input)).toBe("[Tool Result for toolu_abc: done]")
  })

  it("strips stray A: transcript prefixes at line start", () => {
    const input = "A: some assistant response prefix"
    expect(sanitizeTranscriptWrappers(input)).toBe("some assistant response prefix")
  })

  it("does not strip H: or A: in the middle of a line", () => {
    const input = "Element H: hydrogen is atomic number 1"
    expect(sanitizeTranscriptWrappers(input)).toBe("Element H: hydrogen is atomic number 1")
  })

  it("handles multiple patterns in one string", () => {
    const input = "<system-reminder>x</system-reminder>\nH: [Tool Result: ok]\nnormal content"
    expect(sanitizeTranscriptWrappers(input)).toBe("[Tool Result: ok]\nnormal content")
  })

  it("returns empty string for all-wrapper input", () => {
    const input = "<system-reminder>everything is internal</system-reminder>"
    expect(sanitizeTranscriptWrappers(input)).toBe("")
  })

  it("is a no-op for clean text", () => {
    const input = "Just a normal user message with no wrappers."
    expect(sanitizeTranscriptWrappers(input)).toBe(input)
  })

  it("is a no-op for empty string", () => {
    expect(sanitizeTranscriptWrappers("")).toBe("")
  })
})

describe("sanitizeMessages", () => {
  it("sanitizes string content messages", () => {
    const messages = [
      { role: "user", content: "hi\n<system-reminder>leak</system-reminder>" },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe("hi")
  })

  it("sanitizes text blocks in array content", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>x</system-reminder>clean" },
          { type: "image_url", url: "data:image/png;base64,abc" },
        ],
      },
    ]
    const result = sanitizeMessages(messages)
    const content = result[0].content as Array<{ type: string; text?: string; url?: string }>
    expect(content[0].text).toBe("clean")
    expect(content[1]).toEqual({ type: "image_url", url: "data:image/png;base64,abc" })
  })

  it("does not mutate the original messages array", () => {
    const original = { role: "user", content: "<system-reminder>x</system-reminder>ok" }
    const messages = [original]
    sanitizeMessages(messages)
    expect(original.content).toBe("<system-reminder>x</system-reminder>ok")
  })

  it("returns same message reference when no changes needed", () => {
    const msg = { role: "user", content: "clean message" }
    const result = sanitizeMessages([msg])
    expect(result[0]).toBe(msg)
  })

  it("handles mixed clean and dirty messages", () => {
    const messages = [
      { role: "user", content: "clean" },
      { role: "user", content: "<!-- OMO_INTERNAL_INITIATOR -->dirty" },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0]).toBe(messages[0])
    expect(result[1].content).toBe("dirty")
  })

  it("handles messages with non-text content blocks unchanged", () => {
    const block = { type: "tool_use", id: "tu_1", name: "bash", input: {} }
    const messages = [{ role: "assistant", content: [block] }]
    const result = sanitizeMessages(messages)
    expect(result[0]).toBe(messages[0])
  })

  it("handles empty messages array", () => {
    expect(sanitizeMessages([])).toEqual([])
  })
})
