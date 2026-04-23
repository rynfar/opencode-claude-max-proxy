/**
 * Fuzzy matching for agent names.
 *
 * When Claude sends an invalid subagent_type, this tries to map it
 * to the closest valid agent name. This is deterministic string matching,
 * not LLM guessing.
 *
 * Matching priority:
 * 1. Exact match (case-insensitive)
 * 2. Known aliases (e.g., "general-purpose" → "general")
 * 3. Prefix match (e.g., "lib" → "librarian")
 * 4. Substring match (e.g., "junior" → "sisyphus-junior")
 * 5. Suffix-stripped match (e.g., "explore-agent" → "explore")
 * 6. Semantic aliases (e.g., "search" → "explore")
 * 7. Fallback: route to generic agent if registered, otherwise lowercased original
 */

import { FALLBACK_AGENT_NAME } from "./agentDefs"

// Known aliases for common SDK mistakes
const KNOWN_ALIASES: Record<string, string> = {
  "general-purpose": "general",
  "default": "general",
  "code-reviewer": "oracle",
  "reviewer": "oracle",
  "code-review": "oracle",
  "review": "oracle",
  "consultation": "oracle",
  "analyzer": "oracle",
  "debugger": "oracle",
  "search": "explore",
  "grep": "explore",
  "find": "explore",
  "codebase-search": "explore",
  "research": "librarian",
  "docs": "librarian",
  "documentation": "librarian",
  "lookup": "librarian",
  "reference": "librarian",
  "consult": "oracle",
  "architect": "oracle",
  "image-analyzer": "multimodal-looker",
  "image": "multimodal-looker",
  "pdf": "multimodal-looker",
  "visual": "multimodal-looker",
  "planner": "plan",
  "planning": "plan",
  "builder": "build",
  "coder": "build",
  "developer": "build",
  "writer": "build",
  "executor": "build",
}

// Common suffixes to strip
const STRIP_SUFFIXES = ["-agent", "-tool", "-worker", "-task", " agent", " tool"]

export function fuzzyMatchAgentName(input: string, validAgents: string[]): string {
  if (!input) return input
  if (validAgents.length === 0) return input.toLowerCase()

  const lowered = input.toLowerCase()

  // 1. Exact match (case-insensitive)
  const exact = validAgents.find(a => a.toLowerCase() === lowered)
  if (exact) return exact

  // 2. Known aliases
  const alias = KNOWN_ALIASES[lowered]
  if (alias && validAgents.includes(alias)) return alias

  // 3. Prefix match
  const prefixMatch = validAgents.find(a => a.toLowerCase().startsWith(lowered))
  if (prefixMatch) return prefixMatch

  // 4. Substring match
  const substringMatch = validAgents.find(a => a.toLowerCase().includes(lowered))
  if (substringMatch) return substringMatch

  // 5. Suffix-stripped match
  for (const suffix of STRIP_SUFFIXES) {
    if (lowered.endsWith(suffix)) {
      const stripped = lowered.slice(0, -suffix.length)
      const strippedMatch = validAgents.find(a => a.toLowerCase() === stripped)
      if (strippedMatch) return strippedMatch
    }
  }

  // 6. Reverse substring (input contains a valid agent name)
  const reverseMatch = validAgents.find(a => lowered.includes(a.toLowerCase()))
  if (reverseMatch) return reverseMatch

  // 7. Fallback: route to registered generic agent if available
  if (validAgents.includes(FALLBACK_AGENT_NAME)) return FALLBACK_AGENT_NAME
  return lowered
}
