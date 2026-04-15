/**
 * SDK query options builder.
 *
 * Centralizes the construction of query() options, eliminating duplication
 * between the streaming and non-streaming paths in server.ts.
 */

import { join } from "node:path"
import { homedir } from "node:os"
import type { AgentAdapter } from "./adapter"
import type { Options, SdkBeta, SettingSource } from "@anthropic-ai/claude-agent-sdk"
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
  /** Whether any passthrough tools use deferred loading */
  hasDeferredTools: boolean
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
  /** Callback to receive stderr lines from the Claude subprocess */
  onStderr?: (line: string) => void
  /** Effort level — controls thinking depth (low/medium/high/max) */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Thinking configuration — adaptive, enabled with budget, or disabled */
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens?: number } | { type: 'disabled' }
  /** API-side task budget in tokens — model paces tool use within this limit */
  taskBudget?: { total: number }
  /** Beta features to enable */
  betas?: string[]
  /** SDK setting sources — controls CLAUDE.md and user settings loading */
  settingSources?: SettingSource[]
  /** Use the Claude Code system prompt preset */
  codeSystemPrompt?: boolean
  /** Include the client agent's system prompt */
  clientSystemPrompt?: boolean
  /** Redirect the client's system prompt into the user message instead of the system field */
  systemPromptAsUserMessage?: boolean
  /** Enable auto-memory (read + write across sessions) */
  memory?: boolean
  /** Enable background memory consolidation (dreaming) */
  dreaming?: boolean
  /** Share memory directory with Claude Code (~/.claude) */
  sharedMemory?: boolean
  /** Per-request cost cap in USD */
  maxBudgetUsd?: number
  /** Fallback model when primary fails */
  fallbackModel?: string
  /** Enable SDK debug logging */
  sdkDebug?: boolean
  /** Additional directories Claude can access */
  additionalDirectories?: string[]
}

/**
 * Build the options object for the Claude Agent SDK query() call.
 * This is called identically from both streaming and non-streaming paths,
 * with the only difference being `includePartialMessages` for streaming.
 */
export interface BuildQueryResult {
  prompt: QueryContext["prompt"]
  options: Options
}

function resolveSystemPrompt(
  systemContext: string | undefined,
  passthrough: boolean,
  settingSources: SettingSource[] | undefined,
  codeSystemPrompt?: boolean,
  clientSystemPrompt?: boolean,
  systemPromptAsUserMessage?: boolean,
): { systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string } } {
  const hasSettings = settingSources != null && settingSources.length > 0
  const usePreset = codeSystemPrompt ?? (hasSettings || (!passthrough && !!systemContext))
  const includeClient = clientSystemPrompt ?? true
  // When redirecting the client's system prompt to the user message,
  // strip it from the system field — it will be prepended to the prompt instead.
  const clientContext = (includeClient && !systemPromptAsUserMessage) ? systemContext : undefined

  if (usePreset) {
    return clientContext
      ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: clientContext } }
      : { systemPrompt: { type: "preset" as const, preset: "claude_code" as const } }
  }
  if (clientContext) return { systemPrompt: clientContext }
  return {}
}

export function buildQueryOptions(ctx: QueryContext): BuildQueryResult {
  const {
    prompt, model, workingDirectory, systemContext, claudeExecutable,
    passthrough, stream, sdkAgents, passthroughMcp, cleanEnv, hasDeferredTools,
    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, adapter, onStderr,
    effort, thinking, taskBudget, betas, settingSources, codeSystemPrompt, clientSystemPrompt,
    systemPromptAsUserMessage,
    memory, dreaming, sharedMemory, maxBudgetUsd, fallbackModel, sdkDebug, additionalDirectories,
  } = ctx

  const blockedTools = [...adapter.getBlockedBuiltinTools(), ...adapter.getAgentIncompatibleTools()]
  const mcpServerName = adapter.getMcpServerName()
  const allowedMcpTools = [...adapter.getAllowedMcpTools()]

  return {
    prompt,
    options: {
      // Force Node as the executable. The claude-agent-sdk auto-detects Bun
      // via process.versions.bun and defaults to spawning `bun cli.js`.
      // Hosts like OpenCode embed Bun, so the check fires even when `bun`
      // is not in PATH — causing subprocess spawns to fail.
      executable: "node" as const,
      // NOTE: agent-specific (passthrough mode) — 2 turns minimum, not 1.
      // Turn 1: model generates tool_use blocks (captured by PreToolUse hook).
      // Turn 2: SDK processes the blocked-tool handoff before the generator
      //         returns. maxTurns: 1 throws "Reached maximum number of turns (1)"
      //         before the response is complete, causing HTTP 500s.
      // On resume: the SDK may spend a turn rehydrating session state before
      // the model responds, so allow 3 turns to prevent "max turns (2)" errors.
      // With deferred tools: ToolSearch consumes a turn before the actual tool
      // call, so allow 3 turns to give room for search + call + handoff.
      maxTurns: passthrough ? ((resumeSessionId || hasDeferredTools) ? 3 : 2) : 200,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(stream ? { includePartialMessages: true } : {}),
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...resolveSystemPrompt(systemContext, passthrough, settingSources, codeSystemPrompt, clientSystemPrompt, systemPromptAsUserMessage),
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
      ...(settingSources && settingSources.length > 0 ? {
        settingSources,
        settings: {
          autoMemoryEnabled: ctx.memory ?? true,
          autoDreamEnabled: ctx.dreaming ?? false,
        },
      } : {}),
      ...(onStderr ? { stderr: onStderr } : {}),
      env: {
        ...cleanEnv,
        ENABLE_TOOL_SEARCH: hasDeferredTools ? "true" : "false",
        ...(passthrough ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
        // Shared memory: point SDK at ~/.claude so memories are shared with Claude Code
        ...(sharedMemory ? { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") } : {}),
        // When running as root (Docker, Unraid, NAS), set IS_SANDBOX=1 to
        // bypass the SDK's root check. Without this, the SDK exits with:
        // "--dangerously-skip-permissions cannot be used with root/sudo"
        // See: https://github.com/rynfar/meridian/issues/256
        ...(process.getuid?.() === 0 ? { IS_SANDBOX: "1" } : {}),
      },
      ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(isUndo ? { forkSession: true, ...(undoRollbackUuid ? { resumeSessionAt: undoRollbackUuid } : {}) } : {}),
      ...(sdkHooks ? { hooks: sdkHooks } : {}),
      ...(effort ? { effort } : {}),
      ...(thinking ? { thinking } : {}),
      ...(taskBudget ? { taskBudget } : {}),
      ...(betas && betas.length > 0 ? { betas: betas as SdkBeta[] } : {}),
      ...(maxBudgetUsd && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(sdkDebug ? { debug: true } : {}),
      ...(additionalDirectories && additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    }
  }
}
