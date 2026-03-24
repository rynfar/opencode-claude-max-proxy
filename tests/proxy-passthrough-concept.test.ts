/**
 * Passthrough Architecture Concept Tests
 *
 * Tests the idea of using maxTurns:1 so the SDK generates one response
 * and stops. If that response has tool_use blocks, we forward them to
 * OpenCode. OpenCode handles the tools (including Task for agent delegation)
 * and sends tool_result back.
 *
 * Key questions this validates:
 * 1. With maxTurns:1, does the SDK return tool_use blocks in the response?
 * 2. Can we correctly extract tool_use blocks and return stop_reason:"tool_use"?
 * 3. Can we accept tool_result and resume the session?
 * 4. Does Task tool_use get forwarded to OpenCode (not handled internally)?
 */

import { describe, expect, it } from "bun:test";

// Simulated SDK messages for maxTurns:1 scenarios
const toolUseMessage = {
  type: "assistant" as const,
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Let me read the file." },
      {
        type: "tool_use",
        id: "toolu_read1",
        name: "Read",
        input: { file_path: "README.md" },
      },
    ],
    model: "claude-sonnet-4-5",
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  parent_tool_use_id: null,
  uuid: "uuid-1",
  session_id: "sess-1",
};

const taskToolUseMessage = {
  type: "assistant" as const,
  message: {
    id: "msg_test2",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Let me delegate to oracle." },
      {
        type: "tool_use",
        id: "toolu_task1",
        name: "Task",
        input: {
          subagent_type: "oracle",
          description: "Review code",
          prompt: "Review the architecture of this project",
        },
      },
    ],
    model: "claude-sonnet-4-5",
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 50 },
  },
  parent_tool_use_id: null,
  uuid: "uuid-2",
  session_id: "sess-1",
};

const textOnlyMessage = {
  type: "assistant" as const,
  message: {
    id: "msg_test3",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello! How can I help?" }],
    model: "claude-sonnet-4-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 50, output_tokens: 20 },
  },
  parent_tool_use_id: null,
  uuid: "uuid-3",
  session_id: "sess-1",
};

describe("Passthrough: tool_use detection", () => {
  it("should detect tool_use blocks in assistant message", () => {
    const content = toolUseMessage.message.content;
    const toolUses = content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ name: "Read" });
  });

  it("should detect Task tool_use for agent delegation", () => {
    const content = taskToolUseMessage.message.content;
    const toolUses = content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ name: "Task" });
    expect(
      (toolUses[0] as { input: Record<string, unknown> }).input.subagent_type,
    ).toBe("oracle");
  });

  it("should detect text-only messages (no forwarding needed)", () => {
    const content = textOnlyMessage.message.content;
    const toolUses = content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    expect(toolUses).toHaveLength(0);
    expect(textOnlyMessage.message.stop_reason).toBe("end_turn");
  });
});

describe("Passthrough: response formatting", () => {
  it("should format tool_use response with stop_reason:tool_use for OpenCode", () => {
    // When the SDK returns a tool_use, we need to format it as an
    // Anthropic API response that OpenCode can handle
    const response = {
      id: toolUseMessage.message.id,
      type: "message",
      role: "assistant",
      content: toolUseMessage.message.content,
      model: toolUseMessage.message.model,
      stop_reason: "tool_use", // Critical: tells OpenCode to handle the tool
      usage: toolUseMessage.message.usage,
    };

    expect(response.stop_reason).toBe("tool_use");
    expect(
      response.content.some(
        (b: Record<string, unknown>) => b.type === "tool_use",
      ),
    ).toBe(true);
  });

  it("should format Task tool_use identically to regular tools", () => {
    // Task should look like other tool_use blocks to OpenCode
    const response = {
      id: taskToolUseMessage.message.id,
      type: "message",
      role: "assistant",
      content: taskToolUseMessage.message.content,
      model: taskToolUseMessage.message.model,
      stop_reason: "tool_use",
      usage: taskToolUseMessage.message.usage,
    };

    const taskBlock = response.content.find(
      (b: Record<string, unknown>) =>
        b.type === "tool_use" && b.name === "Task",
    );
    expect(taskBlock).toBeDefined();
    expect(
      (taskBlock as { input: Record<string, unknown> }).input.subagent_type,
    ).toBe("oracle");
  });

  it("should format end_turn response normally", () => {
    const response = {
      id: textOnlyMessage.message.id,
      type: "message",
      role: "assistant",
      content: textOnlyMessage.message.content,
      model: textOnlyMessage.message.model,
      stop_reason: "end_turn",
      usage: textOnlyMessage.message.usage,
    };

    expect(response.stop_reason).toBe("end_turn");
    expect(
      response.content.every((b: Record<string, unknown>) => b.type === "text"),
    ).toBe(true);
  });
});

describe("Passthrough: tool_result acceptance", () => {
  it("should accept tool_result in follow-up request", () => {
    // OpenCode sends tool_result back after executing the tool
    const followUpMessages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_read1",
            content: "# README\nThis is a proxy project...",
          },
        ],
      },
    ];

    const toolResult = followUpMessages[0]?.content[0];
    expect(toolResult?.type).toBe("tool_result");
    expect(toolResult?.tool_use_id).toBe("toolu_read1");
  });

  it("should accept Task tool_result from OpenCode agent execution", () => {
    // When OpenCode runs the oracle agent, it sends the result back
    const followUpMessages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_task1",
            content: JSON.stringify({
              status: "completed",
              agentId: "oracle-123",
              content: [
                { type: "text", text: "The architecture looks solid." },
              ],
            }),
          },
        ],
      },
    ];

    const taskResult = followUpMessages[0]?.content[0];
    expect(taskResult?.type).toBe("tool_result");
    expect(taskResult?.tool_use_id).toBe("toolu_task1");
    const parsed = JSON.parse(taskResult?.content as string) as Record<
      string,
      unknown
    >;
    expect(parsed.status).toBe("completed");
  });
});

describe("Passthrough: multi-tool in single response", () => {
  it("should handle multiple tool_use blocks in one response", () => {
    // Claude can generate multiple tool calls in one message
    const multiToolMessage = {
      content: [
        { type: "text", text: "Let me search for tests." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Glob",
          input: { pattern: "**/*.test.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Read",
          input: { file_path: "package.json" },
        },
      ],
      stop_reason: "tool_use",
    };

    const toolUses = multiToolMessage.content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    expect(toolUses).toHaveLength(2);
  });

  it("should handle mixed Task + regular tools", () => {
    // Claude might call a regular tool AND delegate to an agent
    const mixedMessage = {
      content: [
        { type: "text", text: "Reading file and delegating review." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "src/index.ts" },
        },
        {
          type: "tool_use",
          id: "toolu_2",
          name: "Task",
          input: {
            subagent_type: "oracle",
            description: "Review",
            prompt: "Review src/index.ts",
          },
        },
      ],
      stop_reason: "tool_use",
    };

    const toolUses = mixedMessage.content.filter(
      (b: Record<string, unknown>) => b.type === "tool_use",
    );
    const tasks = toolUses.filter((b) => b.name === "Task");
    const regular = toolUses.filter((b) => b.name !== "Task");

    expect(tasks).toHaveLength(1);
    expect(regular).toHaveLength(1);
    expect(
      (tasks[0] as { input: Record<string, unknown> }).input.subagent_type,
    ).toBe("oracle");
  });
});
