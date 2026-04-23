/**
 * Agent Definition Extraction Tests
 *
 * Verifies that we correctly parse agent descriptions from OpenCode's
 * Task tool and convert them to SDK AgentDefinition objects.
 */

import { describe, it, expect } from "bun:test"
import { parseAgentDescriptions, buildAgentDefinitions, mapModelTier, FALLBACK_AGENT_NAME } from "../proxy/agentDefs"

const SAMPLE_TASK_DESCRIPTION = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.
- explore: Contextual grep for codebases. Answers "Where is X?", "Which file has Y?".
- oracle: Read-only consultation agent. High-IQ reasoning specialist for debugging hard problems.
- librarian: Specialized codebase understanding agent for multi-repository analysis.
- sisyphus-junior: Sisyphus-Junior - Focused task executor. Same discipline, no delegation.

When using the Task tool, you must specify a subagent_type parameter.`

describe("parseAgentDescriptions", () => {
  it("should extract all agent names and descriptions", () => {
    const agents = parseAgentDescriptions(SAMPLE_TASK_DESCRIPTION)

    expect(agents.size).toBe(6)
    expect(agents.get("build")).toBe("The default agent. Executes tools based on configured permissions.")
    expect(agents.get("plan")).toBe("Plan mode. Disallows all edit tools.")
    expect(agents.get("explore")).toContain("Contextual grep")
    expect(agents.get("oracle")).toContain("Read-only consultation")
    expect(agents.get("librarian")).toContain("multi-repository")
    expect(agents.get("sisyphus-junior")).toContain("Focused task executor")
  })

  it("should return empty map for missing agent section", () => {
    const agents = parseAgentDescriptions("No agents here")
    expect(agents.size).toBe(0)
  })

  it("should handle single agent", () => {
    const desc = `Available agent types and the tools they have access to:
