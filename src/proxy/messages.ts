/**
 * Message parsing and normalization utilities.
 */

/**
 * Strip cache_control from a content block (or nested blocks).
 * cache_control is ephemeral metadata that agents add/remove between requests;
 * it must not affect content hashing or lineage verification.
 */
function stripCacheControlForHashing(obj: any): any {
  if (!obj || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(stripCacheControlForHashing)
  const { cache_control, ...rest } = obj
  return rest
}

/**
 * Normalize message content to a string for hashing and comparison.
 * Handles both string content and array content (Anthropic content blocks).
 * Strips cache_control metadata to ensure hash stability across requests.
 *
 * NOTE: OpenCode sends content as a string on the first request but as
 * an array on subsequent ones. This normalizer handles both formats.
 * Other agents may behave differently — this will move to the adapter pattern.
 */
export function normalizeContent(content: any): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (block.type === "text" && block.text) return block.text
      if (block.type === "tool_use") return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${JSON.stringify(stripCacheControlForHashing(inner))}`
      }
      // Unknown block types: strip cache_control before serializing
      return JSON.stringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

/**
 * Extract only the last user message (for session resume — SDK already has history).
 */
export function getLastUserMessage(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return [messages[i]!]
  }
  return messages.slice(-1)
}

/**
 * Build the persistent-mode turn delta: the content blocks from ALL
 * consecutive trailing `role === "user"` messages, in wire order.
 *
 * Pi's agent loop (`@mariozechner/pi-agent-core/agent-loop.js:92-100`)
 * flushes queued steering messages as SEPARATE `role === "user"` agent
 * messages appended to the conversation after the toolResult aggregation.
 * The resulting Anthropic payload ends with two consecutive user messages:
 *   [..., user([tool_result, ...]), user([text])]
 *
 * Persistent mode must see BOTH content arrays to resolve pending MCP
 * handlers (from the tool_results) AND push the steer text as new user
 * input. Returning only the single last user message — as the earlier
 * `getLastUserMessage` helper did — stranded the tool_results and hung
 * the SDK on its blocked deferred handlers (pi session
 * `2026-04-21T03-27-41-113Z_019dae14`).
 */
export function extractTrailingUserContent(
  messages: Array<{ role: string; content: any }>,
): unknown {
  // Walk backward until we hit a non-user message. Collect user contents in
  // wire order so `classifyPassthroughRequest` sees tool_results and any
  // trailing text blocks together.
  let boundary = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") boundary = i
    else break
  }
  if (boundary >= messages.length) return undefined

  const trailing = messages.slice(boundary)
  if (trailing.length === 1) {
    // Single trailing user message — preserve its original shape (string,
    // array, or object) so callers that pass a plain-string prompt through
    // `buildPushMessage` still see a string, not a wrapped text block. Keeps
    // Scenario Q (queued follow-up) bit-identical to pre-fix behavior.
    return trailing[0]!.content
  }

  const blocks: unknown[] = []
  for (const m of trailing) {
    const c = m.content
    if (Array.isArray(c)) {
      blocks.push(...c)
    } else if (typeof c === "string") {
      blocks.push({ type: "text", text: c })
    } else if (c !== undefined && c !== null) {
      blocks.push(c)
    }
  }
  return blocks
}
