/**
 * OpenCode plugin — agent mode headers for Meridian.
 *
 * Sends x-opencode-agent-name and x-opencode-agent-mode headers with every
 * Anthropic API request so Meridian can make context-aware model decisions:
 *
 *   - Primary agents get opus[1m] / sonnet[1m] (full 1M context window)
 *   - Subagents get opus / sonnet (200k context, saves rate limit budget)
 *
 * This plugin works alongside claude-max-headers.ts. Both can be loaded
 * simultaneously — they write different headers.
 *
 * Usage:
 *   Copy this file into your project and add to opencode.json:
 *     { "plugin": ["./meridian-agent-mode.ts"] }
 *
 *   Or combine with the session headers plugin:
 *     { "plugin": ["./claude-max-headers.ts", "./meridian-agent-mode.ts"] }
 */

type ChatHeadersHook = (
  incoming: {
    sessionID: string
    agent: string
    model: { providerID: string }
    provider: any
    message: { id: string }
  },
  output: { headers: Record<string, string> }
) => Promise<void>

type PluginHooks = {
  "chat.headers"?: ChatHeadersHook
}

type PluginFn = (input: any) => Promise<PluginHooks>

export const MeridianAgentModePlugin: PluginFn = async ({ client }) => {
  // Build agent name -> mode lookup at plugin init
  let agentModeMap = new Map<string, string>()

  try {
    const agents = await client.agent.list()
    agentModeMap = new Map(agents.map((a: any) => [a.name, a.mode ?? "primary"]))
  } catch {
    // Agent list not available — fall back to "primary" for all
  }

  return {
    "chat.headers": async (incoming, output) => {
      // Only inject headers for Anthropic provider requests (Meridian)
      if (incoming.model.providerID !== "anthropic") return

      const agentName = incoming.agent ?? "unknown"
      const mode = agentModeMap.get(agentName) ?? "primary"

      output.headers["x-opencode-agent-name"] = agentName
      output.headers["x-opencode-agent-mode"] = mode
    },
  }
}

export default MeridianAgentModePlugin
