/**
 * Agent definition extraction and fuzzy name matching.
 *
 * Parses agent types from OpenCode's Task tool description, builds
 * Claude Agent SDK AgentDefinition objects, and fuzzy-matches invalid
 * subagent_type values to the closest valid name.
 */

import { logger } from "@/logger";
import { ALLOWED_MCP_TOOLS } from "./constants";
import type { ToolDefinition } from "./types";

// ── Agent Definitions ──

export interface AgentDefinition {
  description: string;
  prompt: string;
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  tools?: string[];
  disallowedTools?: string[];
}

/**
 * Parse agent entries from the Task tool description text.
 * Expected format: `- agent-name: Description of what the agent does`
 */
export function parseAgentDescriptions(
  taskDescription: string,
): Map<string, string> {
  const agents = new Map<string, string>();
  const agentSection = taskDescription.match(
    /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s,
  );
  if (!agentSection) return agents;

  const entries = agentSection[1]?.matchAll(/^- ([\w][\w-]*):\s*(.+)/gm);
  if (!entries) return agents;
  for (const match of entries) {
    agents.set(match[1] ?? "", match[2]?.trim() ?? "");
  }
  return agents;
}

function buildAgentPrompt(name: string, description: string): string {
  return `You are the "${name}" agent. ${description}\n\nFocus on your specific role and complete the task thoroughly. Return a clear, concise result.`;
}

export function buildAgentDefinitions(
  taskDescription: string,
  mcpToolNames?: string[],
): Record<string, AgentDefinition> {
  const descriptions = parseAgentDescriptions(taskDescription);
  const agents: Record<string, AgentDefinition> = {};

  for (const [name, description] of descriptions) {
    agents[name] = {
      description,
      prompt: buildAgentPrompt(name, description),
      model: "inherit",
      ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
    };
  }

  return agents;
}

// ── Agent Extraction (from request tools) ──

export interface AgentInfo {
  validAgentNames: string[];
  sdkAgents: Record<string, AgentDefinition>;
  /** Extra system prompt text to append (subagent_type hint) */
  systemContextAppend: string;
}

/**
 * Extract agent definitions from the request's Task tool description.
 * Returns SDK agent objects, valid names, and a system prompt hint.
 */
export function extractAgents(tools: ToolDefinition[] | undefined): AgentInfo {
  const empty: AgentInfo = {
    validAgentNames: [],
    sdkAgents: {},
    systemContextAppend: "",
  };

  if (!Array.isArray(tools)) return empty;

  const taskTool = tools.find((t) => t.name === "task" || t.name === "Task");
  if (!taskTool?.description) return empty;

  const sdkAgents = buildAgentDefinitions(taskTool.description, [
    ...ALLOWED_MCP_TOOLS,
  ]);
  const validAgentNames = Object.keys(sdkAgents);

  logger.debug(`Agents: [${validAgentNames.join(", ")}]`);

  let systemContextAppend = "";
  if (validAgentNames.length > 0) {
    systemContextAppend = `\n\nIMPORTANT: When using the task/Task tool, the subagent_type parameter must be one of these exact values (case-sensitive, lowercase): ${validAgentNames.join(", ")}. Do NOT capitalize or modify these names.`;
  }

  return { validAgentNames, sdkAgents, systemContextAppend };
}

// ── Fuzzy Matching ──

const KNOWN_ALIASES: Record<string, string> = {
  "general-purpose": "general",
  default: "general",
  "code-reviewer": "oracle",
  reviewer: "oracle",
  "code-review": "oracle",
  review: "oracle",
  consultation: "oracle",
  analyzer: "oracle",
  debugger: "oracle",
  search: "explore",
  grep: "explore",
  find: "explore",
  "codebase-search": "explore",
  research: "librarian",
  docs: "librarian",
  documentation: "librarian",
  lookup: "librarian",
  reference: "librarian",
  consult: "oracle",
  architect: "oracle",
  "image-analyzer": "multimodal-looker",
  image: "multimodal-looker",
  pdf: "multimodal-looker",
  visual: "multimodal-looker",
  planner: "plan",
  planning: "plan",
  builder: "build",
  coder: "build",
  developer: "build",
  writer: "build",
  executor: "build",
};

const STRIP_SUFFIXES = [
  "-agent",
  "-tool",
  "-worker",
  "-task",
  " agent",
  " tool",
];

/**
 * Fuzzy-match an agent name to the closest valid option.
 * Priority: exact → alias → prefix → substring → suffix-strip → reverse → fallback.
 */
export function fuzzyMatchAgentName(
  input: string,
  validAgents: string[],
): string {
  if (!input) return input;
  if (validAgents.length === 0) return input.toLowerCase();

  const lowered = input.toLowerCase();

  const exact = validAgents.find((a) => a.toLowerCase() === lowered);
  if (exact) return exact;

  const alias = KNOWN_ALIASES[lowered];
  if (alias && validAgents.includes(alias)) return alias;

  const prefixMatch = validAgents.find((a) =>
    a.toLowerCase().startsWith(lowered),
  );
  if (prefixMatch) return prefixMatch;

  const substringMatch = validAgents.find((a) =>
    a.toLowerCase().includes(lowered),
  );
  if (substringMatch) return substringMatch;

  for (const suffix of STRIP_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      const stripped = lowered.slice(0, -suffix.length);
      const strippedMatch = validAgents.find(
        (a) => a.toLowerCase() === stripped,
      );
      if (strippedMatch) return strippedMatch;
    }
  }

  const reverseMatch = validAgents.find((a) =>
    lowered.includes(a.toLowerCase()),
  );
  if (reverseMatch) return reverseMatch;

  return lowered;
}
