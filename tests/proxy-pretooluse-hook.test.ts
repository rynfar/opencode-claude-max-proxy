/**
 * PreToolUse Hook Tests
 *
 * The proxy uses the SDK's PreToolUse hook to fix agent names BEFORE
 * the SDK's internal Task handler processes them. This replaces:
 * - canUseTool deny hack (caused "Tool execution aborted")
 * - Stream-level subagent_type normalization (was a bandaid)
 * - Dual execution (SDK + OpenCode both running Task)
 *
 * The hook rewrites the Task tool's subagent_type input using
 * fuzzyMatchAgentName, so the SDK processes the correct agent name.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assistantMessage, type TestFetchApp as TestApp } from "./helpers";

/** Shape returned by the proxy's PreToolUse Task hook (tests pull it from SDK options). */
type PreToolUseHookResult = {
  hookSpecificOutput: {
    updatedInput: { subagent_type: string };
  };
};

let mockMessages: SDKMessage[] = [];
let capturedQueryParams: Record<string, unknown> | null = null;

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: Record<string, unknown>) => {
    capturedQueryParams = params;
    return (async function* () {
      for (const msg of mockMessages) yield msg;
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

const TASK_TOOL = {
  name: "task",
  description: `Launch a new agent.

Available agent types and the tools they have access to:
- build: Default agent
- plan: Plan mode
- general: General-purpose agent
- explore: Contextual grep for codebases
- oracle: Read-only consultation agent
- librarian: Documentation search agent
- sisyphus-junior: Focused task executor`,
  input_schema: {
    type: "object",
    properties: {
      subagent_type: { type: "string" },
      description: { type: "string" },
      prompt: { type: "string" },
    },
    required: ["subagent_type", "description", "prompt"],
  },
};

describe("PreToolUse hook: agent name correction", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])];
    capturedQueryParams = null;
    clearSessionCache();
  });

  it("should include PreToolUse hooks in SDK options", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const options1 = capturedQueryParams?.options as Record<string, unknown>;
    expect(options1.hooks).toBeDefined();
    const hooks1 = options1.hooks as Record<string, unknown>;
    expect(hooks1.PreToolUse).toBeDefined();
    expect((hooks1.PreToolUse as unknown[]).length).toBeGreaterThan(0);
  });

  it("should include a Task matcher in PreToolUse hooks", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const options2 = capturedQueryParams?.options as Record<string, unknown>;
    const hooks2 = options2.hooks as Record<string, unknown>;
    const preToolUse = hooks2.PreToolUse as Array<Record<string, unknown>>;
    const taskMatcher = preToolUse.find((h) => h.matcher === "Task");
    expect(taskMatcher).toBeDefined();
    expect((taskMatcher?.hooks as unknown[]).length).toBeGreaterThan(0);
  });

  it("hook should rewrite capitalized agent names", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const options3 = capturedQueryParams?.options as Record<string, unknown>;
    const hooks3 = options3.hooks as Record<string, unknown>;
    const taskMatcher = (
      hooks3.PreToolUse as Array<Record<string, unknown>>
    ).find((h) => h.matcher === "Task");
    const hookFn = (taskMatcher?.hooks as unknown[])[0] as (
      input: Record<string, unknown>,
      _ctx: unknown,
      opts: { signal: AbortSignal },
    ) => Promise<PreToolUseHookResult>;

    // Simulate SDK calling the hook with capitalized agent
    const result = await hookFn(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "Explore",
          description: "test",
          prompt: "test",
        },
        tool_use_id: "toolu_test",
      },
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result.hookSpecificOutput.updatedInput.subagent_type).toBe(
      "explore",
    );
  });

  it("hook should fuzzy match invalid agent names", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const optsFuzzy = capturedQueryParams?.options as Record<string, unknown>;
    const hooksFuzzy = optsFuzzy.hooks as Record<string, unknown>;
    const taskMatcher = (
      hooksFuzzy.PreToolUse as Array<Record<string, unknown>>
    ).find((h) => h.matcher === "Task");
    const hookFn = (taskMatcher?.hooks as unknown[])[0] as (
      input: Record<string, unknown>,
      _ctx: unknown,
      opts: { signal: AbortSignal },
    ) => Promise<PreToolUseHookResult>;

    // general-purpose → general
    const result1 = await hookFn(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "general-purpose",
          description: "test",
          prompt: "test",
        },
        tool_use_id: "toolu_test1",
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result1.hookSpecificOutput.updatedInput.subagent_type).toBe(
      "general",
    );

    // code-reviewer → oracle
    const result2 = await hookFn(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "code-reviewer",
          description: "test",
          prompt: "test",
        },
        tool_use_id: "toolu_test2",
      },
      undefined,
      { signal: new AbortController().signal },
    );
    expect(result2.hookSpecificOutput.updatedInput.subagent_type).toBe(
      "oracle",
    );
  });

  it("hook should not modify already-valid agent names", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const optsValid = capturedQueryParams?.options as Record<string, unknown>;
    const hooksValid = optsValid.hooks as Record<string, unknown>;
    const taskMatcher = (
      hooksValid.PreToolUse as Array<Record<string, unknown>>
    ).find((h) => h.matcher === "Task");
    const hookFn = (taskMatcher?.hooks as unknown[])[0] as (
      input: Record<string, unknown>,
      _ctx: unknown,
      opts: { signal: AbortSignal },
    ) => Promise<PreToolUseHookResult>;

    const result = await hookFn(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "oracle",
          description: "test",
          prompt: "test",
        },
        tool_use_id: "toolu_test3",
      },
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result.hookSpecificOutput.updatedInput.subagent_type).toBe("oracle");
  });
});

