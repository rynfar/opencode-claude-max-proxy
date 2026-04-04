/**
 * Agent adapter detection.
 *
 * Inspects the incoming request to select the appropriate AgentAdapter.
 * Falls back to the OpenCode adapter for backward compatibility.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { openCodeAdapter } from "./opencode"
import { droidAdapter } from "./droid"
import { crushAdapter } from "./crush"
import { passthroughAdapter } from "./passthrough"
import { piAdapter } from "./pi"

const ADAPTER_MAP: Record<string, AgentAdapter> = {
  opencode: openCodeAdapter,
  droid: droidAdapter,
  crush: crushAdapter,
  passthrough: passthroughAdapter,
  pi: piAdapter,
}

const defaultAdapter: AgentAdapter =
  ADAPTER_MAP[process.env.MERIDIAN_DEFAULT_AGENT || ""] ?? openCodeAdapter

/**
 * Detect LiteLLM requests via User-Agent or x-litellm-* headers.
 *
 * LiteLLM's default User-Agent is generic (python-httpx), so header-based
 * detection is more reliable. LiteLLM sends x-litellm-* on regular requests
 * but not on health checks — the User-Agent check catches both.
 */
function isLiteLLMRequest(c: Context): boolean {
  if ((c.req.header("user-agent") || "").startsWith("litellm/")) return true
  const headers = c.req.header()
  return Object.keys(headers).some(k => k.toLowerCase().startsWith("x-litellm-"))
}

/**
 * Detect which agent adapter to use based on request headers.
 *
 * Detection rules (evaluated in order):
 * 1. x-meridian-agent header               → explicit adapter override
 * 2. User-Agent starts with "factory-cli/"  → Droid adapter
 * 3. User-Agent starts with "Charm-Crush/"  → Crush adapter
 * 4. litellm/* UA or x-litellm-* headers   → LiteLLM passthrough adapter
 * 5. Default                                → MERIDIAN_DEFAULT_AGENT env var, or OpenCode
 */
export function detectAdapter(c: Context): AgentAdapter {
  const agentOverride = c.req.header("x-meridian-agent")
  if (agentOverride && ADAPTER_MAP[agentOverride]) {
    return ADAPTER_MAP[agentOverride]!
  }

  const userAgent = c.req.header("user-agent") || ""

  if (userAgent.startsWith("factory-cli/")) {
    return droidAdapter
  }

  if (userAgent.startsWith("Charm-Crush/")) {
    return crushAdapter
  }

  if (isLiteLLMRequest(c)) {
    return passthroughAdapter
  }

  return defaultAdapter
}
