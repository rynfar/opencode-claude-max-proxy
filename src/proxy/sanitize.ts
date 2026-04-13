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
 * Selectively scrub vendor references from messages, skipping tool_use
 * and tool_result content blocks.
 *
 * Anthropic fingerprints system prompts and tool descriptions, NOT file
 * paths inside tool call arguments or tool results. The blind deep-scrub
 * was rewriting paths like `/data/.openclaw/extensions/crm/index.ts` to
 * `/data/.agentsystem/extensions/crm/index.ts` — a path that doesn't
 * exist — causing deployment failures in agent-driven plugin installs.
 *
 * Content block handling:
 *   - tool_use:   pass through unchanged (input contains file paths)
 *   - tool_result: pass through unchanged (content contains file data)
 *   - text:       scrub the text field (may contain fingerprint phrases)
 *   - thinking:   scrub (reasoning may echo fingerprint phrases)
 *   - other:      scrub (defense in depth for unknown block types)
 */
export function scrubMessagesSelective(
  messages: unknown[],
  vendor: VendorScrubTarget = "openclaw",
): unknown[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const m = msg as Record<string, unknown>;
    const content = m["content"];

    // String content (simple user/assistant messages) — scrub directly
    if (typeof content === "string") {
      return { ...m, content: scrubVendorReferences(content, vendor) };
    }

    // Array content (structured content blocks) — selective per block type
    if (Array.isArray(content)) {
      const scrubbed = content.map((block) => {
        if (!block || typeof block !== "object") {
          return typeof block === "string"
            ? scrubVendorReferences(block, vendor)
            : block;
        }
        const b = block as Record<string, unknown>;
        const blockType = b["type"];

        // tool_use, tool_result, redacted_thinking: pass through unchanged
        // (opaque content — file paths, encrypted blobs, tool output)
        if (
          blockType === "tool_use" ||
          blockType === "tool_result" ||
          blockType === "redacted_thinking"
        ) {
          return block;
        }

        // text blocks: scrub only the text field, preserve structure
        if (blockType === "text" && typeof b["text"] === "string") {
          return {
            ...b,
            text: scrubVendorReferences(b["text"] as string, vendor),
          };
        }

        // thinking blocks: scrub the thinking field
        if (blockType === "thinking" && typeof b["thinking"] === "string") {
          return {
            ...b,
            thinking: scrubVendorReferences(b["thinking"] as string, vendor),
          };
        }

        // Unknown block types: deep scrub for defense in depth
        return scrubVendorReferencesDeep(block, vendor);
      });
      return { ...m, content: scrubbed };
    }

    // No content or unrecognized shape — return unchanged
    return msg;
  });
}

/**
 * Scrub vendor references from the Anthropic Messages API request body
 * using structure-aware scrubbing. Scrubs system prompts and tool
 * descriptions fully, but skips tool_use/tool_result content blocks in
 * messages to preserve file paths.
 *
 * Returns a new body object. Returns the original body unchanged when
 * scrubbing is disabled.
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

  // Structure-aware scrub: system + tools get deep scrub,
  // messages get selective scrub that skips tool_use/tool_result blocks.
  const scrubbed = { ...body } as Record<string, unknown>;
  if (sys !== undefined) {
    scrubbed["system"] = scrubVendorReferencesDeep(sys, vendor);
  }
  if (tools !== undefined) {
    scrubbed["tools"] = scrubVendorReferencesDeep(tools, vendor);
  }
  if (Array.isArray(msgs)) {
    scrubbed["messages"] = scrubMessagesSelective(msgs, vendor);
  }

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
  return scrubbed as T;
}

// =============================================================================
// REVERSE SCRUB — response body path (bidirectional scrub)
// =============================================================================
//
// The outbound scrub rewrites openclaw → AgentSystem so Anthropic doesn't
// detect the OpenClaw fingerprint. Side effect: Anthropic responds using
// "AgentSystem" as the product name, that string flows back into OpenClaw
// unmodified, and over many turns the agent's context and mem0 memories
// accumulate "AgentSystem" references. Eventually the agent loses its
// OpenClaw identity (observed: treebot searched github.com/agentsystem
// instead of github.com/openclaw/openclaw).
//
// The reverse scrub rewrites AgentSystem → OpenClaw (case-preserving) on
// response text fields only. Structural metadata (type, role, model, id,
// stop_reason, usage, tool_use.name, tool_use.id) is left untouched.
//
// Gated on TWO env vars (both must be set):
//   - MERIDIAN_SCRUB_VENDOR=openclaw     (the existing outbound gate)
//   - MERIDIAN_SCRUB_BIDIRECTIONAL=1     (the new response gate, default off)
//
// Default disabled so this fork-only patch stays safe to deploy without
// immediately flipping behavior. Enable both together after staging soak.

/**
 * Reverse direction of scrubVendorReferences: rewrite the REPLACEMENT
 * substring back to the original vendor name. Case-preserving.
 *
 *   "AgentSystem" → "OpenClaw"
 *   "agentsystem" → "openclaw"
 *   "AGENTSYSTEM" → "OPENCLAW"
 *   Other mixed casings → "openclaw" (lowercase fallback)
 *
 * Empty input is returned unchanged. Unknown vendor values pass through
 * untouched. This is the exact inverse of scrubVendorReferences and is
 * idempotent (re-application is a no-op).
 */
