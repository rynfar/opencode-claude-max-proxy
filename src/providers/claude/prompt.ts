/**
 * Prompt building from Anthropic API messages.
 *
 * Converts incoming messages to either a structured multimodal
 * async iterable or a plain text string, depending on content types.
 * Handles resume (delta-only) vs first-request (full) modes.
 */

import { stripCacheControl } from "@/providers/messages";
import type { ContentBlock, Message, StructuredUserMessage } from "./types";

export { getLastUserMessage, prepareMessages } from "@/providers/messages";

// ── Prompt Building ──

const MULTIMODAL_TYPES = new Set(["image", "document", "file"]);

function hasMultimodalContent(messages: Message[]): boolean {
  return messages?.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((b) => MULTIMODAL_TYPES.has(b.type)),
  );
}

function buildMultimodalPrompt(
  messages: Message[],
  isResume: boolean,
): AsyncIterable<StructuredUserMessage> {
  const structured: StructuredUserMessage[] = [];

  if (isResume) {
    for (const m of messages) {
      if (m.role === "user") {
        structured.push({
          type: "user" as const,
          message: {
            role: "user" as const,
            content: stripCacheControl(m.content),
          },
          parent_tool_use_id: null,
        });
      }
    }
  } else {
    for (const m of messages) {
      if (m.role === "user") {
        structured.push({
          type: "user" as const,
          message: {
            role: "user" as const,
            content: stripCacheControl(m.content),
          },
          parent_tool_use_id: null,
        });
      } else {
        let text: string;
        if (typeof m.content === "string") {
          text = `[Assistant: ${m.content}]`;
        } else if (Array.isArray(m.content)) {
          text = m.content
            .map((b: ContentBlock) => {
              if (b.type === "text" && b.text) return `[Assistant: ${b.text}]`;
              if (b.type === "tool_use")
                return `[Tool Use: ${b.name}(${JSON.stringify(b.input)})]`;
              if (b.type === "tool_result")
                return `[Tool Result: ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}]`;
              return "";
            })
            .filter(Boolean)
            .join("\n");
        } else {
          text = `[Assistant: ${String(m.content)}]`;
        }
        structured.push({
          type: "user" as const,
          message: { role: "user" as const, content: text },
          parent_tool_use_id: null,
        });
      }
    }
  }

  return (async function* () {
    for (const msg of structured) yield msg;
  })();
}

function buildTextPrompt(messages: Message[]): string {
  return (
    messages
      ?.map((m) => {
        const role = m.role === "assistant" ? "Assistant" : "Human";
        let content: string;
        if (typeof m.content === "string") {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          content = m.content
            .map((block: ContentBlock) => {
              if (block.type === "text" && block.text) return block.text;
              if (block.type === "tool_use")
                return `[Tool Use: ${block.name}(${JSON.stringify(block.input)})]`;
              if (block.type === "tool_result")
                return `[Tool Result for ${block.tool_use_id}: ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}]`;
              if (block.type === "image") return "[Image attached]";
              if (block.type === "document") return "[Document attached]";
              if (block.type === "file") return "[File attached]";
              return "";
            })
            .filter(Boolean)
            .join("\n");
        } else {
          content = String(m.content);
        }
        return `${role}: ${content}`;
      })
      .join("\n\n") || ""
  );
}

/**
 * Build the prompt for the SDK query — either structured (multimodal)
 * or plain text, based on the content types in the messages.
 */
export function buildPrompt(
  messagesToConvert: Message[],
  isResume: boolean,
): string | AsyncIterable<StructuredUserMessage> {
  if (hasMultimodalContent(messagesToConvert)) {
    return buildMultimodalPrompt(messagesToConvert, isResume);
  }
  return buildTextPrompt(messagesToConvert);
}
