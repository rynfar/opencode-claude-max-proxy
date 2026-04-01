/**
 * Message-to-prompt conversion for the Claude Agent SDK.
 *
 * Converts Anthropic API messages into SDK-compatible prompts:
 * - Text-only messages → flat string ("Human: ...\n\nAssistant: ...")
 * - Multimodal messages → structured async iterable of user messages
 *
 * Two entry points:
 * - preparePrompt(): builds a prompt from a subset of messages (for normal/resume requests)
 * - buildFreshPrompt(): builds a prompt from ALL messages (for stale session retry)
 */

type Message = { role: string; content: any }

const MULTIMODAL_TYPES = new Set(["image", "document", "file"])

/**
 * Strip cache_control from content blocks — the SDK manages its own caching
 * and agent ttl blocks conflict with the SDK's ttl blocks.
 */
export function stripCacheControl(content: any): any {
  if (!Array.isArray(content)) return content
  return content.map((block: any) => {
    if (block.cache_control) {
      const { cache_control, ...rest } = block
      return rest
    }
    return block
  })
}

function hasMultimodalContent(messages: Message[]): boolean {
  return messages.some((m) =>
    Array.isArray(m.content) && m.content.some((b: any) => MULTIMODAL_TYPES.has(b.type))
  )
}

/** Convert an assistant message's content to a text summary. */
function summarizeAssistantContent(content: any): string {
  if (typeof content === "string") {
    return `[Assistant: ${content}]`
  }
  if (Array.isArray(content)) {
    return content.map((b: any) => {
      if (b.type === "text" && b.text) return `[Assistant: ${b.text}]`
      if (b.type === "tool_use") return `[Tool Use: ${b.name}(${JSON.stringify(b.input)})]`
      if (b.type === "tool_result") return `[Tool Result: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}]`
      return ""
    }).filter(Boolean).join("\n")
  }
  return `[Assistant: ${String(content)}]`
}

/** Convert messages to a flat text prompt. */
function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "Human"
      let content: string
      if (typeof m.content === "string") {
        content = m.content
      } else if (Array.isArray(m.content)) {
        content = m.content
          .map((block: any) => {
            if (block.type === "text" && block.text) return block.text
            if (block.type === "tool_use") return `[Tool Use: ${block.name}(${JSON.stringify(block.input)})]`
            if (block.type === "tool_result") return `[Tool Result for ${block.tool_use_id}: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}]`
            if (block.type === "image") return "[Image attached]"
            if (block.type === "document") return "[Document attached]"
            if (block.type === "file") return "[File attached]"
            return ""
          })
          .filter(Boolean)
          .join("\n")
      } else {
        content = String(m.content)
      }
      return `${role}: ${content}`
    })
    .join("\n\n") || ""
}

type StructuredMessage = { type: "user"; message: { role: string; content: any }; parent_tool_use_id: null }

/** Convert messages to structured format preserving multimodal blocks. */
function messagesToStructured(messages: Message[], isResume: boolean): StructuredMessage[] {
  const structured: StructuredMessage[] = []

  for (const m of messages) {
    if (m.role === "user") {
      structured.push({
        type: "user" as const,
        message: { role: "user" as const, content: stripCacheControl(m.content) },
        parent_tool_use_id: null,
      })
    } else if (!isResume) {
      // On resume, skip assistant messages (SDK has them already)
      structured.push({
        type: "user" as const,
        message: { role: "user" as const, content: summarizeAssistantContent(m.content) },
        parent_tool_use_id: null,
      })
    }
  }

  return structured
}

function structuredToIterable(msgs: StructuredMessage[]): AsyncIterable<StructuredMessage> {
  return (async function* () { for (const msg of msgs) yield msg })()
}

export interface PreparedPrompt {
  /** Create a prompt value (can be called multiple times for retry). */
  makePrompt(): string | AsyncIterable<any>
}

/**
 * Prepare a prompt from a subset of messages (normal request or resume delta).
 */
export function preparePrompt(messages: Message[], isResume: boolean): PreparedPrompt {
  if (hasMultimodalContent(messages)) {
    const structured = messagesToStructured(messages, isResume)
    return {
      makePrompt: () => structuredToIterable(structured),
    }
  }

  const text = messagesToText(messages)
  return {
    makePrompt: () => text,
  }
}

/**
 * Build a prompt from ALL messages for a fresh (non-resume) session.
 * Used when retrying after a stale session UUID error.
 */
export function buildFreshPrompt(messages: Message[]): string | AsyncIterable<any> {
  if (hasMultimodalContent(messages)) {
    const structured = messagesToStructured(messages, false)
    return structuredToIterable(structured)
  }
  return messagesToText(messages)
}
