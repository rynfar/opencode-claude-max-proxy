/**
 * SDK query options builder.
 *
 * Centralizes the construction of query() options, eliminating duplication
 * between the streaming and non-streaming paths in server.ts.
 */

import { join } from "node:path"
import type { Options, SdkBeta, SettingSource } from "@anthropic-ai/claude-agent-sdk"
import { createOpencodeMcpServer } from "../mcpTools"
import { createPassthroughMcpServer, PASSTHROUGH_MCP_NAME } from "./passthroughTools"

/**
 * Return a copy of `env` with `CLAUDE_CONFIG_DIR` removed. Used by the
 * sharedMemory branch — see the comment at the env construction site.
 *
 * Pure function: never mutates the input.
 */
function stripConfigDir(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (!("CLAUDE_CONFIG_DIR" in env)) return env
  const out = { ...env }
  delete out.CLAUDE_CONFIG_DIR
  return out
}

export interface QueryContext {
  /** The prompt to send (text or async iterable for multimodal) */
  prompt: string | AsyncIterable<any>
  /** Resolved Claude model name */
  model: string
  /** SDK subprocess working directory — must exist on the proxy host. */
  workingDirectory: string
  /**
   * Client-local working directory (as reported in the request). May not
   * exist on the proxy host. When this differs from workingDirectory the
   * system prompt is augmented with a note directing the model to refer
   * to file paths using the client's path rather than the proxy's.
   */
  clientWorkingDirectory?: string
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
  /** Blocked SDK built-in tools (from pipeline) */
  blockedTools: readonly string[]
  /** Agent-incompatible tools (from pipeline) */
  incompatibleTools: readonly string[]
  /** MCP server name for this adapter */
  mcpServerName: string
  /** Allowed MCP tools (from pipeline) */
  allowedMcpTools: readonly string[]
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
  /** Advisor model for server-side advisor tool support */
  advisorModel?: string
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

/**
 * NOTE: agent-specific (passthrough mode).
 *
 * Compute maxTurns based on which SDK features are active. Each phase the SDK
 * walks before returning control to the host costs a turn:
 *   - Base (3): turn 1 generates content (extended thinking + tool_use blocks
 *     captured by PreToolUse hook); turn 2 receives the deny and may emit a
 *     follow-up (text or further tool_use); turn 3 wraps the stream cleanly.
 *     Was 2 historically — bumped after telemetry showed opus[1m] requests with
 *     thinking + tool_use exhausting the 2-turn budget mid-handoff and returning
 *     500s on fresh (non-resume) requests. See errors.ts sdk_termination
 *     diagnostic + telemetry.
 *   - Resume / deferred (no extra turn over base): both fit within the 3-turn
 *     budget. Resume rehydration and ToolSearch lookups complete inside turn 1.
 *   - Both resume and deferred (+1): a second prelude phase pushes one phase
 *     out, so budget becomes 4.
 *   - Advisor (+3): server-side advisor executes call + result + final answer.
 */
function computePassthroughMaxTurns(
  resumeSessionId: string | undefined,
  hasDeferredTools: boolean,
  advisorModel: string | undefined,
): number {
  const hasResume = !!resumeSessionId
  const base = hasResume && hasDeferredTools ? 4 : 3
  const advisorBump = advisorModel ? 3 : 0
  return base + advisorBump
}

/**
 * Build an addendum that tells the model which path belongs to the real user.
 * Applied when the SDK subprocess runs in one directory on the proxy host but
 * the client is working in a different directory on their own machine
 * (typical of a remote Claude Code → network-proxy setup). Without this note
 * the SDK's env block leaks `sdkCwd` into the model's context and Claude
 * reports that as its working directory.
 */
export function buildCwdNote(sdkCwd: string, clientCwd?: string): string {
  if (!clientCwd || clientCwd === sdkCwd) return ""
  // Emit in the `<env>Working directory: …</env>` shape the Claude Code
  // subprocess uses itself, so it doesn't auto-inject a second env block
  // pointing at its own process.cwd() (which would be the proxy host path).
  // Placed at the top of the append so it's the first env block the model
  // sees. The subsequent notice tells the model to prefer this over any
  // contradictory path that might slip through later in the context.
  return (
    `\n\n<env>\n` +
    `Working directory: ${clientCwd}\n` +
    `</env>\n` +
    `<meridian-note>\n` +
    `You are reached through a proxy. The subprocess running you resides at ` +
    `"${sdkCwd}" on the proxy host, but that is not the user's working directory. ` +
    `Always treat "${clientCwd}" as the working directory when referring to files or paths.\n` +
    `</meridian-note>`
  )
}

function resolveSystemPrompt(
  systemContext: string | undefined,
  passthrough: boolean,
  settingSources: SettingSource[] | undefined,
  codeSystemPrompt: boolean | undefined,
  clientSystemPrompt: boolean | undefined,
  cwdNote: string,
): { systemPrompt?: string | { type: "preset"; preset: "claude_code"; append?: string } } {
  const hasSettings = settingSources != null && settingSources.length > 0
  const usePreset = codeSystemPrompt ?? (hasSettings || (!passthrough && !!systemContext))
  const includeClient = clientSystemPrompt ?? true
  const clientContext = includeClient ? systemContext : undefined
  const append = [clientContext, cwdNote].filter(Boolean).join("") || undefined

  if (usePreset) {
    return append
      ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } }
      : { systemPrompt: { type: "preset" as const, preset: "claude_code" as const } }
  }
  if (append) return { systemPrompt: append }
  return {}
}

