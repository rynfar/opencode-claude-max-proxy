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
  // Structural prefix patterns

  it("strips system-reminder blocks", () => {
    const input = 'hello\n' + '<' + 'system-reminder>internal note<' + '/system-reminder>\nworld'
    expect(sanitizeTranscriptWrappers(input)).toBe("hello\n\nworld")
  })

  it("strips multiline system-reminder blocks", () => {
    const input = '<' + 'system-reminder>\nline one\nline two\n<' + '/system-reminder>real content'
    expect(sanitizeTranscriptWrappers(input)).toBe("real content")
  })

  it("strips task_metadata blocks", () => {
    const input = '<' + 'task_metadata>some metadata<' + '/task_metadata>actual content'
    expect(sanitizeTranscriptWrappers(input)).toBe("actual content")
  })

  it("strips task_result blocks", () => {
    const input = 'before<' + 'task_result>result data\nmultiline<' + '/task_result>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  it("strips tool_output wrappers with attributes", () => {
    const input = 'before<' + 'tool_output name="bash">result here<' + '/tool_output>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  it("strips self-closing tool_exec wrappers", () => {
    const input = 'text<' + 'tool_exec name="read" />more'
    expect(sanitizeTranscriptWrappers(input)).toBe("textmore")
  })

  it("strips paired tool_exec wrappers", () => {
    const input = '<' + 'tool_exec name="bash">ls -la<' + '/tool_exec>output'
    expect(sanitizeTranscriptWrappers(input)).toBe("output")
  })

  it("strips skill_content blocks", () => {
    const input = '<' + 'skill_content name="gh">skill instructions<' + '/skill_content>rest'
    expect(sanitizeTranscriptWrappers(input)).toBe("rest")
  })

  it("strips skill_files blocks", () => {
    const input = 'before<' + 'skill_files>\nfile1.ts\nfile2.ts\n<' + '/skill_files>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  it("catches future orchestration tags with standard prefixes", () => {
    expect(sanitizeTranscriptWrappers('<' + 'task_future>data<' + '/task_future>content')).toBe("content")
    expect(sanitizeTranscriptWrappers('<' + 'tool_new>x<' + '/tool_new>y')).toBe("y")
    expect(sanitizeTranscriptWrappers('<' + 'skill_custom>z<' + '/skill_custom>w')).toBe("w")
    expect(sanitizeTranscriptWrappers('<' + 'system-new>a<' + '/system-new>b')).toBe("b")
  })

  // Explicit tag patterns

  it("strips thinking blocks", () => {
    const input = 'text<' + 'thinking>model thoughts leaked<' + '/thinking>more text'
    expect(sanitizeTranscriptWrappers(input)).toBe("textmore text")
  })

  it("strips env blocks", () => {
    const input = 'before<' + 'env>\n  Working directory: /home/user\n  Platform: linux\n<' + '/env>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  it("strips directories blocks", () => {
    const input = 'before<' + 'directories>\n  src/\n  lib/\n<' + '/directories>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  it("strips available_skills blocks", () => {
    const input = 'before<' + 'available_skills>\n  skill1\n  skill2\n<' + '/available_skills>after'
    expect(sanitizeTranscriptWrappers(input)).toBe("beforeafter")
  })

  // Non-tag patterns

  it("strips OMO_INTERNAL_INITIATOR comment", () => {
    const input = "<!-- OMO_INTERNAL_INITIATOR -->proceed"
    expect(sanitizeTranscriptWrappers(input)).toBe("proceed")
  })

  it("strips OH-MY-OPENCODE system directive", () => {
    const input = "[SYSTEM DIRECTIVE: OH-MY-OPENCODE use tool X]do the thing"
    expect(sanitizeTranscriptWrappers(input)).toBe("do the thing")
  })

  it("strips background_output markers", () => {
    const input = "\u2699 background_output [task_id=abc123]\nreal content"
    expect(sanitizeTranscriptWrappers(input)).toBe("real content")
  })

  it("strips Files changed blocks", () => {
    const input = "response text\n---\nFiles changed:\n  - edited /path/to/file.ts\n  - wrote /path/to/other.ts"
    expect(sanitizeTranscriptWrappers(input)).toBe("response text")
  })

  // Edge cases

  it("handles multiple patterns in one string", () => {
    const input = '<' + 'system-reminder>x<' + '/system-reminder>\n<' + 'task_metadata>y<' + '/task_metadata>\nnormal content'
    expect(sanitizeTranscriptWrappers(input)).toBe("normal content")
  })

  it("returns empty string for all-wrapper input", () => {
    const input = '<' + 'system-reminder>everything is internal<' + '/system-reminder>'
    expect(sanitizeTranscriptWrappers(input)).toBe("")
  })

  it("is a no-op for clean text", () => {
    const input = "Just a normal user message with no wrappers."
    expect(sanitizeTranscriptWrappers(input)).toBe(input)
  })

  it("is a no-op for empty string", () => {
    expect(sanitizeTranscriptWrappers("")).toBe("")
  })

  // False positive safety

  it("preserves standard HTML tags", () => {
    const input = '<' + 'div>content<' + '/div><' + 'span>text<' + '/span><' + 'p>paragraph<' + '/p>'
    expect(sanitizeTranscriptWrappers(input)).toBe(input)
  })

  it("preserves code with angle brackets", () => {
    const input = "Use Array and Map in TypeScript"
    expect(sanitizeTranscriptWrappers(input)).toBe(input)
  })

  it("preserves H: and A: in content", () => {
    expect(sanitizeTranscriptWrappers("H: hydrogen is atomic number 1")).toBe("H: hydrogen is atomic number 1")
    expect(sanitizeTranscriptWrappers("A: the answer is 42")).toBe("A: the answer is 42")
  })

  it("preserves legitimate XML with underscores outside orchestration prefixes", () => {
    const input = '<' + 'first_name>John<' + '/first_name>'
    expect(sanitizeTranscriptWrappers(input)).toBe(input)
  })

  it("preserves web component tags with hyphens", () => {
    const input = '<' + 'my-component>content<' + '/my-component>'
    expect(sanitizeTranscriptWrappers(input)).toBe(input)
  })
})

describe("sanitizeMessages", () => {
  it("sanitizes string content messages", () => {
    const messages = [
      { role: "user", content: 'hi\n<' + 'system-reminder>leak<' + '/system-reminder>' },
    ]
    const result = sanitizeMessages(messages)
    expect(result[0].content).toBe("hi")
  })

  it("sanitizes text blocks in array content", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: '<' + 'system-reminder>x<' + '/system-reminder>clean' },
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
    const original = { role: "user", content: '<' + 'system-reminder>x<' + '/system-reminder>ok' }
    const messages = [original]
    sanitizeMessages(messages)
    expect(original.content).toBe('<' + 'system-reminder>x<' + '/system-reminder>ok')
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
