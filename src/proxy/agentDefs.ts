/**
 * Extract SDK AgentDefinition objects from OpenCode's Task tool description.
 *
 * OpenCode (via oh-my-opencode or other frameworks) sends a Task tool with
 * descriptions of each available agent. We parse these and convert them into
 * Claude Agent SDK `AgentDefinition` objects so the SDK's native Task handler
 * routes to properly-configured subagents.
 *
 * This means whatever agents the user configures in their framework
 * automatically become available as SDK subagents — with descriptions,
 * model tiers, and tool access.
 */

/** Fallback agent name used when no fuzzy match is found */
export const FALLBACK_AGENT_NAME = "general"

/**
 * Well-known agent types that the SDK (or Claude) commonly references.
 * These are injected as defaults when parsing yields user-defined agents
 * but is missing one or more of these types.
 */
const DEFAULT_AGENT_TYPES: Record<string, string> = {
  build: "The default agent. Executes tools based on configured permissions.",
  plan: "Plan mode. Disallows all edit tools.",
  explore: "Contextual grep for codebases. Answers 'Where is X?', 'Which file has Y?'.",
  general: "General-purpose agent for researching complex questions and executing multi-step tasks.",
}

/** SDK-compatible agent definition */
export interface AgentDefinition {
  description: string
  prompt: string
  model?: "sonnet" | "opus" | "haiku" | "inherit"
  tools?: string[]
  disallowedTools?: string[]
}

/**
 * Parse agent entries from the Task tool description text.
 *
 * Expected format (from OpenCode):
 *   - agent-name: Description of what the agent does
 *
 * @returns Map of agent name → description
 */
export function parseAgentDescriptions(taskDescription: string): Map<string, string> {
  const agents = new Map<string, string>()

  const agentSection = taskDescription.match(
    /Available agent types.*?:\n((?:- [\w][\w-]*:.*\n?)+)/s
  )
  if (!agentSection) return agents

  const entries = agentSection[1]!.matchAll(/^- ([\w][\w-]*):\s*(.+)/gm)
  for (const match of entries) {
    agents.set(match[1]!, match[2]!.trim())
  }

  return agents
}

/**
 * Map an OpenCode model string to an SDK model tier.
 *
 * The SDK only accepts 'sonnet' | 'opus' | 'haiku' | 'inherit'.
 * We map based on the model name pattern, defaulting to 'inherit'
 * for non-Anthropic models (they'll use the parent session's model).
 */
export function mapModelTier(model?: string): "sonnet" | "opus" | "opus[1m]" | "haiku" | "inherit" {
  if (!model) return "inherit"
  const lower = model.toLowerCase()
  if (lower.includes("opus")) return "opus[1m]"
  if (lower.includes("haiku")) return "haiku"
  if (lower.includes("sonnet")) return "sonnet"
  return "inherit"
}

/**
 * Build SDK AgentDefinition objects from the Task tool description.
 *
 * Each agent gets:
 * - description: from the Task tool text (user-configured)
 * - prompt: instructional prompt incorporating the description
 * - model: 'inherit' (uses parent session model — all requests go through our proxy)
 * - tools: undefined (inherit all tools from parent)
 *
 * @param taskDescription - The full Task tool description text from OpenCode
 * @param mcpToolNames - Optional list of MCP tool names to make available to agents
 */
export function buildAgentDefinitions(
  taskDescription: string,
  mcpToolNames?: string[]
): Record<string, AgentDefinition> {
  const descriptions = parseAgentDescriptions(taskDescription)
  const agents: Record<string, AgentDefinition> = {}

  for (const [name, description] of descriptions) {
    agents[name] = {
      description,
      prompt: buildAgentPrompt(name, description),
      model: "inherit",
      // Give agents access to MCP tools if provided
      ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
    }
  }

  // Inject defaults only when parsing yielded at least one agent.
  // If parsing yielded nothing, leave empty so the SDK uses its built-in types.
  if (descriptions.size > 0) {
    ensureDefaultAgents(agents, mcpToolNames)
    addCaseVariants(agents)
  }

  return agents
}

/**
 * Fill in any well-known default agents not already present in the agents map.
 * User-defined agents always take priority (we never overwrite).
 */
function ensureDefaultAgents(
  agents: Record<string, AgentDefinition>,
  mcpToolNames?: string[]
): void {
  for (const [name, description] of Object.entries(DEFAULT_AGENT_TYPES)) {
    if (!agents[name]) {
      agents[name] = {
        description,
        prompt: buildAgentPrompt(name, description),
        model: "inherit",
        ...(mcpToolNames?.length ? { tools: [...mcpToolNames] } : {}),
      }
    }
  }
}

/**
 * Register PascalCase aliases for every agent.
 *
 * Claude frequently sends capitalized agent names (e.g., "Explore", "Plan").
 * The SDK's Claude subprocess validates subagent_type against the registered
 * agents map BEFORE our PreToolUse hook can rewrite it. By registering
 * PascalCase variants we ensure they pass validation.
 *
 * Also registers common Claude-invented names like "general-purpose".
 */
function addCaseVariants(agents: Record<string, AgentDefinition>): void {
  // Snapshot keys before mutating (avoids iterating newly-added entries)
  const baseNames = Object.keys(agents)

  for (const name of baseNames) {
    const def = agents[name]!
    // Title-case: "explore" → "Explore", "sisyphus-junior" → "Sisyphus-Junior"
    const titleCase = name.replace(/(^|-)(\w)/g, (_m, sep: string, ch: string) =>
      sep + ch.toUpperCase()
    )
    if (titleCase !== name && !agents[titleCase]) {
      agents[titleCase] = def
    }
  }

  // Common Claude-invented aliases that map to registered agents
  const ALIASES: Record<string, string> = {
    "general-purpose": "general",
    "General-Purpose": "general",
  }
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!agents[alias] && agents[target]) {
      agents[alias] = agents[target]!
    }
  }
}

/**
 * Build a system prompt for an agent based on its name and description.
 */
function buildAgentPrompt(name: string, description: string): string {
  return `You are the "${name}" agent. ${description}

Focus on your specific role and complete the task thoroughly. Return a clear, concise result.`
}