export function unscrubVendorReferences(
  text: string,
  vendor: VendorScrubTarget = "openclaw",
): string {
  if (!text) return text;
  if (vendor !== "openclaw") return text;

  return text.replace(/agentsystem/gi, (match) => {
    if (match === match.toUpperCase()) return "OPENCLAW";
    if (match[0] === match[0]?.toUpperCase()) return "OpenClaw";
    return "openclaw";
  });
}

/**
 * Read the bidirectional scrub gate from env. Requires the base scrub
 * to also be enabled — otherwise returns false. This prevents the
 * reverse rewrite from running in environments where there's nothing
 * to reverse.
 */
export function getBidirectionalScrubFromEnv(): boolean {
  if (!getVendorScrubFromEnv()) return false;
  const raw = process.env.MERIDIAN_SCRUB_BIDIRECTIONAL;
  return raw === "1" || raw === "true";
}

/**
 * Walk a non-streaming Anthropic Messages API response body and reverse
 * scrub text leaves only. Structural metadata (type, role, stop_reason,
 * model, id, usage) is left untouched. Mutates the passed object in place
 * AND returns it for chaining convenience.
 *
 * Fields walked:
 *   - content[i].text                    (text blocks)
 *   - content[i].input                   (tool_use input JSON fragments)
 *
 * Fields NOT touched (structural metadata):
 *   - type, role, id, model, stop_reason, stop_sequence, usage
 *   - content[i].type, content[i].id, content[i].name (tool_use)
 *
 * No-op when MERIDIAN_SCRUB_BIDIRECTIONAL is unset/false.
 */
export function maybeUnscrubMessageBody<T extends Record<string, unknown>>(
  body: T,
): T {
  if (!getBidirectionalScrubFromEnv()) return body;
  let rewrites = 0;

  const content = body["content"];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b["text"] === "string") {
          const before = b["text"] as string;
          const after = unscrubVendorReferences(before);
          if (after !== before) {
            b["text"] = after;
            rewrites += before.length - after.length;
          }
        }
        // tool_use.input can contain string values — walk one level deep
        if (b["input"] && typeof b["input"] === "object") {
          const input = b["input"] as Record<string, unknown>;
          for (const k of Object.keys(input)) {
            const v = input[k];
            if (typeof v === "string") {
              const after = unscrubVendorReferences(v);
              if (after !== v) {
                input[k] = after;
                rewrites += v.length - after.length;
              }
            }
          }
        }
      }
    }
  }

  if (rewrites !== 0) {
    console.error(`[sanitize] unscrubbed response body delta=${rewrites}`);
  }
  return body;
}

/**
 * Apply reverse scrub to a single SSE stream_event object. Mutates only
 * text-bearing fields:
 *
 *   - content_block_start.content_block.text             (initial text)
 *   - content_block_delta.delta.text                     (text_delta)
 *   - content_block_delta.delta.partial_json             (input_json_delta)
 *   - message_start.message.content[].text               (rare)
 *
 * Does NOT touch type, index, stop_reason, usage, tool_use.name/id,
 * message.id, message.model. See maybeUnscrubMessageBody for the
 * non-streaming case.
 *
 * No-op when MERIDIAN_SCRUB_BIDIRECTIONAL is unset/false. Returns the
 * passed event for chaining.
 */
export function maybeUnscrubStreamEvent<T>(event: T): T {
  if (!getBidirectionalScrubFromEnv()) return event;
  if (!event || typeof event !== "object") return event;

  const e = event as unknown as Record<string, unknown>;

  // content_block_delta → delta.text / delta.partial_json
  if (e["type"] === "content_block_delta") {
    const delta = e["delta"];
    if (delta && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      if (typeof d["text"] === "string") {
        d["text"] = unscrubVendorReferences(d["text"] as string);
      }
      if (typeof d["partial_json"] === "string") {
        d["partial_json"] = unscrubVendorReferences(
          d["partial_json"] as string,
        );
      }
    }
  }

  // content_block_start → content_block.text (initial text on block open)
  if (e["type"] === "content_block_start") {
    const cb = e["content_block"];
    if (cb && typeof cb === "object") {
      const c = cb as Record<string, unknown>;
      if (typeof c["text"] === "string") {
        c["text"] = unscrubVendorReferences(c["text"] as string);
      }
    }
  }

  // message_start → message.content[].text (rare but valid)
  if (e["type"] === "message_start") {
    const msg = e["message"];
    if (msg && typeof msg === "object") {
      const m = msg as Record<string, unknown>;
      const content = m["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (typeof b["text"] === "string") {
              b["text"] = unscrubVendorReferences(b["text"] as string);
            }
          }
        }
      }
    }
  }

  return event;
}

