/**
 * Agent adapter interface.
 *
 * Abstracts agent-specific behavior so the proxy can work with
 * different calling agents (OpenCode, Claude Code, custom agents).
 */

import type { Context } from "hono"

/**
 * An agent adapter provides agent-specific configuration to the proxy.
 * The proxy calls these methods during request handling to determine
 * how to interact with the calling agent.
 */
export interface AgentAdapter {
  /** Human-readable name for logging */
  readonly name: string

  /**
   * Extract a session ID from the request.
   * Returns undefined if the agent doesn't provide session tracking.
   */
  getSessionId(c: Context): string | undefined

  /**
   * Extract the client's working directory from the request body.
   * Returns undefined to fall back to CLAUDE_PROXY_WORKDIR or process.cwd().
   */
  extractWorkingDirectory(body: any): string | undefined

  /**
   * Content normalization — convert message content to a stable string
   * for hashing. Agents may send content in different formats.
   */
  normalizeContent(content: any): string

  /**
   * SDK built-in tools to block (replaced by MCP equivalents).
   * These are tools where the agent provides its own implementation.
   */
  getBlockedBuiltinTools(): readonly string[]

  /**
   * Claude Code SDK tools that have no equivalent in this agent.
   * These are blocked to prevent Claude from calling tools the agent
   * can't handle.
   */
  getAgentIncompatibleTools(): readonly string[]

  /**
   * The MCP server name used by this agent.
   * Tools are registered as `mcp__{name}__{tool}`.
   */
  getMcpServerName(): string

  /**
   * MCP tools that are allowed through the proxy's tool filter.
   */
  getAllowedMcpTools(): readonly string[]

  /**
   * Build SDK agent definitions from the request body.
   * Returns agent name → AgentDefinition map for SDK subagent routing.
   * Return empty object {} if the agent doesn't support subagent routing.
   */
  buildSdkAgents?(body: any, mcpToolNames: readonly string[]): Record<string, any>

  /**
   * Build SDK hooks (e.g., PreToolUse) for this agent.
   * Return undefined if no hooks are needed.
   */
  buildSdkHooks?(body: any, sdkAgents: Record<string, any>): any

  /**
   * Build additional system context to append (e.g., agent name hints).
   * Return empty string if nothing to add.
   */
  buildSystemContextAddendum?(body: any, sdkAgents: Record<string, any>): string

  /**
   * Whether this agent prefers non-streaming (JSON) responses.
   *
   * When this method is defined and returns false, the proxy forces
   * stream=false regardless of the client's body.stream setting.
   * When undefined or returns true, body.stream is used (defaulting to false).
   */
  prefersStreaming?(body: any): boolean

  /**
   * Whether this agent uses passthrough mode for tool execution.
   *
   * In passthrough mode the proxy returns tool_use blocks to the calling
   * agent for it to execute, rather than executing them internally via MCP.
   *
   * When undefined, falls back to the CLAUDE_PROXY_PASSTHROUGH env var.
   * When defined, takes precedence over the env var for this agent.
   */
  usesPassthrough?(): boolean

  /**
   * Map a client-side tool_use block to file changes (passthrough mode).
   *
   * In passthrough mode the SDK doesn't execute tools, so PostToolUse
   * hooks never fire. Instead, the proxy scans the conversation history
   * in body.messages for assistant tool_use blocks and uses this method
   * to identify file-writing operations.
   *
   * Returns an array of FileChange entries. Most tools produce 0 or 1 entry,
   * but bash commands can produce multiple (e.g., `echo a > x && echo b > y`).
   *
   * Each adapter knows its agent's tool naming convention:
   * - OpenCode: "write" / "edit" / "bash" (with redirect parsing)
   * - Crush: "write" / "edit" / "bash"
   * - Cline: "write_to_file" / "apply_diff"
   */
  extractFileChangesFromToolUse?(toolName: string, toolInput: unknown): import("./fileChanges").FileChange[]
}
