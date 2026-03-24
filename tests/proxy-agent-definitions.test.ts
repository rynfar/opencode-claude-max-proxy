/**
 * Agent Definition Extraction Tests
 *
 * Verifies that we correctly parse agent descriptions from OpenCode's
 * Task tool and convert them to SDK AgentDefinition objects.
 */

import { describe, expect, it } from "bun:test";
import {
  buildAgentDefinitions,
  parseAgentDescriptions,
} from "../src/providers/claude/agents";
import { mapModelToClaudeModel } from "../src/providers/claude/parse";

const SAMPLE_TASK_DESCRIPTION = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.
- explore: Contextual grep for codebases. Answers "Where is X?", "Which file has Y?".
- oracle: Read-only consultation agent. High-IQ reasoning specialist for debugging hard problems.
- librarian: Specialized codebase understanding agent for multi-repository analysis.
- sisyphus-junior: Sisyphus-Junior - Focused task executor. Same discipline, no delegation.

When using the Task tool, you must specify a subagent_type parameter.`;

describe("parseAgentDescriptions", () => {
  it("should extract all agent names and descriptions", () => {
    const agents = parseAgentDescriptions(SAMPLE_TASK_DESCRIPTION);

    expect(agents.size).toBe(6);
    expect(agents.get("build")).toBe(
      "The default agent. Executes tools based on configured permissions.",
    );
    expect(agents.get("plan")).toBe("Plan mode. Disallows all edit tools.");
    expect(agents.get("explore")).toContain("Contextual grep");
    expect(agents.get("oracle")).toContain("Read-only consultation");
    expect(agents.get("librarian")).toContain("multi-repository");
    expect(agents.get("sisyphus-junior")).toContain("Focused task executor");
  });

  it("should return empty map for missing agent section", () => {
    const agents = parseAgentDescriptions("No agents here");
    expect(agents.size).toBe(0);
  });

  it("should handle single agent", () => {
    const desc = `Available agent types and the tools they have access to:
- solo: The only agent.`;
    const agents = parseAgentDescriptions(desc);
    expect(agents.size).toBe(1);
    expect(agents.get("solo")).toBe("The only agent.");
  });
});

describe("buildAgentDefinitions", () => {
  it("should create AgentDefinition for each parsed agent", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION);

    expect(Object.keys(defs)).toHaveLength(6);
    expect(defs.oracle).toBeDefined();
    expect(defs.explore).toBeDefined();
    expect(defs.build).toBeDefined();
  });

  it("each agent should have description, prompt, and model", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION);

    for (const [name, def] of Object.entries(defs)) {
      expect(def.description).toBeTruthy();
      expect(def.prompt).toContain(name);
      expect(def.model).toBe("inherit");
    }
  });

  it("agent prompt should incorporate the description", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION);

    expect(defs.oracle?.prompt).toContain("oracle");
    expect(defs.oracle?.prompt).toContain("Read-only consultation");
  });

  it("should include MCP tools when provided", () => {
    const mcpTools = ["mcp__opencode__read", "mcp__opencode__bash"];
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION, mcpTools);

    expect(defs.oracle?.tools).toEqual(mcpTools);
    expect(defs.explore?.tools).toEqual(mcpTools);
  });

  it("should not include tools when none provided", () => {
    const defs = buildAgentDefinitions(SAMPLE_TASK_DESCRIPTION);
    expect(defs.oracle?.tools).toBeUndefined();
  });

  it("should return empty object for no agents", () => {
    const defs = buildAgentDefinitions("No agents here");
    expect(Object.keys(defs)).toHaveLength(0);
  });
});

describe("mapModelToClaudeModel", () => {
  it("should map opus models", () => {
    expect(mapModelToClaudeModel("anthropic/claude-opus-4-6")).toBe("opus[1m]");
    expect(mapModelToClaudeModel("claude-opus-4")).toBe("opus[1m]");
  });

  it("should map sonnet models", () => {
    expect(mapModelToClaudeModel("anthropic/claude-sonnet-4-5")).toBe("sonnet");
  });

  it("should map haiku models", () => {
    expect(mapModelToClaudeModel("anthropic/claude-haiku-4-5")).toBe("haiku");
  });

  it("should return sonnet for non-Anthropic models (default)", () => {
    expect(mapModelToClaudeModel("openai/gpt-5.2")).toBe("sonnet");
    expect(mapModelToClaudeModel("google/gemini-3-flash")).toBe("sonnet");
  });
});

describe("Native OpenCode (no oh-my-opencode)", () => {
  it("should handle minimal native agents (build + plan only)", () => {
    const nativeDescription = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.

When using the Task tool, you must specify a subagent_type parameter.`;

    const agents = buildAgentDefinitions(nativeDescription);

    expect(Object.keys(agents)).toHaveLength(2);
    expect(agents.build).toBeDefined();
    expect(agents.plan).toBeDefined();
    expect(agents.build?.description).toContain("default agent");
    expect(agents.plan?.description).toContain("Plan mode");
  });

  it("should handle native + custom agents from opencode.json", () => {
    // User can define custom agents in opencode.json "agent" section
    const customDescription = `Launch a new agent to handle complex, multistep tasks autonomously.

Available agent types and the tools they have access to:
- build: The default agent. Executes tools based on configured permissions.
- plan: Plan mode. Disallows all edit tools.
- librarian: Documentation search agent.

When using the Task tool, you must specify a subagent_type parameter.`;

    const agents = buildAgentDefinitions(customDescription);

    expect(Object.keys(agents)).toHaveLength(3);
    expect(agents.librarian).toBeDefined();
    expect(agents.librarian?.description).toContain("Documentation search");
  });
});

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

When using the Task tool, you must specify a subagent_type parameter.`;

    const mcpTools = [
      "mcp__opencode__read",
      "mcp__opencode__write",
      "mcp__opencode__edit",
      "mcp__opencode__bash",
      "mcp__opencode__glob",
      "mcp__opencode__grep",
    ];

    const agents = buildAgentDefinitions(omooDescription, mcpTools);

    // All 10 agents extracted
    expect(Object.keys(agents)).toHaveLength(10);

    // Each agent has proper structure
    for (const [name, def] of Object.entries(agents)) {
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.prompt).toContain(name);
      expect(def.model).toBe("inherit");
      expect(def.tools).toEqual(mcpTools);
    }

    // Specific agents have correct descriptions from user's config
    expect(agents.oracle?.description).toContain("Read-only consultation");
    expect(agents.librarian?.description).toContain("multi-repository");
    expect(agents.explore?.description).toContain("Contextual grep");
    expect(agents.metis?.description).toContain("Pre-planning consultant");
    expect(agents.momus?.description).toContain("Expert reviewer");
  });
});

describe("No Task tool (no agents)", () => {
  it("should return empty when no Task tool in request", () => {
    const agents = buildAgentDefinitions("");
    expect(Object.keys(agents)).toHaveLength(0);
  });

  it("should return empty when description has no agent section", () => {
    const agents = buildAgentDefinitions("Launch a new agent to handle tasks.");
    expect(Object.keys(agents)).toHaveLength(0);
  });
});