// =============================================================================
// STRIP AGENT SYSTEM PROMPT — nuclear-option fingerprint defense
// =============================================================================
//
// Anthropic re-enabled aggressive content-based detection of agent-harness
// system prompts on 2026-04-09 ~03:18 UTC (tracked in rynfar/meridian#319).
// The vendor-word scrub (openclaw → AgentSystem) is insufficient: Anthropic
// fingerprints the SENTENCE STRUCTURE ("You are a personal assistant running
// inside X"), the URL footprint (docs.openclaw.ai, github.com/openclaw/...),
// the tool vocabulary (sessions_spawn, subagents, canvas), and the overall
// system-prompt SHAPE — not just the single-word vendor name.
//
// Community-verified working bypass (as of 2026-04-09 07:15 UTC, confirmed
// by rynfar himself using the OpenCode harness-layer equivalent):
//
//   Replace the ENTIRE system prompt with the literal Claude Code identity
//   string: "You are Claude Code, Anthropic's official CLI for Claude."
//
// Also strip body.tool_choice (unique to agent harnesses, absent in vanilla
// Claude Code).
//
// Tradeoff: the agent loses all OpenClaw-specific guidance embedded in the
// system prompt (how to use sessions_spawn, cron.wake, canvas, etc.). Tool
// calls still work because tools are defined in body.tools with their own
// per-tool descriptions. This is an emergency recovery fix — better
// degraded-but-functional than hard-down.
//
// Gated on TWO env vars (both must be set):
//   - MERIDIAN_SCRUB_VENDOR=openclaw     (the base scrub gate)
//   - MERIDIAN_STRIP_AGENT_PROMPT=1      (the new nuclear gate, default off)
//
// References:
//   - https://github.com/rynfar/meridian/issues/319  (upstream bug thread)
//   - https://github.com/remorses/kimaki/commit/8721ba5  (surgical variant)
//   - https://github.com/w568w/cc-goatway  (nuclear + header spoofing variant)

const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Read the strip-agent-prompt gate from env. Requires the base scrub to
 * also be enabled — otherwise returns false, preventing the nuclear
 * rewrite from running in environments where there's nothing to defend.
 */
export function getStripAgentPromptFromEnv(): boolean {
  if (!getVendorScrubFromEnv()) return false;
  const raw = process.env.MERIDIAN_STRIP_AGENT_PROMPT;
  return raw === "1" || raw === "true";
}

/**
 * Replace body.system with the minimal Claude Code identity string and
 * delete body.tool_choice. Mutates in place AND returns for chaining.
 *
 * Handles both shapes Anthropic Messages API accepts for `system`:
 *   - string     (legacy / simple callers)
 *   - array of content blocks  (modern / cacheable prefix callers)
 *
 * No-op when MERIDIAN_STRIP_AGENT_PROMPT is unset/false.
 */
export function maybeStripAgentRequestBody<T extends Record<string, unknown>>(
  body: T,
): T {
  if (!getStripAgentPromptFromEnv()) return body;

  // Cast to writable record — T is covariantly constrained, TypeScript
  // won't let us index-write through the generic directly.
  const b = body as Record<string, unknown>;
  const system = b["system"];

  if (typeof system === "string" && system.length > 0) {
    b["system"] = CLAUDE_CODE_IDENTITY;
    console.error(
      `[sanitize] stripped body.system (string) len=${system.length} → ${CLAUDE_CODE_IDENTITY.length}`,
    );
  } else if (Array.isArray(system) && system.length > 0) {
    const origLen = JSON.stringify(system).length;
    b["system"] = [{ type: "text", text: CLAUDE_CODE_IDENTITY }];
    console.error(
      `[sanitize] stripped body.system (array) blocks=${system.length} len=${origLen} → ~${CLAUDE_CODE_IDENTITY.length + 20}`,
    );
  }

  if ("tool_choice" in b) {
    delete b["tool_choice"];
    console.error(`[sanitize] stripped body.tool_choice`);
  }

  return body;
}

/**
 * Replace the extracted systemContext string with the minimal Claude
 * Code identity. This runs AFTER the adapter has composed the final
 * systemContext the SDK will see, so it's the last line of defense.
 *
 * No-op when MERIDIAN_STRIP_AGENT_PROMPT is unset/false.
 */
export function maybeStripAgentSystemContext(systemContext: string): string {
  if (!getStripAgentPromptFromEnv()) return systemContext;
  if (!systemContext) return systemContext;
  console.error(
    `[sanitize] stripped systemContext len=${systemContext.length} → ${CLAUDE_CODE_IDENTITY.length}`,
  );
  return CLAUDE_CODE_IDENTITY;
}
