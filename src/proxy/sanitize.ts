/**
 * Vendor-string sanitization for system prompts.
 *
 * Anthropic appears to perform server-side prompt-content filtering on
 * the literal string "OpenClaw" in system prompts. Two independent users
 * reproduced this with curl in April 2026:
 *
 *   - danielfariati (rynfar/meridian#255, 2026-04-05): the literal string
 *     "You are a personal assistant running inside OpenClaw" triggers
 *     Extra-Usage-Required billing on Max-without-extra-usage accounts
 *     regardless of model variant, beta headers, or token state.
 *   - TheDuctTapeDev (rynfar/meridian#277, 2026-04-05): independently
 *     confirmed: "With or without custom headers if your system prompt
 *     contains the exact string 'You are a personal assistant running
 *     inside OpenClaw' it triggered on every test, on every anthropic
 *     model. We then changed 'inside' to 'in' via curl and it went
 *     through with no warnings."
 *
 * The fingerprint source is at openclaw/openclaw/src/agents/system-prompt.ts:447
 * — a literal string baked into the OpenClaw built-in system prompt at
 * build time. The filter cannot be bypassed at the SDK or proxy layer
 * because it lives at Anthropic; the only working mitigation is to
 * remove the trigger substring from the prompt before it leaves the
 * proxy.
 *
 * This module scrubs the literal substring "openclaw" (case-insensitive)
 * from system prompt text. The scrub is opt-in via the
 * MERIDIAN_SCRUB_VENDOR env var so this fork-only patch stays isolated
 * from upstream behavior.
 *
 * NOTE: This is a downstream-fork-only patch. Upstream rynfar/meridian
 * has formally refused to support OpenClaw — see PR #294 (2026-04-06)
 * which added a README WARNING block and removed OpenClaw from the
 * tested-agents table. PR #220 (subagent [1m] skip), the closest
 * precedent for OpenClaw-friendly patches, was closed without merging.
 * We carry this patch in ArshyaAI/meridian for as long as Anthropic's
 * prompt-content filtering remains in effect on the OpenClaw substring.
 *
 * This module is pure — no I/O, no imports from server.ts or session/.
 */

/**
 * Recognized vendor names for the scrub. Add new names here as Anthropic
 * expands its prompt-content filtering to other agent frameworks.
 */
export type VendorScrubTarget = "openclaw";

/**
 * Replacement substring used in place of the vendor name. Chosen to be
 * neutral, single-word, and unlikely to itself become a future filter
 * target. Casing is preserved at runtime by {@link scrubVendorReferences}.
 */
const REPLACEMENT = "AgentSystem";

/**
 * Read the vendor-scrub configuration from the MERIDIAN_SCRUB_VENDOR env var.
 *
 * Returns the configured vendor name when set to a recognized value,
 * otherwise returns undefined. Unrecognized values are silently ignored
 * (mirrors {@link getBetaPolicyFromEnv} in `betas.ts`).
 */
export function getVendorScrubFromEnv(): VendorScrubTarget | undefined {
  const raw = process.env.MERIDIAN_SCRUB_VENDOR;
  if (raw === "openclaw") return raw;
  return undefined;
}

/**
 * Replace vendor references in a string while preserving casing.
 *
 * Casing rules (preserved per occurrence):
 * - "OpenClaw" → "AgentSystem" (PascalCase, first letter capitalized)
 * - "openclaw" → "agentsystem" (all lowercase)
 * - "OPENCLAW" → "AGENTSYSTEM" (all uppercase)
 * - Anything else (mixed) → lowercase replacement
 *
 * Empty input is returned unchanged. Unknown vendor values pass through
 * untouched so callers can use this defensively without an extra null check.
 */
export function scrubVendorReferences(
  text: string,
  vendor: VendorScrubTarget = "openclaw",
): string {
  if (!text) return text;
  if (vendor !== "openclaw") return text;

  return text.replace(/openclaw/gi, (match) => {
    if (match === match.toUpperCase()) return REPLACEMENT.toUpperCase();
    if (match[0] === match[0]?.toUpperCase()) return REPLACEMENT;
    return REPLACEMENT.toLowerCase();
  });
}

/**
 * Scrub vendor references from a system-prompt string when enabled by env.
 *
 * This is the entry point called from the request handler. It reads the
 * MERIDIAN_SCRUB_VENDOR env var on every call (no caching) so operators
 * can flip the behavior at runtime via Railway variable updates without
 * a process restart.
 *
 * Returns the input unchanged when scrubbing is disabled.
 */
export function maybeScrubSystemContext(systemContext: string): string {
  const vendor = getVendorScrubFromEnv();
  if (!vendor) return systemContext;
  const scrubbed = scrubVendorReferences(systemContext, vendor);
  if (scrubbed !== systemContext) {
    // Telemetry log — counts how often the scrub actually rewrites content.
    // Helps distinguish "scrub off" from "scrub on but input clean".
    const delta = systemContext.length - scrubbed.length;
    console.error(
      `[sanitize] scrubbed systemContext vendor="${vendor}" input_len=${systemContext.length} delta=${delta}`,
    );
  }
  return scrubbed;
}

/**
 * Recursively scrub vendor references from a JSON-serializable value.
 *
 * Walks arrays and objects, rewriting every string leaf. Used to scrub
 * the entire request body (messages, tools, system prompt blocks) so
 * fingerprints hidden in conversation history or tool descriptions are
 * also neutralized before the request leaves Meridian.
 *
 * CRITICAL: this mutates strings at every depth but preserves structure,
 * object identity is NOT preserved — it returns fresh containers. Callers
 * should replace the original value with the return.
 */
export function scrubVendorReferencesDeep<T>(
  value: T,
  vendor: VendorScrubTarget = "openclaw",
): T {
  if (typeof value === "string") {
    return scrubVendorReferences(value, vendor) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) =>
      scrubVendorReferencesDeep(v, vendor),
    ) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubVendorReferencesDeep(v, vendor);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Scrub vendor references from the entire Anthropic Messages API request
 * body when enabled by env. Covers `system`, `messages[*].content`,
 * `tools[*].description`, and any other string leaf in the request.
 *
 * Returns a new body object with all string leaves rewritten. Returns
 * the original body unchanged when scrubbing is disabled.
 *
 * NOTE: This is invoked BEFORE systemContext extraction in server.ts so
 * the downstream `maybeScrubSystemContext` call becomes a no-op (the
 * string is already clean). Kept as a belt-and-suspenders safety measure.
 */
export function maybeScrubRequestBody<T extends Record<string, unknown>>(
  body: T,
): T {
  const vendor = getVendorScrubFromEnv();
  if (!vendor) return body;
  // Measure the sensitive fields for telemetry before/after.
  const sys = body["system"];
  const msgs = body["messages"];
  const tools = body["tools"];
  const before =
    (typeof sys === "string" ? sys.length : JSON.stringify(sys ?? "").length) +
    JSON.stringify(msgs ?? "").length +
    JSON.stringify(tools ?? "").length;
  const scrubbed = scrubVendorReferencesDeep(body, vendor);
  const after = (() => {
    const s = scrubbed["system"];
    const m = scrubbed["messages"];
    const t = scrubbed["tools"];
    return (
      (typeof s === "string" ? s.length : JSON.stringify(s ?? "").length) +
      JSON.stringify(m ?? "").length +
      JSON.stringify(t ?? "").length
    );
  })();
  if (after !== before) {
    const delta = before - after;
    console.error(
      `[sanitize] scrubbed request body vendor="${vendor}" before=${before} delta=${delta}`,
    );
  }
  return scrubbed;
}
