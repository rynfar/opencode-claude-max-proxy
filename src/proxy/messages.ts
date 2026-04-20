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
      if (block.type === "server_tool_use") return `server_tool_use:${block.id}:${block.name}:${JSON.stringify(stripCacheControlForHashing(block.input))}`
      if (block.type === "tool_result") {
        const inner = block.content
        if (typeof inner === "string") return `tool_result:${block.tool_use_id}:${inner}`
        // Strip cache_control from nested content blocks before serializing
        return `tool_result:${block.tool_use_id}:${JSON.stringify(stripCacheControlForHashing(inner))}`
      }
      if (block.type === "advisor_tool_result") {
        return `advisor_tool_result:${JSON.stringify(stripCacheControlForHashing(block.content))}`
      }
      // Unknown block types: strip cache_control before serializing
      return JSON.stringify(stripCacheControlForHashing(block))
    }).join("\n")
  }
  return String(content)
}

function stringifyBlockValue(value: any): string {
  if (typeof value === "string") return value
  return JSON.stringify(stripCacheControlForHashing(value))
}

export function summarizeContentBlockForPrompt(block: any): string {
  if (!block || typeof block !== "object") return String(block)
  if (block.type === "text" && block.text) return String(block.text)
  if (block.type === "tool_use") return `[Tool Use: ${block.name}(${JSON.stringify(block.input)})]`
  if (block.type === "server_tool_use") return `[Server Tool Use: ${block.name}(${JSON.stringify(block.input ?? {})})]`
  if (block.type === "tool_result") return `[Tool Result for ${block.tool_use_id}: ${stringifyBlockValue(block.content)}]`
  if (block.type === "advisor_tool_result") return `[Advisor Tool Result: ${stringifyBlockValue(block.content)}]`
  if (block.type === "image") return "[Image attached]"
  if (block.type === "document") return "[Document attached]"
  if (block.type === "file") return "[File attached]"
  return stringifyBlockValue(block)
}

export interface AdvisorToolDefinition {
  type: "advisor_20260301"
  name: "advisor"
  model: string
  max_uses?: number
  caching?: { type: "ephemeral"; ttl: "5m" | "1h" }
}

export function extractAdvisorToolDefinition(tools: unknown): AdvisorToolDefinition | undefined {
  if (!Array.isArray(tools)) return undefined

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue
    const candidate = tool as Record<string, unknown>
    if (candidate.type !== "advisor_20260301") continue

    if (candidate.name !== "advisor") {
      throw new Error("Advisor tool must be named 'advisor'")
    }
    if (typeof candidate.model !== "string" || candidate.model.length === 0) {
      throw new Error("Advisor tool requires a non-empty model")
    }

    const maxUses = candidate.max_uses
    if (maxUses !== undefined && (!Number.isInteger(maxUses) || Number(maxUses) <= 0)) {
      throw new Error("Advisor tool max_uses must be a positive integer")
    }

    const caching = candidate.caching
    if (caching !== undefined) {
      if (typeof caching !== "object" || caching == null) {
        throw new Error("Advisor tool caching must be an object")
      }
      const ttl = (caching as Record<string, unknown>).ttl
      if (ttl !== "5m" && ttl !== "1h") {
        throw new Error("Advisor tool caching.ttl must be '5m' or '1h'")
      }
    }

    return {
      type: "advisor_20260301",
      name: "advisor",
      model: candidate.model,
      ...(maxUses !== undefined ? { max_uses: Number(maxUses) } : {}),
      ...(caching !== undefined
        ? { caching: { type: "ephemeral", ttl: (caching as Record<string, unknown>).ttl as "5m" | "1h" } }
        : {}),
    }
  }

  return undefined
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
