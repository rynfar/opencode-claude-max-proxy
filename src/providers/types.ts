/**
 * Shared type definitions for the proxy's wire format.
 *
 * These types represent the Anthropic API message format that OpenCode
 * speaks on both request and response. Every provider implementation
 * must understand these regardless of which backend it targets.
 */

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  cache_control?: Record<string, unknown>;
}

export type MessageContent = string | ContentBlock[];

export interface Message {
  role: string;
  content: MessageContent;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  input_schema?: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

export interface RequestBody {
  model: string;
  stream?: boolean;
  system?: string | ContentBlock[];
  messages?: Message[];
  tools?: ToolDefinition[];
  [key: string]: unknown;
}

export interface StreamEvent {
  type: string;
  index?: number;
  content_block?: ContentBlock;
  delta?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StructuredUserMessage {
  type: "user";
  message: { role: string; content: MessageContent };
  parent_tool_use_id: null;
}
