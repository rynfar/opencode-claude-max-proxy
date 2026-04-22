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
 * Create an MCP server with tool definitions matching OpenCode's request.
 *
 * Auto-defer: when the tool count exceeds the threshold and coreToolNames
 * is provided, non-core tools are registered without alwaysLoad so the SDK
 * defers them. Core tools are marked alwaysLoad to stay in the prompt.
 * Client-provided defer_loading: true also triggers deferral for specific tools.
 */
export function createPassthroughMcpServer(
  tools: Array<{ name: string; description?: string; input_schema?: any; defer_loading?: boolean }>,
  coreToolNames?: readonly string[]
) {
  const server = createSdkMcpServer({ name: PASSTHROUGH_MCP_NAME })
  const toolNames: string[] = []

  // Auto-defer: if tool count exceeds threshold and adapter provides core tools
  const threshold = getAutoDeferThreshold()
  const autoDefer = !!(threshold > 0 && coreToolNames && coreToolNames.length > 0 && tools.length > threshold)
  const coreSet = autoDefer ? new Set(coreToolNames.map(n => n.toLowerCase())) : undefined

  // hasDeferredTools is true when: client explicitly defers any tool, OR auto-defer kicks in
  const hasDeferredTools = tools.some(t => t.defer_loading === true) || autoDefer

  // Sort tools alphabetically by name to ensure deterministic MCP registration
  // order. Non-deterministic ordering changes the SDK system prompt between
  // requests, invalidating prompt cache and causing full context re-reads.
  const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name))

  for (const tool of sortedTools) {
    try {
      // Convert OpenCode's JSON Schema to Zod for MCP registration
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
        async () => ({ content: [{ type: "text" as const, text: "passthrough" }] })
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
        async () => ({ content: [{ type: "text" as const, text: "passthrough" }] })
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

function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function toSnakeCase(s: string): string {
  return s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
}

/**
 * Normalize tool input parameter names to match the client's schema.
 *
 * The Claude Code SDK's system prompt references built-in tools with
 * snake_case parameter names (e.g., file_path), but clients like OpenCode
 * may use camelCase (e.g., filePath). When the model generates a tool call
 * using the SDK's naming convention instead of the MCP schema's convention,
 * required parameters appear undefined on the client side.
 *
 * This function detects unrecognized keys, tries snake_case ↔ camelCase
 * conversion, and remaps them when a match exists in the client's schema.
 * It only activates when at least one required parameter is missing, so
 * well-formed tool calls pass through untouched.
 */
export function normalizeToolInput(
  input: Record<string, unknown> | undefined,
  clientSchema: { properties?: Record<string, unknown>; required?: string[] } | undefined,
): Record<string, unknown> | undefined {
  if (!input || !clientSchema?.properties) return input

  const schemaKeys = new Set(Object.keys(clientSchema.properties))
  const required = new Set(clientSchema.required ?? [])

  // Fast path: all required fields are present, no normalization needed
  const missingRequired = [...required].filter(k => input[k] === undefined)
  if (missingRequired.length === 0) return input

  const normalized = { ...input }

  for (const key of Object.keys(normalized)) {
    if (schemaKeys.has(key)) continue // Already matches

    // Try camelCase: file_path → filePath
    const camel = toCamelCase(key)
    if (camel !== key && schemaKeys.has(camel) && normalized[camel] === undefined) {
      normalized[camel] = normalized[key]
      delete normalized[key]
      continue
    }

    // Try snake_case: filePath → file_path
    const snake = toSnakeCase(key)
    if (snake !== key && schemaKeys.has(snake) && normalized[snake] === undefined) {
      normalized[snake] = normalized[key]
      delete normalized[key]
    }
  }

  return normalized
}
