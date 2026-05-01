import type { Transform, RequestContext } from "../transform"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS } from "../tools"

const DROID_MCP_SERVER_NAME = "droid"
const DROID_ALLOWED_MCP_TOOLS: readonly string[] = [
  `mcp__${DROID_MCP_SERVER_NAME}__read`,
  `mcp__${DROID_MCP_SERVER_NAME}__write`,
  `mcp__${DROID_MCP_SERVER_NAME}__edit`,
  `mcp__${DROID_MCP_SERVER_NAME}__bash`,
  `mcp__${DROID_MCP_SERVER_NAME}__glob`,
  `mcp__${DROID_MCP_SERVER_NAME}__grep`,
]

/**
 * Resolve passthrough mode for Droid from env. Mirrors the adapter's
 * `usesPassthrough()` so the transform and adapter agree (transform-parity
 * test enforces this). Default is OFF — opt in via `MERIDIAN_PASSTHROUGH=1`.
 *
 * Historically this was hardcoded to `false` because Droid's BYOK didn't
 * close the tool execution loop (Claude saw no tool_result). Verified
 * working on Droid v0.114.1: tool_use → tool_result roundtrip completes
 * correctly. Older Droid users on a buggy version can keep the default
 * (no env var) or explicitly set `MERIDIAN_PASSTHROUGH=0`.
 */
function resolveDroidPassthrough(): boolean {
  const envVal = process.env.MERIDIAN_PASSTHROUGH ?? process.env.CLAUDE_PROXY_PASSTHROUGH
  return envVal === "1" || envVal === "true" || envVal === "yes"
}

export const droidTransforms: Transform[] = [
  {
    name: "droid-core",
    adapters: ["droid"],
    onRequest(ctx: RequestContext): RequestContext {
      return {
        ...ctx,
        blockedTools: BLOCKED_BUILTIN_TOOLS,
        incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
        allowedMcpTools: DROID_ALLOWED_MCP_TOOLS,
        sdkAgents: {},
        passthrough: resolveDroidPassthrough(),
        leaksCwdViaSystemReminder: true,
      }
    },
  },
]