export function buildQueryOptions(ctx: QueryContext): BuildQueryResult {
  const {
    prompt, model, workingDirectory, clientWorkingDirectory, systemContext, claudeExecutable,
    passthrough, stream, sdkAgents, passthroughMcp, cleanEnv, hasDeferredTools,
    resumeSessionId, isUndo, undoRollbackUuid, sdkHooks, blockedTools, incompatibleTools,
    mcpServerName, allowedMcpTools, onStderr,
    effort, thinking, taskBudget, betas, settingSources, codeSystemPrompt, clientSystemPrompt,
    memory, dreaming, sharedMemory, maxBudgetUsd, fallbackModel, sdkDebug, additionalDirectories,
  } = ctx
  const cwdNote = buildCwdNote(workingDirectory, clientWorkingDirectory)

  const allBlockedTools = [...blockedTools, ...incompatibleTools]

  return {
    prompt,
    options: {
      // Force Node as the executable. The claude-agent-sdk auto-detects Bun
      // via process.versions.bun and defaults to spawning `bun cli.js`.
      // Hosts like OpenCode embed Bun, so the check fires even when `bun`
      // is not in PATH — causing subprocess spawns to fail.
      executable: "node" as const,
      maxTurns: passthrough
        ? computePassthroughMaxTurns(resumeSessionId, hasDeferredTools, ctx.advisorModel)
        : 200,
      cwd: workingDirectory,
      model,
      pathToClaudeCodeExecutable: claudeExecutable,
      ...(stream ? { includePartialMessages: true } : {}),
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...resolveSystemPrompt(systemContext, passthrough, settingSources, codeSystemPrompt, clientSystemPrompt, cwdNote),
      ...(passthrough
        ? {
            disallowedTools: [...allBlockedTools],
            ...(passthroughMcp ? {
              allowedTools: [...passthroughMcp.toolNames],
              mcpServers: { [PASSTHROUGH_MCP_NAME]: passthroughMcp.server },
            } : {}),
          }
        : {
            disallowedTools: [...allBlockedTools],
            allowedTools: [...allowedMcpTools],
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
        // sharedMemory: the user wants the SDK to use Claude Code's default
        // config dir so memories sync. Counter-intuitively we DON'T set
        // CLAUDE_CONFIG_DIR=$HOME/.claude here — explicitly setting it (even
        // to the default value) changes the SDK's Keychain lookup key and
        // breaks OAuth (issue #453, upstream anthropics/claude-code#20553).
        // Instead, strip any inherited custom CLAUDE_CONFIG_DIR from the
        // profile env so the SDK falls back to its own default. That achieves
        // the "share memory with Claude Code" intent without poisoning
        // Keychain auth.
        ...(sharedMemory ? stripConfigDir(cleanEnv) : cleanEnv),
        ENABLE_TOOL_SEARCH: hasDeferredTools ? "true" : "false",
        ...(passthrough ? { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } : {}),
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
      ...(ctx.advisorModel ? { advisorModel: ctx.advisorModel } : {}),
    }
  }
}
