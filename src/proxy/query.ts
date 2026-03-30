/**
 * SDK query options builder.
 *
 * Centralizes the construction of query() options, eliminating duplication
 * between the streaming and non-streaming paths in server.ts.
 */

import type { AgentAdapter } from "./adapter"
import { createOpencodeMcpServer } from "../mcpTools"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "./passthroughTools"

export interface QueryContext {
  /** The prompt to send (text or async iterable for multimodal) */
  prompt: string | AsyncIterable<any>
  /** Resolved Claude model name */
  model: string
  /** Client working directory */
  workingDirectory: string
  /** System context text (may be empty) */
  systemContext: string
  /** Path to Claude executable */
  claudeExecutable: string
  /** Whether passthrough mode is enabled */
  passthrough: boolean
  /** Whether this is a streaming request */
  stream: boolean
  /** SDK agent definitions extracted from tool descriptions */
  sdkAgents: Record<string, any>
  /** Passthrough MCP server (if passthrough mode + tools present) */
  passthroughMcp?: ReturnType<typeof createPassthroughMcpServer>
  /** Cleaned environment variables (API keys stripped) */
  cleanEnv: Record<string, string | undefined>
  /** SDK session ID for resume (if continuing a session) */
  resumeSessionId?: string
  /** Whether this is an undo operation */
  isUndo: boolean
  /** UUID to rollback to for undo operations */
  undoRollbackUuid?: string
  /** SDK hooks (PreToolUse etc.) */
  sdkHooks?: any
  /** The agent adapter providing tool configuration */
  adapter: AgentAdapter
}

/**
 * Build the options object for the Claude Agent SDK query() call.
 * This is called identically from both streaming and non-streaming paths,
 * with the only difference being `includePartialMessages` for streaming.
 */
export function buildQueryOptions(ctx: QueryContext) {
  const {
    prompt, model, workingDirectory, systemContext, claudeExecutable,
    passthrough, stream, sdkAgents, passthroughMcp, cleanEnv,
    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter,
  } = ctx

  const blockedTools = [...adapter.getBlockedBuiltinTools(), ...adapter.getAgentIncompatibleTools()]
  const mcpServerName = adapter.getMcpServerName()
  const allowedMcpTools = [...adapter.getAllowedMcpTools()]

  return {
    prompt,
    options: {
      maxTurns: passthrough ? 1 : 200,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(stream ? { includePartialMessages: true } : {}),
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...(systemContext ? {
        systemPrompt: passthrough
          ? systemContext
          : { type: "preset" as const, preset: "claude_code" as const, append: systemContext }
      } : {}),
      ...(passthrough
        ? {
            disallowedTools: blockedTools,
            ...(passthroughMcp ? {
              allowedTools: passthroughMcp.toolNames,
              mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
            } : {}),
          }
        : {
            disallowedTools: blockedTools,
            allowedTools: allowedMcpTools,
            mcpServers: { [mcpServerName]: createOpencodeMcpServer() },
          }),
      plugins: [],
      env: {
        ...cleanEnv,
        ENABLE_TOOL_SEARCH: "false",
        ...(passthrough ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
      },
      ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(isUndo ? { forkSession: true, ...(undoRollbackUuid ? { resumeSessionAt: undoRollbackUuid } : {}) } : {}),
      ...(sdkHooks ? { hooks: sdkHooks } : {}),
    }
  }
}
