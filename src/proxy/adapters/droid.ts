/**
 * Droid (Factory AI) agent adapter.
 *
 * Provides Droid-specific behavior for session tracking, working directory
 * extraction, content normalization, and tool configuration.
 *
 * Authentication: Droid connects via BYOK (Bring Your Own Key) by setting
 * provider="anthropic" and baseUrl pointing to this proxy in
 * ~/.factory/settings.json customModels.
 *
 * Key differences from OpenCode:
 * - No session header: relies on fingerprint-based session caching
 * - CWD in <system-reminder> blocks inside user messages (not <env> in system)
 * - No subagent routing: Droid manages its own subagents internally
 * - MCP server name: "droid"
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const DROID_MCP_SERVER_NAME = "droid"

const DROID_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${DROID_MCP_SERVER_NAME}__read`,
  `mcp__${DROID_MCP_SERVER_NAME}__write`,
  `mcp__${DROID_MCP_SERVER_NAME}__edit`,
  `mcp__${DROID_MCP_SERVER_NAME}__bash`,
  `mcp__${DROID_MCP_SERVER_NAME}__glob`,
  `mcp__${DROID_MCP_SERVER_NAME}__grep`,
]

/**
 * Extract the client's working directory from Droid's system-reminder block.
 *
 * Droid embeds environment context inside <system-reminder> tags in user
 * message content blocks. The CWD appears as:
 *   % pwd
 *   /path/to/project
 */
function extractDroidCwd(body: any): string | undefined {
  const messages = body.messages
  if (!Array.isArray(messages)) return undefined

  for (const msg of messages) {
    if (msg.role !== "user") continue
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const block of content) {
      if (block.type !== "text" || !block.text) continue
      const match = (block.text as string).match(/<system-reminder>[\s\S]*?% pwd\n([^\n]+)/i)
      if (match?.[1]) return match[1].trim()
    }
  }

  return undefined
}

export const droidAdapter: AgentAdapter = {
  name: "droid",

  /**
   * Droid doesn't send a session header.
   * Session continuity is maintained via fingerprint-based cache lookup.
   */
  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractDroidCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  leaksCwdViaSystemReminder(): boolean {
    // Droid embeds CWD inside <system-reminder> blocks in user messages
    // (see extractDroidCwd above). Those blocks must be stripped before the
    // prompt is flattened, or they echo back to the model.
    return true
  },

  getBlockedBuiltinTools(): readonly string[] {
    // Reuse the same list as OpenCode — Droid sends its own Read/Write/Bash/etc.
    // tools and the SDK's built-ins would conflict.
    return BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    // Droid doesn't have equivalents for Claude Code SDK-only tools.
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return DROID_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return DROID_ALLOWED_MCP_TOOLS
  },

  /**
   * Droid manages its own subagents internally — no SDK agent definitions needed.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  /**
   * Droid doesn't need PreToolUse hooks for agent name correction.
   */
  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  /**
   * No additional system context needed for Droid.
   */
  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * Droid passthrough is env-controlled, defaulting to OFF.
   *
   * Set `MERIDIAN_PASSTHROUGH=1` (or `CLAUDE_PROXY_PASSTHROUGH=1`) to enable.
   *
   * History: this used to hardcode `false` because Droid's BYOK didn't close
   * the tool execution loop — Claude would see no `tool_result` come back
   * and hallucinate file contents. Verified working on Droid v0.114.1
   * (tool_use → tool_result roundtrip completes correctly). Default stays
   * OFF so existing users see no behavior change; explicit env opt-in
   * unlocks passthrough for those who want it (better real-time TUI
   * streaming, no internal SDK loop hallucination on long contexts).
   */
  usesPassthrough(): boolean {
    const envVal = process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH
    return envVal === "1" || envVal === "true" || envVal === "yes"
  },
}

import { droidTransforms } from "../transforms/droid"
export { droidTransforms }
