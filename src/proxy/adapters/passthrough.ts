/**
 * Passthrough adapter for standard Anthropic API clients.
 *
 * Provides passthrough behavior for clients that manage their own tool execution loop.
 * The client sends tool_use blocks to the proxy, which returns them for execution,
 * rather than executing them internally via MCP.
 *
 * Key characteristics:
 * - Manages its own tool execution loop: passthrough mode is required
 * - Session: supports session headers (e.g., x-litellm-session-id) for continuity
 * - CWD: extracts from <env> blocks in prompt if available
 * - Tool naming: uses "litellm" MCP server name for backward compatibility
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"

const PASSTHROUGH_MCP_SERVER_NAME = "litellm"

const PASSTHROUGH_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${PASSTHROUGH_MCP_SERVER_NAME}__read`,
  `mcp__${PASSTHROUGH_MCP_SERVER_NAME}__write`,
  `mcp__${PASSTHROUGH_MCP_SERVER_NAME}__edit`,
  `mcp__${PASSTHROUGH_MCP_SERVER_NAME}__bash`,
  `mcp__${PASSTHROUGH_MCP_SERVER_NAME}__glob`,
  `mcp__${PASSTHROUGH_MCP_SERVER_NAME}__grep`,
]

function extractEnvFromPrompt(body: any): string | undefined {
  const DEBUG = process.env.DEBUG_PROXY === "true"

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

  const envMatch = promptContent.match(/<env[^>]*>.*?cwd=["']([^"']+)["']/s)
  if (envMatch) {
    if (DEBUG) {
      console.error(`[DEBUG passthrough adapter] Extracted CWD from <env>: ${envMatch[1]}`)
    }
    return envMatch[1]
  }

  const cwdMatch = promptContent.match(/cwd=["']([^"']+)["']/)
  if (cwdMatch) {
    if (DEBUG) {
      console.error(`[DEBUG passthrough adapter] Extracted CWD from prompt: ${cwdMatch[1]}`)
    }
    return cwdMatch[1]
  }

  return undefined
}

export const passthroughAdapter: AgentAdapter = {
  name: "passthrough",

  /**
   * Clients may send session headers (e.g., x-litellm-session-id) for session continuity.
   * If present, use it to maintain session across requests.
   */
  getSessionId(c: Context): string | undefined {
    const DEBUG = process.env.DEBUG_PROXY === "true"
    const sessionId = c.req.header("x-litellm-session-id")
    if (DEBUG && sessionId) {
      console.error(`[DEBUG passthrough adapter] Using x-litellm-session-id: ${sessionId.substring(0, 8)}...`)
    }
    return sessionId
  },

  /**
   * Try to extract CWD from <env> blocks in the prompt.
   * Falls back to MERIDIAN_WORKDIR env var or process.cwd().
   */
  extractWorkingDirectory(body: any): string | undefined {
    return extractEnvFromPrompt(body)
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * In passthrough mode, tool blocking is handled by the PreToolUse hook
   * which captures all tool_use blocks for forwarding to the client.
   * Empty list here allows all tools through for external execution.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return []
  },

  /**
   * In passthrough mode, tool compatibility is managed externally.
   * Empty list here since the proxy doesn't execute tools internally.
   */
  getAgentIncompatibleTools(): readonly string[] {
    return []
  },

  getMcpServerName(): string {
    return PASSTHROUGH_MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return PASSTHROUGH_ALLOWED_MCP_TOOLS
  },

  /**
   * Passthrough clients manage their own subagents internally — no SDK agent definitions needed.
   */
  buildSdkAgents(_body: any, _mcpToolNames: readonly string[]): Record<string, any> {
    return {}
  },

  /**
   * Passthrough clients don't need PreToolUse hooks for agent name correction.
   * Hooks are injected automatically in passthrough mode to capture tool_use blocks.
   */
  buildSdkHooks(_body: any, _sdkAgents: Record<string, any>): undefined {
    return undefined
  },

  /**
   * No additional system context needed for passthrough clients.
   */
  buildSystemContextAddendum(_body: any, _sdkAgents: Record<string, any>): string {
    return ""
  },

  /**
   * Passthrough clients always use passthrough mode — the proxy returns tool_use blocks
   * to the client for it to execute, rather than executing them internally via MCP.
   * This overrides any CLAUDE_PROXY_PASSTHROUGH env var setting.
   *
   * Why: The client manages its own tool execution loop (the standard Anthropic
   * tool_use / tool_result cycle). The proxy must forward tool_use blocks back
   * so the client can execute them and send back tool_results.
   */
  usesPassthrough(): boolean {
    return true
  },
}
