/**
 * OpenCode agent adapter.
 *
 * Provides OpenCode-specific behavior for session tracking,
 * working directory extraction, content normalization, and tool configuration.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { type FileChange, extractFileChangesFromBash } from "../fileChanges"
import { normalizeContent } from "../messages"
import { extractClientCwd } from "../session/fingerprint"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../tools"
import { buildAgentDefinitions } from "../agentDefs"
import { fuzzyMatchAgentName } from "../agentMatch"

export const openCodeAdapter: AgentAdapter = {
  name: "opencode",

  getSessionId(c: Context): string | undefined {
    return c.req.header("x-opencode-session")
  },

  extractWorkingDirectory(body: any): string | undefined {
    return extractClientCwd(body)
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
    return MCP_SERVER_NAME
  },

  getAllowedMcpTools(): readonly string[] {
    return ALLOWED_MCP_TOOLS
  },

  /**
   * NOTE: OpenCode-specific. Parses the Task tool description to extract
   * subagent names and build SDK AgentDefinition objects for native subagent routing.
   */
  buildSdkAgents(body: any, mcpToolNames: readonly string[]): Record<string, any> {
    if (!Array.isArray(body.tools)) return {}
    const taskTool = body.tools.find((t: any) => t.name === "task" || t.name === "Task")
    if (!taskTool?.description) return {}
    return buildAgentDefinitions(taskTool.description, [...mcpToolNames])
  },

  /**
   * NOTE: OpenCode-specific. Builds a PreToolUse hook that fuzzy-matches
   * subagent_type values to valid agent names before the SDK processes them.
   */
  buildSdkHooks(body: any, sdkAgents: Record<string, any>): any {
    const validAgentNames = Object.keys(sdkAgents)
    if (validAgentNames.length === 0) return undefined
    return {
      PreToolUse: [{
        matcher: "Task",
        hooks: [async (input: any) => ({
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            updatedInput: {
              ...input.tool_input,
              subagent_type: fuzzyMatchAgentName(
                String(input.tool_input?.subagent_type || ""),
                validAgentNames
              ),
            },
          },
        })],
      }],
    }
  },

  /**
   * NOTE: OpenCode-specific. Appends agent name hint to system context so
   * Claude uses exact lowercase agent names when invoking the task/Task tool.
   */
  buildSystemContextAddendum(_body: any, sdkAgents: Record<string, any>): string {
    const validAgentNames = Object.keys(sdkAgents)
    if (validAgentNames.length === 0) return ""
    return `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`
  },

  /**
   * NOTE: OpenCode-specific. Maps OpenCode's tool names to file changes.
   * OpenCode uses lowercase tool names (write, edit, multiedit) with filePath input.
   * The passthrough proxy may also return PascalCase names (Write, Edit, MultiEdit)
   * from the SDK's tool registration, so we match both.
   * Bash commands are parsed for output redirects (>, >>), tee, and sed -i.
   */
  extractFileChangesFromToolUse(toolName: string, toolInput: unknown): FileChange[] {
    const input = toolInput as Record<string, unknown> | null | undefined
    const filePath = input?.filePath ?? input?.file_path ?? input?.path

    const lowerName = toolName.toLowerCase()
    if (lowerName === "write" && filePath) {
      return [{ operation: "wrote", path: String(filePath) }]
    }
    if ((lowerName === "edit" || lowerName === "multiedit") && filePath) {
      return [{ operation: "edited", path: String(filePath) }]
    }
    if (lowerName === "bash" && input?.command) {
      return extractFileChangesFromBash(String(input.command))
    }
    return []
  },
}
