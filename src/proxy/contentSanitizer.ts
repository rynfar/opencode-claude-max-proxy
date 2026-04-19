/**
 * Content-block sanitizers used by the persistent-mode push path.
 *
 * Anthropic caps requests at 4 `cache_control` breakpoints. Clients (notably
 * Pi) attach `cache_control: { type: "ephemeral" }` to every user message's
 * text blocks. In request-per-process mode those markers live only in the
 * current request and meridian's fresh-prompt builders strip them via a
 * function named `stripCacheControlDeep` in server.ts. In persistent mode
 * the runtime holds the SDK's conversation in memory across turns — if we
 * pushed user content with `cache_control` still attached, the SDK would
 * accumulate them in history and exceed the cap after 4 turns (HTTP 400
 * "A maximum of 4 blocks with cache_control may be provided"). This
 * invariant was surfaced by the §1c live Pi spike and is formalized in
 * design §D10 / task §5.13.
 *
 * This module owns the push-time sanitizer so both the server wiring
 * (§5.12e dispatch) and any other persistent-mode caller share one
 * canonical implementation.
 */

/**
 * Deeply strip the `cache_control` property from any content block structure,
 * including blocks nested inside `tool_result.content` arrays. Arrays and
 * nested arrays are preserved; non-block values pass through unchanged.
 */
export function stripCacheControl(content: unknown): unknown {
  if (content == null) return content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(stripCacheControl)
  if (typeof content !== "object") return content
  const block = content as Record<string, unknown>
  const { cache_control: _cacheControl, ...rest } = block
  // tool_result blocks carry their inner payload under `content` — recurse
  // so nested cache_control markers also get stripped.
  if (rest.type === "tool_result" && Array.isArray(rest.content)) {
    return { ...rest, content: (rest.content as unknown[]).map(stripCacheControl) }
  }
  return rest
}
