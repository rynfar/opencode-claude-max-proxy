/**
 * Tool blocking lists and MCP tool configuration.
 *
 * NOTE: These lists are currently OpenCode-specific. When the adapter pattern
 * is implemented, these will move into the OpenCode adapter and become
 * configurable per-agent. See DEFERRED.md.
 */

/**
 * Block SDK built-in tools so Claude only uses MCP tools
 * (which have correct param names for the calling agent).
 */
export const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

/**
 * Claude Code SDK tools that have NO equivalent in the calling agent (OpenCode).
 * Only block these — everything else either has an agent equivalent
 * or is handled by the agent's own tool system.
 *
 * Tools where the agent has an equivalent but with a DIFFERENT name/schema
 * are blocked so Claude uses the agent's version instead of the SDK's.
 */
export const CLAUDE_CODE_ONLY_TOOLS = [
  "CronCreate",        // Claude Code cron jobs
  "CronDelete",        // Claude Code cron jobs
  "CronList",          // Claude Code cron jobs
  "EnterPlanMode",     // Claude Code mode switching (OpenCode uses plan agent instead)
  "ExitPlanMode",      // Claude Code mode switching
  "EnterWorktree",     // Claude Code git worktree management
  "ExitWorktree",      // Claude Code git worktree management
  "Monitor",           // Claude Code background-process monitoring
  "NotebookEdit",      // Jupyter notebook editing
  "PushNotification",  // Claude Code push-notification delivery
  "RemoteTrigger",     // Claude Code remote-trigger plumbing
  "ScheduleWakeup",    // Claude Code self-paced loop scheduling
  // Schema-incompatible: SDK tool name differs from OpenCode's.
  // If Claude calls the SDK version, OpenCode won't recognize it.
  // Block the SDK's so Claude only sees OpenCode's definitions.
  "TodoWrite",         // OpenCode: todowrite (requires 'priority' field)
  "AskUserQuestion",   // OpenCode: question
  "Skill",             // OpenCode: skill / skill_mcp / slashcommand
  "Agent",             // OpenCode: delegate_task / task
  "TaskOutput",        // OpenCode: background_output
  "TaskStop",          // OpenCode: background_cancel
  "WebSearch",         // OpenCode: websearch_web_search_exa
]

/** MCP server name used by the calling agent */
export const MCP_SERVER_NAME = "opencode"

/** MCP tools that are allowed through the proxy's tool filter */
export const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`
]
