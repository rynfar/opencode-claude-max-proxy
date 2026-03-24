/**
 * SDK PreToolUse hook configuration.
 *
 * In passthrough mode: blocks ALL tools and captures them for forwarding.
 * In normal mode: fuzzy-matches agent names on the Task tool.
 */

import type {
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
  HookInput as SdkHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@/logger";
import { fuzzyMatchAgentName } from "./agents";
import { stripMcpPrefix } from "./passthrough";

export interface CapturedToolUse {
  id: string;
  name: string;
  input: unknown;
}

export type SdkHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * Build the SDK hooks object based on the operating mode.
 *
 * @param passthrough - Whether passthrough mode is active
 * @param validAgentNames - Known agent names for fuzzy matching
 * @param capturedToolUses - Mutable array to collect blocked tool_use blocks (passthrough)
 */
export function buildHooks(
  passthrough: boolean,
  validAgentNames: string[],
  capturedToolUses: CapturedToolUse[],
): SdkHooks | undefined {
  if (passthrough) {
    logger.debug("Hooks: passthrough mode (block + forward)");
    return {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            async (input: SdkHookInput) => {
              const ptInput = input as PreToolUseHookInput;
              const toolName = stripMcpPrefix(ptInput.tool_name);
              logger.debug(`Tool blocked: ${toolName}`);
              capturedToolUses.push({
                id: ptInput.tool_use_id,
                name: toolName,
                input: ptInput.tool_input,
              });
              return {
                decision: "block" as const,
                reason: "Forwarding to client for execution",
              };
            },
          ],
        },
      ],
    };
  }

  if (validAgentNames.length > 0) {
    return {
      PreToolUse: [
        {
          matcher: "Task",
          hooks: [
            async (input: SdkHookInput) => {
              const ptInput = input as PreToolUseHookInput;
              const toolInput = ptInput.tool_input as Record<string, unknown>;
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  updatedInput: {
                    ...toolInput,
                    subagent_type: fuzzyMatchAgentName(
                      String(toolInput?.subagent_type || ""),
                      validAgentNames,
                    ),
                  },
                },
              };
            },
          ],
        },
      ],
    };
  }

  return undefined;
}
