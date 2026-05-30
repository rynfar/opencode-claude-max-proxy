import type { Transform, RequestContext } from "../transform"
import { extractFileChangesFromBash, type FileChange } from "../fileChanges"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const AMP_MCP_SERVER_NAME = "amp"
const AMP_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${AMP_MCP_SERVER_NAME}__read`,
  `mcp__${AMP_MCP_SERVER_NAME}__write`,
  `mcp__${AMP_MCP_SERVER_NAME}__edit`,
  `mcp__${AMP_MCP_SERVER_NAME}__bash`,
  `mcp__${AMP_MCP_SERVER_NAME}__glob`,
  `mcp__${AMP_MCP_SERVER_NAME}__grep`,
]

export const ampTransforms: Transform[] = [
  {
    name: "amp-core",
    adapters: ["amp"],
    onRequest(ctx: RequestContext): RequestContext {
      const extractFileChangesFromToolUse = (toolName: string, toolInput: unknown): FileChange[] => {
        const input = toolInput as Record<string, unknown> | null | undefined
        const filePath = input?.path ?? input?.file_path ?? input?.filePath
        if (toolName === "create_file" && filePath) return [{ operation: "wrote", path: String(filePath) }]
        if (toolName === "edit_file" && filePath) return [{ operation: "edited", path: String(filePath) }]
        if (toolName === "bash" && input?.command) return extractFileChangesFromBash(String(input.command))
        return []
      }

      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: AMP_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        extractFileChangesFromToolUse,
      }
    },
  },
]
