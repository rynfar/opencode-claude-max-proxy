/**
 * LiteLLM passthrough adapter.
 *
 * Handles requests from LiteLLM (detected via x-litellm-* headers or
 * litellm/* User-Agent). LiteLLM manages its own tool execution loop,
 * so this adapter forces passthrough mode — the proxy returns tool_use
 * blocks to LiteLLM for execution rather than running them internally.
 *
 * Key characteristics:
 * - Passthrough mode always enabled (overrides MERIDIAN_PASSTHROUGH env var)
 * - Non-streaming: LiteLLM health checks don't send x-litellm-* headers
 *   so we can't reliably distinguish them; non-streaming is safe for all requests
 * - Session continuity: uses x-litellm-session-id header when present
 * - CWD: extracts from <env cwd="..."> blocks in the prompt if available
 * - MCP server name: "litellm" (tools appear as mcp__litellm__*)
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"

const MCP_SERVER_NAME = "litellm"

const ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`,
]

/**
 * Extract the working directory from <env cwd="..."> blocks or inline
 * cwd="..." patterns in the request body.
 */
function extractCwdFromBody(body: any): string | undefined {
  if (!body) return undefined

  let promptContent = ""
  if (typeof body.prompt === "string") {
    promptContent = body.prompt
  } else if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          promptContent += msg.content
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              promptContent += block.text
            }
          }
        }
      }
    }
  }

  const envMatch = promptContent.match(/<env[^>]*cwd=["']([^"']+)["']/s)
  if (envMatch) return envMatch[1]

  const cwdMatch = promptContent.match(/cwd=["']([^"']+)["']/)
  if (cwdMatch) return cwdMatch[1]

  return undefined
}

export const passthroughAdapter: AgentAdapter = {
  name: "passthrough",

  /**
   * Use x-litellm-session-id for session continuity across requests.
   */
  getSessionId(c: Context): string | undefined {
    return c.req.header("x-litellm-session-id")
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractCwdFromBody(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * In passthrough mode the PreToolUse hook captures all tool_use blocks
   * for forwarding to the client. No built-in tools need to be blocked
   * via disallowedTools since allowedTools restricts Claude to only
   * the client's registered tools.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return []
  },

  getAgentIncompatibleTools(): readonly string[] {
    return []
  },

  getMcpServerName(): string {
    return MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return ALLOWED_MCP_TOOLS
  },

  /**
   * LiteLLM manages subagents externally — no SDK agent definitions needed.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  /**
   * No PreToolUse hook needed for agent name correction — passthrough mode
   * injects its own hook automatically to capture tool_use blocks.
   */
  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * Always use passthrough mode regardless of MERIDIAN_PASSTHROUGH env var.
   * LiteLLM sends tool_results back — the proxy must forward tool_use blocks
   * to the client rather than executing them internally.
   */
  usesPassthrough(): boolean {
    return true
  },

  /**
   * Respect the client's stream parameter.
   * LiteLLM sends stream=true for streaming requests and stream=false (or omits it)
   * for non-streaming requests including health checks.
   */
  prefersStreaming(body: any): boolean {
    return body?.stream === true
  },
}