describe("SDK agents option", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])];
    capturedQueryParams = null;
    clearSessionCache();
  });

  it("should pass agents extracted from Task tool to SDK", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const optsAgents = capturedQueryParams?.options as Record<string, unknown>;
    expect(optsAgents.agents).toBeDefined();
    const agentNames = Object.keys(
      optsAgents.agents as Record<string, unknown>,
    );
    expect(agentNames).toContain("oracle");
    expect(agentNames).toContain("explore");
    expect(agentNames).toContain("build");
    expect(agentNames).toContain("plan");
    expect(agentNames).toContain("librarian");
    expect(agentNames).toContain("sisyphus-junior");
  });

  it("each SDK agent should have description and prompt from Task tool", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    const optsOracle = capturedQueryParams?.options as Record<string, unknown>;
    const oracle = (
      optsOracle.agents as Record<string, Record<string, unknown>>
    ).oracle;
    expect(oracle).toBeDefined();
    if (!oracle) {
      throw new Error("expected oracle agent from Task tool");
    }
    expect(oracle.description).toContain("Read-only consultation");
    expect(oracle.prompt).toContain("oracle");
    expect(oracle.model).toBe("inherit");
  });

  it("should not pass agents when no Task tool in request", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
    ).json();

    const optsNoAgents = capturedQueryParams?.options as Record<
      string,
      unknown
    >;
    expect(optsNoAgents.agents).toBeUndefined();
  });

  it("should pass plugins: [] to prevent external interference", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      })
    ).json();

    const optsPlugins = capturedQueryParams?.options as Record<string, unknown>;
    expect(optsPlugins.plugins).toEqual([]);
  });
});

describe("PreToolUse hook: cleanup of old hacks", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])];
    capturedQueryParams = null;
    clearSessionCache();
  });

  it("should NOT include canUseTool deny for Task", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        tools: [TASK_TOOL],
      })
    ).json();

    // canUseTool should either not exist or not deny Task
    const optsCanUse = capturedQueryParams?.options as Record<string, unknown>;
    const canUseTool = optsCanUse.canUseTool as
      | ((
          name: string,
          input: Record<string, unknown>,
          ctx: { signal: AbortSignal },
        ) => Promise<{ behavior: string }>)
      | undefined;
    if (canUseTool) {
      const result = await canUseTool(
        "Task",
        {},
        {
          signal: new AbortController().signal,
        },
      );
      expect(result.behavior).not.toBe("deny");
    }
  });

  it("should work without Task tool in request (no hooks needed)", async () => {
    const app = createTestApp();
    await (
      await post(app, {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
        // No tools at all
      })
    ).json();

    // Should still work, hooks may or may not be present
    expect(capturedQueryParams).toBeDefined();
  });
});
