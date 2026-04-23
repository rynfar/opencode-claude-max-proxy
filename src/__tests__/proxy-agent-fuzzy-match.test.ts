/**
 * Agent Name Fuzzy Matching Tests
 *
 * When Claude sends an invalid agent type (e.g., "general-purpose"),
 * the proxy should rewrite it to the closest valid agent name extracted
 * from the Task tool definition in the request.
 *
 * This is deterministic string matching, not LLM guessing.
 */

import { describe, it, expect } from "bun:test"

// Import the matching function directly
import { fuzzyMatchAgentName } from "../proxy/agentMatch"

describe("fuzzyMatchAgentName", () => {
  const validAgents = [
    "build", "plan", "general", "explore",
    "sisyphus-junior", "oracle", "librarian",
    "multimodal-looker", "metis", "momus"
  ]

  // --- Exact matches (already correct) ---
  it("should return exact match unchanged", () => {
    expect(fuzzyMatchAgentName("explore", validAgents)).toBe("explore")
    expect(fuzzyMatchAgentName("oracle", validAgents)).toBe("oracle")
    expect(fuzzyMatchAgentName("build", validAgents)).toBe("build")
  })

  // --- Capitalization ---
  it("should lowercase and match", () => {
    expect(fuzzyMatchAgentName("Explore", validAgents)).toBe("explore")
    expect(fuzzyMatchAgentName("Oracle", validAgents)).toBe("oracle")
    expect(fuzzyMatchAgentName("LIBRARIAN", validAgents)).toBe("librarian")
    expect(fuzzyMatchAgentName("Sisyphus-Junior", validAgents)).toBe("sisyphus-junior")
  })

  // --- Common SDK mistakes ---
  it("should map 'general-purpose' to 'general'", () => {
    expect(fuzzyMatchAgentName("general-purpose", validAgents)).toBe("general")
    expect(fuzzyMatchAgentName("General-Purpose", validAgents)).toBe("general")
  })

  it("should map 'code-reviewer' or 'reviewer' to 'oracle'", () => {
    // Oracle's description says "Read-only consultation agent"
    // Claude might guess "code-reviewer" for a review task
    expect(fuzzyMatchAgentName("code-reviewer", validAgents)).toBe("oracle")
    expect(fuzzyMatchAgentName("reviewer", validAgents)).toBe("oracle")
  })

  // --- Prefix/substring matching ---
  it("should match by prefix", () => {
    expect(fuzzyMatchAgentName("lib", validAgents)).toBe("librarian")
    expect(fuzzyMatchAgentName("multi", validAgents)).toBe("multimodal-looker")
    expect(fuzzyMatchAgentName("sisyphus", validAgents)).toBe("sisyphus-junior")
  })

  it("should match by substring", () => {
    expect(fuzzyMatchAgentName("looker", validAgents)).toBe("multimodal-looker")
    expect(fuzzyMatchAgentName("junior", validAgents)).toBe("sisyphus-junior")
  })

  // --- Suffix stripping ---
  it("should strip common suffixes and match", () => {
    expect(fuzzyMatchAgentName("explore-agent", validAgents)).toBe("explore")
    expect(fuzzyMatchAgentName("oracle-agent", validAgents)).toBe("oracle")
    expect(fuzzyMatchAgentName("build-agent", validAgents)).toBe("build")
  })

  // --- No match → route to fallback agent ---
  it("should route unknown names to 'general' when it exists in valid agents", () => {
    expect(fuzzyMatchAgentName("nonexistent", validAgents)).toBe("general")
    expect(fuzzyMatchAgentName("FooBar", validAgents)).toBe("general")
    expect(fuzzyMatchAgentName("completely-made-up-agent", validAgents)).toBe("general")
  })

  // --- Edge cases ---
  it("should handle empty input", () => {
    expect(fuzzyMatchAgentName("", validAgents)).toBe("")
  })

  it("should handle empty valid agents list", () => {
    expect(fuzzyMatchAgentName("explore", [])).toBe("explore")
  })

  // --- Common oh-my-opencode agent aliases ---
  it("should match common aliases", () => {
    expect(fuzzyMatchAgentName("search", validAgents)).toBe("explore")
    expect(fuzzyMatchAgentName("research", validAgents)).toBe("librarian")
    expect(fuzzyMatchAgentName("consult", validAgents)).toBe("oracle")
  })
})

describe("Fallback to generic agent", () => {
  it("should fall back to lowercased original when 'general' is NOT in valid agents", () => {
    const agentsWithoutGeneral = ["build", "plan", "oracle"]
    expect(fuzzyMatchAgentName("nonexistent", agentsWithoutGeneral)).toBe("nonexistent")
    expect(fuzzyMatchAgentName("FooBar", agentsWithoutGeneral)).toBe("foobar")
  })

  it("should route completely unknown names to 'general' when it exists", () => {
    const agentsWithGeneral = ["build", "plan", "general"]
    expect(fuzzyMatchAgentName("xyzzy", agentsWithGeneral)).toBe("general")
    expect(fuzzyMatchAgentName("ProviderModelNotFoundError", agentsWithGeneral)).toBe("general")
  })

  it("should still prefer real matches over fallback", () => {
    const agents = ["build", "plan", "general", "explore"]
    // Prefix match should still work before fallback
    expect(fuzzyMatchAgentName("exp", agents)).toBe("explore")
    // Alias should still work before fallback
    expect(fuzzyMatchAgentName("planner", agents)).toBe("plan")
  })
})
