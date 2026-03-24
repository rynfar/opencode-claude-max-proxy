/**
 * Test helpers for mocking the Claude Agent SDK and creating test fixtures.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** Hono-compatible app for tests (`fetch` may return `Response` or `Promise<Response>`). */
export type TestFetchApp = {
  fetch: (input: Request) => Response | Promise<Response>;
};

// --- SDK Message Factories ---

/** Create a stream_event message (raw Anthropic SSE event) */
export function streamEvent(
  event: Record<string, unknown>,
  overrides?: Partial<SDKMessage>,
): SDKMessage {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
    ...overrides,
  } as SDKMessage;
}

/** Create a message_start event */
export function messageStart(messageId = "msg_test"): SDKMessage {
  return streamEvent({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: "claude-sonnet-4-5-20250929",
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
}

/** Create a content_block_start for a text block */
export function textBlockStart(index = 0): SDKMessage {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

/** Create a content_block_start for a tool_use block */
export function toolUseBlockStart(
  index: number,
  toolName: string,
  toolId: string,
): SDKMessage {
  return streamEvent({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
  });
}

/** Create a text delta event */
export function textDelta(index: number, text: string): SDKMessage {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

/** Create an input_json_delta event (for tool_use) */
export function inputJsonDelta(index: number, partialJson: string): SDKMessage {
  return streamEvent({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

/** Create a content_block_stop event */
export function blockStop(index: number): SDKMessage {
  return streamEvent({
    type: "content_block_stop",
    index,
  });
}

/** Create a message_delta (end of message) */
export function messageDelta(stopReason = "end_turn"): SDKMessage {
  return streamEvent({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 50 },
  });
}

/** Create a message_stop event */
export function messageStop(): SDKMessage {
  return streamEvent({ type: "message_stop" });
}

/** Create an assistant message (non-streaming complete message) */
export function assistantMessage(
  content: Array<Record<string, unknown>>,
): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content,
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 50 },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "test-session",
  } as SDKMessage;
}

// --- Request Factories ---

/** Create a basic Anthropic API request body */
export function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
    ...overrides,
  };
}

/** Create a request with tool definitions */
export function makeToolRequest(
  tools: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
) {
  return makeRequest({
    tools,
    ...overrides,
  });
}

/** Create a request with tool_result in messages */
export function makeToolResultRequest(
  toolUseId: string,
  toolResult: string,
  priorMessages: Array<Record<string, unknown>> = [],
) {
  return makeRequest({
    messages: [
      ...priorMessages,
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolUseId,
            name: "Read",
            input: { file_path: "test.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUseId, content: toolResult },
        ],
      },
    ],
  });
}

// --- SSE Parsing ---

/** Parse SSE response text into events */
export function parseSSE(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const lines = text.split("\n");
  let currentEvent = "";
  let currentData = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7);
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6);
    } else if (line === "" && currentEvent && currentData) {
      try {
        events.push({ event: currentEvent, data: JSON.parse(currentData) });
      } catch {
        // skip non-JSON data
      }
      currentEvent = "";
      currentData = "";
    }
  }

  return events;
}

// --- Anthropic Tool Definitions ---

export const READ_TOOL = {
  name: "Read",
  description: "Read a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" } },
    required: ["file_path"],
  },
};

export const BASH_TOOL = {
  name: "Bash",
  description: "Run a bash command",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
};