- solo: The only agent.`
    const agents = parseAgentDescriptions(desc)
    expect(agents.size).toBe(1)
    expect(agents.get("solo")).toBe("The only agent.")
  })
})

/** Helper: get base agent names (lowercase, non-alias) from a definitions map */
const KNOWN_ALIASES = new Set(["general-purpose"])
function baseAgentNames(defs: Record<string, any>): string[] {
  return Object.keys(defs).filter(k => k === k.toLowerCase() && !KNOWN_ALIASES.has(k))
}

describe("buildAgentDefinitions", () => {
  it("should create AgentDefinition for each parsed agent plus defaults", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)

    // 6 parsed + 1 injected default ("general") = 7 base agents
    const base = baseAgentNames(defs)
    expect(base).toHaveLength(7)
    expect(defs["oracle"]).toBeDefined()
    expect(defs["explore"]).toBeDefined()
    expect(defs["build"]).toBeDefined()
    expect(defs["general"]).toBeDefined()
  })

  it("each base agent should have description, prompt, and model", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)

    for (const name of baseAgentNames(defs)) {
      const def = defs[name]!
      expect(def.description).toBeTruthy()
      // Prompt references the original agent name (not aliases or variants)
      expect(def.prompt).toContain(`"${name}" agent`)
      expect(def.model).toBe("inherit")
    }
  })

  it("agent prompt should incorporate the description", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)

    expect(defs["oracle"]!.prompt).toContain("oracle")
    expect(defs["oracle"]!.prompt).toContain("Read-only consultation")
  })

  it("should include MCP tools when provided", () => {
    const mcpTools = ["mcp__opencode__read", "mcp__opencode__bash"]
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION, mcpTools)

    expect(defs["oracle"]!.tools).toEqual(mcpTools)
    expect(defs["explore"]!.tools).toEqual(mcpTools)
  })

  it("should not include tools when none provided", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)
    expect(defs["oracle"]!.tools).toBeUndefined()
  })

  it("should return empty object for no agents", () => {
    const defs = buildAgentDefinitions("No agents here")
    expect(Object.keys(defs)).toHaveLength(0)
  })
})

describe("mapModelTier", () => {
  it("should map opus models", () => {
    expect(mapModelTier("anthropic/claude-opus-4-6")).toBe("opus[1m]")
    expect(mapModelTier("claude-opus-4")).toBe("opus[1m]")
  })

  it("should map sonnet models", () => {
    expect(mapModelTier("anthropic/claude-sonnet-4-5")).toBe("sonnet")
  })

  it("should map haiku models", () => {
    expect(mapModelTier("anthropic/claude-haiku-4-5")).toBe("haiku")
  })

  it("should return inherit for non-Anthropic models", () => {
    expect(mapModelTier("openai/gpt-5.2")).toBe("inherit")
    expect(mapModelTier("google/gemini-3-flash")).toBe("inherit")
  })

  it("should return inherit for undefined", () => {
    expect(mapModelTier(undefined)).toBe("inherit")
    expect(mapModelTier()).toBe("inherit")
  })
})

describe("Native OpenCode (no oh-my-opencode)", () => {
  it("should handle minimal native agents (build + plan only) with defaults injected", () => {
    const nativeDescription = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.

When using the Task tool, you must specify a subagent_type parameter.`

    const agents = buildAgentDefinitions(nativeDescription)

    // 2 parsed + 2 injected defaults ("explore", "general") = 4 base agents
    expect(baseAgentNames(agents)).toHaveLength(4)
    expect(agents["build"]).toBeDefined()
    expect(agents["plan"]).toBeDefined()
    expect(agents["explore"]).toBeDefined()
    expect(agents["general"]).toBeDefined()
    expect(agents["build"]!.description).toContain("default agent")
    expect(agents["plan"]!.description).toContain("Plan mode")
  })

  it("should handle native + custom agents from opencode.json", () => {
    // User can define custom agents in opencode.json "agent" section
    const customDescription = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.
- librarian: Documentation search agent.

When using the Task tool, you must specify a subagent_type parameter.`

    const agents = buildAgentDefinitions(customDescription)

    // 3 parsed + 2 injected defaults ("explore", "general") = 5 base agents
    expect(baseAgentNames(agents)).toHaveLength(5)
    expect(agents["librarian"]).toBeDefined()
    expect(agents["librarian"]!.description).toContain("Documentation search")
    expect(agents["explore"]).toBeDefined()
    expect(agents["general"]).toBeDefined()
  })
})

describe("oh-my-opencode integration", () => {
  it("should handle full oh-my-opencode agent set", () => {
    // Actual Task tool description from a live OpenCode + oh-my-opencode session
    const omooDescription = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.
- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.
- explore: Contextual grep for codebases. Answers "Where is X?", "Which file has Y?", "Find the code that does Z". Fire multiple in parallel for broad searches. Specify thoroughness: "quick" for basic, "medium" for moderate, "very thorough" for comprehensive analysis.
- sisyphus-junior: Sisyphus-Junior - Focused task executor. Same discipline, no delegation.
- oracle: Read-only consultation agent. High-IQ reasoning specialist for debugging hard problems and high-difficulty architecture design.
- librarian: Specialized codebase understanding agent for multi-repository analysis, searching remote codebases, retrieving official documentation, and finding implementation examples using GitHub CLI, Context7, and Web Search. MUST BE USED when users ask to look up code in remote repositories, explain library internals, or find usage examples in open source.
- multimodal-looker: Analyze media files (PDFs, images, diagrams) that require interpretation beyond raw text.
- metis: Pre-planning consultant that analyzes requests to identify hidden intentions, ambiguities, and AI failure points.
- momus: Expert reviewer for evaluating work plans against rigorous clarity, verifiability, and completeness standards.

When using the Task tool, you must specify a subagent_type parameter.`

    const mcpTools = [
      "mcp__opencode__read",
      "mcp__opencode__write",
      "mcp__opencode__edit",
      "mcp__opencode__bash",
      "mcp__opencode__glob",
      "mcp__opencode__grep",
    ]

    const agents = buildAgentDefinitions(omooDescription, mcpTools)

    // All 10 base agents extracted (all 4 defaults already present)
    const base = baseAgentNames(agents)
    expect(base).toHaveLength(10)

    // Each base agent has proper structure
    for (const name of base) {
      const def = agents[name]!
      expect(def.description.length).toBeGreaterThan(10)
      expect(def.prompt).toContain(name)
      expect(def.model).toBe("inherit")
      expect(def.tools).toEqual(mcpTools)
    }

    // Specific agents have correct descriptions from user's config
    expect(agents["oracle"]!.description).toContain("Read-only consultation")
    expect(agents["librarian"]!.description).toContain("multi-repository")
    expect(agents["explore"]!.description).toContain("Contextual grep")
    expect(agents["metis"]!.description).toContain("Pre-planning consultant")
    expect(agents["momus"]!.description).toContain("Expert reviewer")
  })
})

