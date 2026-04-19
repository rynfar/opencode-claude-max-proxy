/**
 * Dynamic MCP tool registration for passthrough mode.
 *
 * In passthrough mode, OpenCode's tools need to be real callable tools
 * (not just text descriptions in the prompt). We create an MCP server
 * that registers each tool from OpenCode's request with the exact
 * name and schema, so Claude generates proper tool_use blocks.
 *
 * Tool handlers are no-ops — the PreToolUse hook blocks execution.
 * We just need the definitions so Claude can call them.
 */

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

export const PASSTHROUGH_MCP_NAME = "oc"
export const PASSTHROUGH_MCP_PREFIX = `mcp__${PASSTHROUGH_MCP_NAME}__`

/**
 * Convert a JSON Schema object to a Zod schema (simplified).
 * Handles the common types OpenCode sends. Falls back to z.any() for complex types.
 */
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any()

  if (schema.type === "string") {
    let s = z.string()
    if (schema.description) s = s.describe(schema.description)
    if (schema.enum) return z.enum(schema.enum as [string, ...string[]])
    return s
  }
  if (schema.type === "number" || schema.type === "integer") {
    let n = z.number()
    if (schema.description) n = n.describe(schema.description)
    return n
  }
  if (schema.type === "boolean") return z.boolean()
  if (schema.type === "array") {
    const items = schema.items ? jsonSchemaToZod(schema.items) : z.any()
    return z.array(items)
  }
  if (schema.type === "object" && schema.properties) {
    const shape: Record<string, z.ZodTypeAny> = {}
    const required = new Set(schema.required || [])
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const zodProp = jsonSchemaToZod(propSchema as any)
      shape[key] = required.has(key) ? zodProp : zodProp.optional()
    }
    return z.object(shape)
  }

  return z.any()
}

/** Default threshold: auto-defer when tool count exceeds this.
 *  Override with MERIDIAN_DEFER_TOOL_THRESHOLD env var. Set to 0 to disable. */
const DEFAULT_DEFER_THRESHOLD = 15

export function getAutoDeferThreshold(): number {
  const raw = process.env.MERIDIAN_DEFER_TOOL_THRESHOLD
  if (raw === undefined) return DEFAULT_DEFER_THRESHOLD
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DEFER_THRESHOLD
  return parsed
}

/**
 * Deferred-mode hook pair used by persistent-mode passthrough (design §D11).
 *
 * In persistent mode, each MCP handler invocation:
 *   1. Calls `dequeueToolUseId(toolName)` to correlate with the tool_use_id
 *      captured by the PreToolUse hook earlier in the same turn (FIFO per
 *      tool name; PreToolUse always fires strictly before its MCP handler).
 *   2. Calls `registerPendingExecution(toolUseId)` on the runtime; blocks on
 *      the returned promise until meridian resolves it with the real
 *      tool_result content from the client's next HTTP request.
 *   3. Returns that content as the MCP handler's `{ content: [{ type: "text",
 *      text }] }` return value, which the SDK feeds to the model as the
 *      tool's natural return value — no sentinel, no synthetic blocked
 *      narrative (see §1d Scenario D in spike-notes.md).
 *
 * When `deferredMode` is undefined, handlers fall back to the legacy no-op
 * "passthrough" text return, preserving the flag-off behavior bit-identically.
 */
export interface PassthroughDeferredMode {
  dequeueToolUseId: (toolName: string) => string | undefined
  registerPendingExecution: (toolUseId: string) => Promise<string>
}

export interface CreatePassthroughMcpOptions {
  deferredMode?: PassthroughDeferredMode
}

/**
 * Factory for a single tool's deferred handler. Exported for unit tests; the
 * full MCP server wraps this for every registered tool via `createPassthroughMcpServer`.
 */
export function createDeferredPassthroughHandler(
  toolName: string,
  deferredMode: PassthroughDeferredMode,
): () => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async () => {
    const toolUseId = deferredMode.dequeueToolUseId(toolName)
    if (!toolUseId) {
      throw new Error(
        `passthrough deferred handler: no captured tool_use_id for ${toolName} ` +
        `(PreToolUse hook / MCP handler coordination lost)`,
      )
    }
    const content = await deferredMode.registerPendingExecution(toolUseId)
    return { content: [{ type: "text" as const, text: content }] }
  }
}

/**
 * Create an MCP server with tool definitions matching the agent's request.
 *
 * Auto-defer: when the tool count exceeds the threshold and coreToolNames
 * is provided, non-core tools are registered without alwaysLoad so the SDK
 * defers them. Core tools are marked alwaysLoad to stay in the prompt.
 * Client-provided defer_loading: true also triggers deferral for specific tools.
 *
 * Deferred mode (persistent-sdk-sessions): pass a `deferredMode` hook pair to
 * switch every tool handler into the §D11 deferred-handler pattern. See
 * `PassthroughDeferredMode` above.
 */
