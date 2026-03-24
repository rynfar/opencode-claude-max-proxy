/**
 * Multimodal Content Tests
 *
 * Verifies that image, document, and file content blocks are
 * preserved and passed to the SDK as structured messages.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TestFetchApp as TestApp } from "./helpers";

let capturedQueryParams: Record<string, unknown> | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: Record<string, unknown>) => {
    capturedQueryParams = params;
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I see the image" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sess-1",
      };
    })();
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}));

mock.module("@/logger", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
    start: () => {},
    success: () => {},
  },
}));

mock.module("@/providers/claude/mcp-tools", () => ({
  createOpencodeMcpServer: () => ({
    type: "sdk",
    name: "opencode",
    instance: {},
  }),
}));

const { createProxyServer } = await import("../src/proxy");
const { clearSessionCache } = await import("../src/proxy/session");

function createTestApp() {
  const { app } = createProxyServer();
  return app;
}

async function post(app: TestApp, body: Record<string, unknown>) {
  return app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("Multimodal content", () => {
  beforeEach(() => {
    capturedQueryParams = null;
    clearSessionCache();
  });

  it("should use text prompt for text-only messages", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
    ).json();

    expect(typeof capturedQueryParams?.prompt).toBe("string");
  });

  it("should use structured prompt for image content", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "iVBOR...",
                },
              },
            ],
          },
        ],
      })
    ).json();

    // Should be an AsyncIterable, not a string
    expect(typeof capturedQueryParams?.prompt).not.toBe("string");
    expect(
      (capturedQueryParams?.prompt as AsyncIterable<unknown>)[
        Symbol.asyncIterator
      ],
    ).toBeDefined();
  });

  it("should use structured prompt for document content", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "summarize this" },
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBER...",
                },
              },
            ],
          },
        ],
      })
    ).json();

    expect(typeof capturedQueryParams?.prompt).not.toBe("string");
  });

  it("should use structured prompt for file content", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "review this" },
              { type: "file", source: { type: "base64", data: "..." } },
            ],
          },
        ],
      })
    ).json();

    expect(typeof capturedQueryParams?.prompt).not.toBe("string");
  });

  it("should include all message roles in structured messages", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look at this" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
          { role: "assistant", content: [{ type: "text", text: "I see it" }] },
          { role: "user", content: "what color is it?" },
        ],
      })
    ).json();

    // Collect all messages from the async iterable
    const messages: Record<string, unknown>[] = [];
    for await (const msg of capturedQueryParams?.prompt as AsyncIterable<
      Record<string, unknown>
    >) {
      messages.push(msg);
    }

    // Should have all 3 messages (system context now in SDK option, not in prompt)
    expect(messages.length).toBeGreaterThanOrEqual(3);
    // All should have the user type wrapper (SDK requirement)
    for (const msg of messages) {
      expect(msg.type).toBe("user");
      expect(msg.message).toBeDefined();
    }
  });

  it("should strip cache_control from content blocks", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "hello",
                cache_control: { type: "ephemeral", ttl: "1h" },
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
                cache_control: { type: "ephemeral" },
              },
            ],
          },
        ],
      })
    ).json();

    const messages: Record<string, unknown>[] = [];
    for await (const msg of capturedQueryParams?.prompt as AsyncIterable<
      Record<string, unknown>
    >) {
      messages.push(msg);
    }

    // Find the message with image content
    const imageMsg = messages.find((m) => {
      const message = m.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (!Array.isArray(content)) return false;
      return content.some(
        (b) => (b as Record<string, unknown>).type === "image",
      );
    });
    expect(imageMsg).toBeDefined();
    const imageMessage = imageMsg?.message as Record<string, unknown>;
    const imageContent = imageMessage.content as Array<Record<string, unknown>>;
    for (const block of imageContent) {
      expect(block.cache_control).toBeUndefined();
    }
  });

  it("should pass system context via systemPrompt option, not in structured messages", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        system: "You are a helpful assistant.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
      })
    ).json();

    // System context should be in SDK option, not injected as a structured message
    expect(
      (capturedQueryParams?.options as Record<string, unknown>).systemPrompt,
    ).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a helpful assistant.",
    });

    const messages: Record<string, unknown>[] = [];
    for await (const msg of capturedQueryParams?.prompt as AsyncIterable<
      Record<string, unknown>
    >) {
      messages.push(msg);
    }

    // No message should contain the system context (it's in the SDK option now)
    const hasSystemMsg = messages.some((m) => {
      const message = m.message as Record<string, unknown> | undefined;
      return (
        typeof message?.content === "string" &&
        message.content.includes("You are a helpful assistant.")
      );
    });
    expect(hasSystemMsg).toBe(false);
  });

  it("should fall back to text prompt with image placeholder when no multimodal", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      })
    ).json();

    expect(typeof capturedQueryParams?.prompt).toBe("string");
    expect(capturedQueryParams?.prompt).toContain("hello");
  });
});
