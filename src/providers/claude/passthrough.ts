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

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { logger } from "@/logger";
import type { JsonSchema, ToolDefinition } from "./types";

export const PASSTHROUGH_MCP_NAME = "oc";
export const PASSTHROUGH_MCP_PREFIX = `mcp__${PASSTHROUGH_MCP_NAME}__`;

function jsonSchemaToZod(schema: JsonSchema | undefined): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();

  if (schema.type === "string") {
    let s = z.string();
    if (schema.description) s = s.describe(schema.description);
    if (schema.enum) return z.enum(schema.enum as [string, ...string[]]);
    return s;
  }
  if (schema.type === "number" || schema.type === "integer") {
    let n = z.number();
    if (schema.description) n = n.describe(schema.description);
    return n;
  }
  if (schema.type === "boolean") return z.boolean();
  if (schema.type === "array") {
    const items = schema.items ? jsonSchemaToZod(schema.items) : z.any();
    return z.array(items);
  }
  if (schema.type === "object" && schema.properties) {
    const shape: Record<string, z.ZodTypeAny> = {};
    const required = new Set(schema.required || []);
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const zodProp = jsonSchemaToZod(propSchema);
      shape[key] = required.has(key) ? zodProp : zodProp.optional();
    }
    return z.object(shape);
  }

  return z.any();
}

export function createPassthroughMcpServer(tools: ToolDefinition[]) {
  const server = createSdkMcpServer({ name: PASSTHROUGH_MCP_NAME });
  const toolNames: string[] = [];

  for (const t of tools) {
    try {
      const zodSchema = t.input_schema?.properties
        ? jsonSchemaToZod(t.input_schema)
        : z.object({});

      const shape: Record<string, z.ZodTypeAny> =
        zodSchema instanceof z.ZodObject
          ? (zodSchema as z.ZodObject<z.ZodRawShape>).shape
          : { input: z.any() };

      server.instance.tool(
        t.name,
        t.description || t.name,
        shape,
        async () => ({
          content: [{ type: "text" as const, text: "passthrough" }],
        }),
      );
      toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${t.name}`);
    } catch {
      server.instance.tool(
        t.name,
        t.description || t.name,
        { input: z.string().optional() },
        async () => ({
          content: [{ type: "text" as const, text: "passthrough" }],
        }),
      );
      toolNames.push(`${PASSTHROUGH_MCP_PREFIX}${t.name}`);
    }
  }

  logger.debug(`Passthrough MCP: ${toolNames.length} tools registered`);
  return { server, toolNames };
}

export function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith(PASSTHROUGH_MCP_PREFIX)) {
    return toolName.slice(PASSTHROUGH_MCP_PREFIX.length);
  }
  return toolName;
}
