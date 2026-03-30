/**
 * Crush (Charm) agent adapter.
 *
 * Provides Crush-specific behavior for session tracking, content normalization,
 * and tool configuration.
 *
 * Crush connects via a provider entry in ~/.config/crush/crush.json using
 * type "anthropic" with base_url pointing at this proxy. No special auth
 * or BYOK mechanism — just a base_url override.
 *
 * Key characteristics:
 * - User-Agent: Charm-Crush/<version>
 * - Always streams (stream: true)
 * - 19 lowercase tool names (bash, edit, write, grep, ls, etc.)
 * - No session header: relies on fingerprint-based session cache
 * - No CWD in request body: falls back to CLAUDE_PROXY_WORKDIR or process.cwd()
 * - Manages its own tool execution loop: passthrough mode is appropriate
 * - System prompt sent as a list in the `system` field (not embedded in messages)
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const CRUSH_MCP_SERVER_NAME = "crush"

const CRUSH_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${CRUSH_MCP_SERVER_NAME}__read`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__write`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__edit`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__bash`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__glob`,
  `mcp__${CRUSH_MCP_SERVER_NAME}__grep`,
]

export const crushAdapter: AgentAdapter = {
  name: "crush",

  /**
   * Crush sends no session header.
   * Session continuity is maintained via fingerprint-based cache lookup.
   */
  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  /**
   * Crush does not embed CWD in the request body.
   * Falls back to CLAUDE_PROXY_WORKDIR env var or process.cwd().
   */
  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * Crush uses lowercase tool names (bash, edit, write) which do not conflict
   * with SDK built-in names (Bash, Edit, Write). Reusing the same block list
   * is safe — the capitalized names are blocked regardless.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return CRUSH_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return CRUSH_ALLOWED_MCP_TOOLS
  },

  // Crush manages its own subagents via its `agent` tool — no SDK routing needed.
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * Crush handles its own tool execution loop (the standard Anthropic
   * tool_use / tool_result cycle). Passthrough mode is the correct approach:
   * the proxy returns tool_use blocks to Crush, which executes them and sends
   * back tool_results. usesPassthrough() is intentionally undefined so the
   * global CLAUDE_PROXY_PASSTHROUGH env var controls the mode — the same
   * passthrough=1 setting that serves OpenCode also serves Crush correctly.
   */
  // usesPassthrough not defined — defers to CLAUDE_PROXY_PASSTHROUGH env var

  /**
   * Crush uses lowercase tool names: write, edit, patch, bash.
   * Input path field is "file_path".
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.file_path ?? input?.path

    if (toolName === "write" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if ((toolName === "edit" || toolName === "patch") && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (toolName === "bash" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}
