/**
 * Cherry Studio chat-client adapter.
 *
 * Cherry Studio (CherryHQ/cherry-studio) is a desktop Electron chat client
 * that talks to Anthropic-compatible APIs. Unlike Meridian's coding-agent
 * adapters (OpenCode, Crush, ForgeCode, etc.), it has no local tool runtime
 * and no MCP integration — it's a pure chat UI that wants Claude to use
 * server-side tools natively, especially web search.
 *
 * Key differences from the coding-agent adapters:
 *   - WebSearch and WebFetch NOT blocked. Chat clients have no MCP equivalent
 *     and no client-side web access — Claude's built-ins are the whole point
 *     of using Meridian + Max OAuth here. Verified independently that Max
 *     OAuth runs WebSearch successfully when allowed.
 *   - Filesystem / shell tools blocked by default. Chat clients shouldn't
 *     read the proxy host's filesystem unsupervised — even on localhost, an
 *     unsuspecting user could let an LLM enumerate `~/.ssh` etc. Operators
 *     who genuinely want filesystem access can use a coding-agent adapter
 *     (where the agent supervises tool calls) or set MERIDIAN_DEFAULT_AGENT
 *     to one with broader permissions.
 *   - usesPassthrough = false. Cherry Studio has no tool-execution loop;
 *     the SDK executes tools internally and returns results inline.
 *   - No MCP server, no subagent routing.
 *
 * Detection: Cherry Studio doesn't send a stable User-Agent — see upstream
 * issue CherryHQ/cherry-studio#10209 (custom UA gets overridden). Use:
 *   - `x-meridian-agent: cherry-studio` header (per request)
 *   - `MERIDIAN_DEFAULT_AGENT=cherry-studio` env var (global default)
 *
 * Closes #481.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { normalizeContent } from "../messages"

const CHERRY_STUDIO_NAME = "cherry-studio"

/**
 * Tools the SDK should refuse to invoke for Cherry Studio.
 *
 * Two categories:
 *   1. Filesystem / shell — kept off by default so an unsupervised chat-style
 *      LLM can't enumerate files on the proxy host.
 *   2. Claude-Code-only orchestration tools (cron, plan/worktree mode
 *      toggles, etc.) that have no useful meaning outside the Claude Code
 *      CLI runtime.
 *
 * Web tools are deliberately absent. So is `TodoWrite` — chat clients are
 * fine with the SDK's built-in todo view since they have no equivalent.
 */
const CHERRY_STUDIO_BLOCKED: readonly string[] = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "CronCreate", "CronDelete", "CronList",
  "EnterPlanMode", "ExitPlanMode",
  "EnterWorktree", "ExitWorktree",
  "Monitor", "PushNotification", "RemoteTrigger", "ScheduleWakeup",
  "Skill", "Agent", "TaskOutput", "TaskStop",
  "AskUserQuestion",
]

export const cherryStudioAdapter: AgentAdapter = {
  name: CHERRY_STUDIO_NAME,

  /** No session-affinity header from Cherry Studio — fingerprint-based resume. */
  getSessionId(_c: Context): string | undefined {
    return undefined
  },

  /** Chat client runs on the same host as the proxy in the typical setup. */
  extractWorkingDirectory(_body: any): string | undefined {
    return undefined
  },

  normalizeContent(content: any): string {
    return normalizeContent(content)
  },

  /**
   * No SDK built-in tools to block beyond the chat-client list. Returning []
   * here and putting the full list in getAgentIncompatibleTools() keeps the
   * blocking story in one place — both lists land in the SDK's
   * `--disallowedTools` arg either way.
   */
  getBlockedBuiltinTools(): readonly string[] {
    return []
  },

  getAgentIncompatibleTools(): readonly string[] {
    return CHERRY_STUDIO_BLOCKED
  },

  /** No MCP integration — chat client speaks plain Anthropic Messages API. */
  getMcpServerName(): string {
    return CHERRY_STUDIO_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return []
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

  /**
   * Chat client has no client-side tool loop. The SDK runs tools and folds
   * results into the assistant turn for us — that's exactly what a chat UI
   * wants to render.
   */
  usesPassthrough(): boolean {
    return false
  },

  /** Cherry Studio renders thinking blocks when the user enables them. */
  supportsThinking(): boolean {
    return true
  },

  /** No filesystem-edit summary; chat clients neither edit files nor render that block. */
  shouldTrackFileChanges(): boolean {
    return false
  },
}
