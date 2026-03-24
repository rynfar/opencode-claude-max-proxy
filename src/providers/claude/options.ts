/**
 * SDK query options builder.
 *
 * Assembles the full options object for the Claude Agent SDK `query()` call.
 * Deduplicates the logic that was previously copy-pasted between streaming
 * and non-streaming paths.
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentDefinition } from "./agents";
import {
  ALLOWED_MCP_TOOLS,
  BLOCKED_BUILTIN_TOOLS,
  CLAUDE_CODE_ONLY_TOOLS,
  MCP_SERVER_NAME,
} from "./constants";
import type { SdkHooks } from "./hooks";
import { createOpencodeMcpServer } from "./mcp-tools";
import type { ClaudeModel } from "./parse";
import {
  type createPassthroughMcpServer,
  PASSTHROUGH_MCP_NAME,
} from "./passthrough";

export interface QueryOptions {
  maxTurns: number;
  cwd: string;
  model: ClaudeModel;
  pathToClaudeCodeExecutable: string;
  includePartialMessages?: boolean;
  permissionMode: "bypassPermissions";
  allowDangerouslySkipPermissions: true;
  systemPrompt?: {
    type: "preset";
    preset: "claude_code";
    append: string;
  };
  disallowedTools: string[];
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  plugins: never[];
  env: Record<string, string | undefined>;
  agents?: Record<string, AgentDefinition>;
  resume?: string;
  forkSession?: boolean;
  resumeSessionAt?: string;
  hooks?: SdkHooks;
}

export function buildQueryOptions(opts: {
  model: ClaudeModel;
  workingDirectory: string;
  claudeExecutable: string;
  systemContext: string;
  cleanEnv: Record<string, string | undefined>;
  passthrough: boolean;
  passthroughMcp: ReturnType<typeof createPassthroughMcpServer> | undefined;
  sdkAgents: Record<string, AgentDefinition>;
  resumeSessionId: string | undefined;
  sdkHooks: SdkHooks | undefined;
  includePartialMessages?: boolean;
  isUndo?: boolean;
  undoRollbackUuid?: string | null;
}): QueryOptions {
  const {
    model,
    workingDirectory,
    claudeExecutable,
    systemContext,
    cleanEnv,
    passthrough,
    passthroughMcp,
    sdkAgents,
    resumeSessionId,
    sdkHooks,
    includePartialMessages,
    isUndo,
    undoRollbackUuid,
  } = opts;

  return {
    maxTurns: passthrough ? 1 : 200,
    cwd: workingDirectory,
    model,
    pathToClaudeCodeExecutable: claudeExecutable,
    ...(includePartialMessages ? { includePartialMessages: true } : {}),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    ...(systemContext
      ? {
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: systemContext,
          },
        }
      : {}),
    ...(passthrough
      ? {
          disallowedTools: [
            ...BLOCKED_BUILTIN_TOOLS,
            ...CLAUDE_CODE_ONLY_TOOLS,
          ],
          ...(passthroughMcp
            ? {
                allowedTools: passthroughMcp.toolNames,
                mcpServers: {
                  [PASSTHROUGH_MCP_NAME]: passthroughMcp.server,
                },
              }
            : {}),
        }
      : {
          disallowedTools: [
            ...BLOCKED_BUILTIN_TOOLS,
            ...CLAUDE_CODE_ONLY_TOOLS,
          ],
          allowedTools: [...ALLOWED_MCP_TOOLS],
          mcpServers: {
            [MCP_SERVER_NAME]: createOpencodeMcpServer(),
          },
        }),
    plugins: [],
    env: { ...cleanEnv, ENABLE_TOOL_SEARCH: "false" },
    ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(isUndo
      ? {
          forkSession: true,
          ...(undoRollbackUuid ? { resumeSessionAt: undoRollbackUuid } : {}),
        }
      : {}),
    ...(sdkHooks ? { hooks: sdkHooks } : {}),
  };
}