describe("No Task tool (no agents)", () => {
  it("should return empty when no Task tool in request", () => {
    const agents = buildAgentDefinitions("")
    expect(Object.keys(agents)).toHaveLength(0)
  })

  it("should return empty when description has no agent section", () => {
    const agents = buildAgentDefinitions("Launch a new agent to handle tasks.")
    expect(Object.keys(agents)).toHaveLength(0)
  })
})

describe("Default agent injection", () => {
  it("should inject defaults when parsing yields results", () => {
    const desc = `Available agent types and the tools they have access to:
- oracle: Read-only consultation agent.`
    const agents = buildAgentDefinitions(desc)

    // 1 parsed + 4 defaults (build, plan, explore, general) = 5 base agents
    expect(baseAgentNames(agents)).toHaveLength(5)
    expect(agents["oracle"]).toBeDefined()
    expect(agents["build"]).toBeDefined()
    expect(agents["plan"]).toBeDefined()
    expect(agents["explore"]).toBeDefined()
    expect(agents["general"]).toBeDefined()
  })

  it("should NOT inject defaults when parsing yields nothing", () => {
    const agents = buildAgentDefinitions("No agents here")
    expect(Object.keys(agents)).toHaveLength(0)
  })

  it("user-defined agents take priority over defaults", () => {
    const desc = `Available agent types and the tools they have access to:
- build: My custom build agent with special powers.`
    const agents = buildAgentDefinitions(desc)

    // User's description should NOT be overwritten by the default
    expect(agents["build"]!.description).toBe("My custom build agent with special powers.")
  })

  it("should include MCP tools in default agent definitions", () => {
    const desc = `Available agent types and the tools they have access to:
- oracle: Read-only consultation agent.`
    const mcpTools = ["mcp__opencode__read", "mcp__opencode__bash"]
    const agents = buildAgentDefinitions(desc, mcpTools)

    // Injected defaults should also get MCP tools
    expect(agents["general"]!.tools).toEqual(mcpTools)
    expect(agents["explore"]!.tools).toEqual(mcpTools)
  })

  it("fallback agent name is always present when agents exist", () => {
    const desc = `Available agent types and the tools they have access to:
- build: The default agent.`
    const agents = buildAgentDefinitions(desc)

    expect(agents[FALLBACK_AGENT_NAME]).toBeDefined()
  })
})

describe("Case variant registration", () => {
  it("should register PascalCase variants for all agents", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)

    // PascalCase variants should exist
    expect(defs["Explore"]).toBeDefined()
    expect(defs["Build"]).toBeDefined()
    expect(defs["Plan"]).toBeDefined()
    expect(defs["Oracle"]).toBeDefined()
    expect(defs["Librarian"]).toBeDefined()
    expect(defs["General"]).toBeDefined()
    expect(defs["Sisyphus-Junior"]).toBeDefined()
  })

  it("PascalCase variant should share the same definition as the base", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)

    expect(defs["Explore"]!.description).toBe(defs["explore"]!.description)
    expect(defs["Oracle"]!.prompt).toBe(defs["oracle"]!.prompt)
  })

  it("should register 'general-purpose' alias", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION)

    expect(defs["general-purpose"]).toBeDefined()
    expect(defs["General-Purpose"]).toBeDefined()
    expect(defs["general-purpose"]!.description).toBe(defs["general"]!.description)
  })

  it("should not add variants when no agents exist", () => {
    const defs = buildAgentDefinitions("No agents here")
    expect(Object.keys(defs)).toHaveLength(0)
  })
})
