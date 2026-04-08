/**
 * Strips internal orchestration / transcript wrapper patterns that can leak
 * into text-only content paths and become model-visible.
 *
 * These are control/debug artifacts produced by OpenCode, oh-my-opencode, and
 * similar orchestration layers — not semantic content the model should see.
 *
 * Fixes: https://github.com/rynfar/meridian/issues/167
 */

const TRANSCRIPT_WRAPPER_PATTERNS: RegExp[] = [
  // System-level injection blocks
  /<system-reminder[\s\S]*?<\/system-reminder>/gi,
  /<task_metadata[\s\S]*?<\/task_metadata>/gi,
  // Leaked thinking wrappers in text (not proper API thinking blocks)
  /<thinking>[\s\S]*?<\/thinking>/gi,
  // Tool execution / output wrappers
  /<tool_output\b[^>]*>[\s\S]*?<\/tool_output>/gi,
  /<tool_exec\b[^>]*\/>/gi,
  /<tool_exec\b[^>]*>[\s\S]*?<\/tool_exec>/gi,
  // oh-my-opencode internal markers
  /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/gi,
  /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/gi,
  // Background output task markers
  /⚙\s*background_output\s*\[task_id=[^\]]*\]\n?/g,
  // Stray H: / A: transcript-prefix lines (line-start only, not mid-line)
  /^H:\s+/gm,
  /^A:\s+/gm,
  // File change summary blocks injected by meridian itself
  /\n?---\nFiles changed:[^\n]*(\n(?:  [-•*] [^\n]*))*\n?/g,
]

/**
 * Strips all internal transcript wrapper patterns from a text string.
 */
export function sanitizeTranscriptWrappers(text: string): string {
  let result = text
  for (const pattern of TRANSCRIPT_WRAPPER_PATTERNS) {
    result = result.replace(pattern, "")
  }
  return result.trim()
}

type ContentBlock = { type: string; text?: string; [key: string]: unknown }
type Message = { role: string; content: string | ContentBlock[] | unknown }

/**
 * Sanitizes all text-type content in a messages array.
 * Returns a new array (no mutation); unchanged messages are returned by reference.
 */
export function sanitizeMessages(messages: Message[]): Message[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      const sanitized = sanitizeTranscriptWrappers(msg.content)
      return sanitized === msg.content ? msg : { ...msg, content: sanitized }
    }
    if (Array.isArray(msg.content)) {
      let changed = false
      const newContent = (msg.content as ContentBlock[]).map((block) => {
        if (block.type === "text" && typeof block.text === "string") {
          const sanitized = sanitizeTranscriptWrappers(block.text)
          if (sanitized !== block.text) {
            changed = true
            return { ...block, text: sanitized }
          }
        }
        return block
      })
      return changed ? { ...msg, content: newContent } : msg
    }
    return msg
  })
}
