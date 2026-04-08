/**
 * Strips internal orchestration / transcript wrapper patterns that can leak
 * into text-only content paths and become model-visible.
 *
 * Uses structural prefix matching where possible — tags whose name starts
 * with task_, tool_, skill_, or system- are reserved by orchestration layers
 * and never appear in standard HTML/XML. This catches current AND future
 * orchestration tags without enumerating each one.
 *
 * Fixes: https://github.com/rynfar/meridian/issues/167
 */

const TRANSCRIPT_WRAPPER_PATTERNS: RegExp[] = [
  // ── Structural: orchestration-prefix tags (paired + self-closing) ──
  // Covers: task_metadata, task_result, tool_output, tool_exec, skill_content,
  // skill_files, system-reminder, and any future tags with these prefixes.
  /<(?:task|tool|skill|system)[-_]\w+\b[^>]*>[\s\S]*?<\/(?:task|tool|skill|system)[-_]\w+>/gi,
  /<(?:task|tool|skill|system)[-_]\w+\b[^>]*\/>/gi,

  // ── Structural: namespace-prefixed tags ──
  // antml:* — Anthropic internal namespace (thinking, function_calls, invoke, etc.)
  /<\w+\b[^>]*>[\s\S]*?<\/antml:\w+>/gi,
  /<\w+\b[^>]*\/>/gi,
  // dcp-* — OpenCode protocol metadata (message-id, system-reminder, etc.)
  /<dcp-[\w-]+\b[^>]*>[\s\S]*?<\/dcp-[\w-]+>/gi,
  /<dcp-[\w-]+\b[^>]*\/?>/gi,

  // ── Explicit: tags without orchestration prefixes ──
  // Leaked thinking wrappers (not proper API thinking blocks, no antml: namespace)
  /<thinking>[\s\S]*?<\/thinking>/gi,
  // System-injection blocks that leak into message content on session replay
  /<env>[\s\S]*?<\/env>/gi,
  /<directories>[\s\S]*?<\/directories>/gi,
  /<available_skills>[\s\S]*?<\/available_skills>/gi,

  // ── Explicit: non-tag orchestration artifacts ──
  // oh-my-opencode internal markers
  /<!--\s*OMO_INTERNAL_INITIATOR\s*-->/gi,
  /\[SYSTEM DIRECTIVE: OH-MY-OPENCODE[^\]]*\]/gi,
  // Background output task markers
  /⚙\s*background_output\s*\[task_id=[^\]]*\]\n?/g,
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
