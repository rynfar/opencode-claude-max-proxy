/**
 * Tool allow/block lists and MCP server names.
 *
 * Block SDK built-in tools so Claude only uses MCP tools (which have
 * correct param names matching OpenCode's expectations).
 */

export const BLOCKED_BUILTIN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash",
  "Glob",
  "Grep",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
];

/**
 * Claude Code SDK tools that have NO equivalent in OpenCode, or whose
 * schema is incompatible (different name/fields). Blocking forces Claude
 * to use OpenCode's definitions instead.
 */
export const CLAUDE_CODE_ONLY_TOOLS = [
  "ToolSearch",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "NotebookEdit",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "WebSearch",
];

export const MCP_SERVER_NAME = "opencode";

export const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`,
];
