/**
 * Pi coding agent adapter.
 *
 * Provides pi-specific behavior for session tracking, working directory
 * extraction, content normalization, and tool configuration.
 *
 * Pi (@mariozechner/pi-coding-agent) is a CLI coding agent that makes
 * standard Anthropic Messages API calls. When using a custom baseUrl
 * (pointing at Meridian), pi operates in non-OAuth mode with lowercase
 * tool names and its own tool execution loop.
 *
 * Key characteristics:
 * - User-Agent: claude-cli/<version> (mimics Claude Code) or default SDK UA
 * - No session header: relies on fingerprint-based session cache
 * - CWD in system prompt: "Current working directory: /path/to/project"
 * - 7 lowercase tools: read, write, edit, bash, grep, find, ls
 * - Always streams (stream: true)
 * - Manages its own tool execution loop: passthrough mode is appropriate
 * - No subagent routing: pi-coding-agent is single-agent (pylon adds orchestration on top)
 *
 * Detection: pi mimics Claude Code's User-Agent, so automatic detection is
 * unreliable. Use one of:
 * - x-meridian-agent: pi header (per-request)
 * - MERIDIAN_DEFAULT_AGENT=pi env var (global default)
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const PI_MCP_SERVER_NAME = "pi"

const PI_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${PI_MCP_SERVER_NAME}__read`,
  `mcp__${PI_MCP_SERVER_NAME}__write`,
  `mcp__${PI_MCP_SERVER_NAME}__edit`,
  `mcp__${PI_MCP_SERVER_NAME}__bash`,
  `mcp__${PI_MCP_SERVER_NAME}__grep`,
]

/**
 * Extract the client's working directory from pi's system prompt.
 *
 * Pi embeds CWD as a plain line in the system prompt:
 *   Current working directory: /path/to/project
 *
 * This differs from OpenCode's <env> block format.
 */
function extractPiCwd(body: any): string | undefined {
  let systemText = ""
  if (typeof body.system === "string") {
    systemText = body.system
  } else if (Array.isArray(body.system)) {
    systemText = body.system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  if (!systemText) return undefined

  const match = systemText.match(/Current working directory:\s*([^\n]+)/i)
  return match?.[1]?.trim() || undefined
}

export const piAdapter: AgentAdapter = {
  name: "pi",

  /**
   * Pi sends no session header.
   * Session continuity is maintained via fingerprint-based cache lookup.
   */
  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractPiCwd(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * Pi uses lowercase tool names (read, write, edit, bash) which don't
   * conflict with SDK built-in PascalCase names (Read, Write, Edit, Bash).
   * Block the SDK built-ins regardless to prevent ambiguity.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  /**
   * Pi doesn't have equivalents for Claude Code SDK-only tools
   * (cron jobs, mode switching, worktree management, etc.).
   */
  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return PI_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return PI_ALLOWED_MCP_TOOLS
  },

  /**
   * Pi manages its own subagents via pylon-orchestrator (an extension),
   * not via SDK agent routing. No SDK definitions needed.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  /**
   * No PreToolUse hooks needed — pi handles its own tool execution.
   */
  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  /**
   * No additional system context needed for pi.
   */
  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * Pi handles its own tool execution loop (standard Anthropic tool_use /
   * tool_result cycle). Passthrough mode is appropriate: the proxy returns
   * tool_use blocks to pi, which executes them and sends back tool_results.
   *
   * Like Crush, defer to CLAUDE_PROXY_PASSTHROUGH env var so the same
   * global setting controls both agents.
   */
  // usesPassthrough not defined — defers to CLAUDE_PROXY_PASSTHROUGH env var

  /**
   * Pi uses lowercase tool names: read, write, edit, bash.
   * Input path field is filePath (camelCase).
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.filePath ?? input?.file_path ?? input?.path

    if (toolName === "write" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if (toolName === "edit" && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (toolName === "bash" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}