export function createPassthroughMcpServer(
  tools: Array<{ name: string; description?: string; input_schema?: any; defer_loading?: boolean }>,
  coreToolNames?: readonly string[],
  options?: CreatePassthroughMcpOptions,
) {
  const server = createSdkMcpServer({ name: PASSTHROUGH_MCP_NAME })
  const toolNames: string[] = []

  // Auto-defer: if tool count exceeds threshold and adapter provides core tools
  const threshold = getAutoDeferThreshold()
  const autoDefer = !!(threshold > 0 && coreToolNames && coreToolNames.length > 0 && tools.length > threshold)
  const coreSet = autoDefer ? new Set(coreToolNames.map(n => n.toLowerCase())) : undefined

  // hasDeferredTools is true when: client explicitly defers any tool, OR auto-defer kicks in
  const hasDeferredTools = tools.some(t => t.defer_loading === true) || autoDefer

  const deferredMode = options?.deferredMode

  // Build the handler for a given tool. In deferred mode the handler correlates
  // with the PreToolUse hook via a per-tool-name FIFO of captured tool_use_ids,
  // registers a pending execution on the runtime, and awaits until the client
  // sends the real tool_result. Outside deferred mode we keep the legacy no-op
  // text so flag-off behavior is unchanged.
  const makeHandler = (toolName: string) =>
    deferredMode
      ? createDeferredPassthroughHandler(toolName, deferredMode)
      : async () => ({ content: [{ type: "text" as const, text: "passthrough" }] })

  // Sort tools alphabetically by name to ensure deterministic MCP registration
  // order. Non-deterministic ordering changes the SDK system prompt between
  // requests, invalidating prompt cache and causing full context re-reads.
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name))

  for (const tool of sortedTools) {
    const handler = makeHandler(tool.name)
    try {
      // Convert JSON Schema to Zod for MCP registration
      const zodSchema = tool.input_schema?.properties
        ? jsonSchemaToZod(tool.input_schema)
        : z.object({})

      // The raw shape for the tool() call needs to be a record of Zod types
      const shape: Record<string, z.ZodTypeAny> =
        zodSchema instanceof z.ZodObject
          ? (zodSchema as any).shape
          : { input: z.any() }

      server.instance.registerTool(
        tool.name,
        {
          description: tool.description || tool.name,
          inputSchema: shape,
          // Mark tool as alwaysLoad when it should stay in the prompt:
          // - Client explicitly did NOT set defer_loading on this tool, OR
          // - Auto-defer is active and this tool is in the core set
          ...(hasDeferredTools ? (shouldAlwaysLoad(tool, coreSet) ? { _meta: { "anthropic/alwaysLoad": true } } : {}) : {}),
        },
        handler,
      )
      toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${tool.name}`)
    } catch {
      // If schema conversion fails, register with permissive schema
      server.instance.registerTool(
        tool.name,
        {
          description: tool.description || tool.name,
          inputSchema: { input: z.string().optional() },
          ...(hasDeferredTools ? (shouldAlwaysLoad(tool, coreSet) ? { _meta: { "anthropic/alwaysLoad": true } } : {}) : {}),
        },
        handler,
      )
      toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${tool.name}`)
    }
  }

  return { server, toolNames, hasDeferredTools }
}

/**
 * Determine if a tool should be marked alwaysLoad (kept in prompt, not deferred).
 * A tool is always-loaded when:
 * - Client explicitly did NOT set defer_loading on it AND no auto-defer, OR
 * - Auto-defer is active and the tool name is in the core set, OR
 * - Client explicitly set defer_loading: false (opt out of deferral)
 */
function shouldAlwaysLoad(
  tool: { name: string; defer_loading?: boolean },
  coreSet: Set<string> | undefined
): boolean {
  // Client explicitly deferred this tool — never alwaysLoad
  if (tool.defer_loading === true) return false
  // Auto-defer active: only core tools get alwaysLoad
  if (coreSet) return coreSet.has(tool.name.toLowerCase())
  // No auto-defer: client-triggered deferral — non-deferred tools get alwaysLoad
  return true
}

/**
 * Stable cache key for a tool set — name + input schema, sorted.
 * Schema is included so silently-updated tool definitions force a rebuild
 * of the cached MCP server.
 */
export function computeToolSetKey(
  tools: Array<{ name: string; input_schema?: unknown; defer_loading?: boolean }>
): string {
  const entries = tools
    .map(t => ({
      name: t.name,
      defer: t.defer_loading === true,
      schema: stableStringify(t.input_schema ?? null),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return JSON.stringify(entries)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${parts.join(",")}}`
}

/**
 * Strip the MCP prefix from a tool name to get the OpenCode tool name.
 * e.g., "mcp__oc__todowrite" → "todowrite"
 */
export function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith(PASSTHROUGH_MCP_PREFIX)) {
    return toolName.slice(PASSTHROUGH_MCP_PREFIX.length)
  }
  return toolName
}
