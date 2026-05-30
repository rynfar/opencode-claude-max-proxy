/**
 * Amp agent adapter.
 *
 * Sourcegraph's Amp CLI (@sourcegraph/amp) sends standard Anthropic Messages API
 * requests to ${AMP_URL}/api/provider/anthropic/v1/messages. With AMP_URL set to
 * Meridian, Amp's Claude inference flows through this adapter while non-inference
 * endpoints are forwarded upstream by ampForwarder.
 *
 * Key characteristics:
 * - Wire path: /api/provider/anthropic/v1/messages (Anthropic Messages API)
 * - Session header: x-amp-thread-id
 * - Native client-side tool execution: passthrough mode is appropriate
 * - Snake_case tool names: read_file, edit_file, create_file, bash, glob, grep, task, todo_write
 * - Detection: path /api/provider/anthropic/ OR x-amp-client-* headers
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const AMP_MCP_SERVER_NAME = "amp"

const AMP_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${AMP_MCP_SERVER_NAME}__read`,
  `mcp__${AMP_MCP_SERVER_NAME}__write`,
  `mcp__${AMP_MCP_SERVER_NAME}__edit`,
  `mcp__${AMP_MCP_SERVER_NAME}__bash`,
  `mcp__${AMP_MCP_SERVER_NAME}__glob`,
  `mcp__${AMP_MCP_SERVER_NAME}__grep`,
]

export const ampAdapter: AgentAdapter = {
  name: "amp",

  getSessionId(c: Context): string | undefined {
    return c.req.header("x-amp-thread-id")
  },

  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  getBlockedBuiltinTools(): readonly string[] {
    return BLOCKED_BUILTIN_TOOLS
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CLAUDE_CODE_ONLY_TOOLS
  },

  getMcpServerName(): string {
    return AMP_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return AMP_ALLOWED_MCP_TOOLS
  },

  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  usesPassthrough(): boolean {
    return true
  },

  supportsThinking(): boolean {
    return true
  },

  shouldTrackFileChanges(): boolean {
    return false
  },

  /**
   * NOTE: Amp-specific. Maps Amp's snake_case native tool names to file changes.
   * Amp's writing tools: create_file (new), edit_file (mutate), bash (with redirects).
   * Path field varies: prefer `path`, fall back to `file_path` / `filePath`.
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.path ?? input?.file_path ?? input?.filePath

    if (toolName === "create_file" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if (toolName === "edit_file" && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (toolName === "bash" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}

import { ampTransforms } from "../transforms/amp"
export { ampTransforms }
