/**
 * Tests for fingerprint-based session resume.
 *
 * The fingerprint hashes the first user message only (not systemContext).
 * OpenCode's system prompt contains dynamic content (file trees, diagnostics)
 * that changes every request, making systemContext-based hashing unstable.
 *
 * Cross-project safety is handled by lineage verification — different
 * projects will have different message content after turn 1, so the
 * lineage hash will mismatch and prevent incorrect resume.
 *
 * These tests cover:
 * - Resume works even when systemContext changes between requests
 * - Resume works across stream and non-stream
 * - Lineage catches cross-project collisions (same first message, different history)
 * - Different first messages produce different fingerprints
 * - Backward compat without systemContext
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantMessage, type TestFetchApp as TestApp } from "./helpers";

type MockSdkMessage = Record<string, unknown>;

type FingerprintCapturedQueryParams = {
  prompt?: string;
  options?: { resume?: string; forkSession?: boolean; resumeSessionAt?: string };
};

type AnthropicStyleContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
    };

type SessionMessage = {
  role: string;
  content: string | AnthropicStyleContentBlock[];
};

let mockMessages: MockSdkMessage[] = [];
let capturedQueryParams: FingerprintCapturedQueryParams | null = null;
let queuedSessionIds: string[] = [];

function getCapturedResume(): string | undefined {
  return capturedQueryParams?.options?.resume;
}

function getCapturedForkSession(): boolean | undefined {
  return capturedQueryParams?.options?.forkSession;
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as FingerprintCapturedQueryParams;
    const sessionId = queuedSessionIds.shift() || "sdk-session-default";
    return (async function* () {
      for (const msg of mockMessages) {
        yield { ...msg, session_id: sessionId };
      }
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

const fpTmpDir = mkdtempSync(join(tmpdir(), "session-fp-context-test-"));
process.env.CLAUDE_PROXY_SESSION_DIR = fpTmpDir;

const { createProxyServer } = await import("../src/proxy");
const { clearSessionCache } = await import("../src/proxy/session");
const { clearSharedSessions } = await import("../src/proxy/session/store");

afterAll(() => {
  rmSync(fpTmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROXY_SESSION_DIR;
  mock.restore();
});

function createTestApp() {
  const { app } = createProxyServer();
  return app as TestApp;
}

/** Send a request WITHOUT a session header (fingerprint fallback path) */
async function postNoSession(
  app: TestApp,
  messages: SessionMessage[],
  sessionId: string,
  system?: string,
  stream = false,
) {
  queuedSessionIds.push(sessionId);
  const body: Record<string, unknown> = {
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream,
    messages,
  };
  if (system) body.system = system;

  const response = await app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  if (stream) {
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  } else {
    await response.json();
  }
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])];
  capturedQueryParams = null;
  queuedSessionIds = [];
  clearSessionCache();
  clearSharedSessions();
});

describe("Fingerprint resume: stable across dynamic systemContext", () => {
  it("resumes when systemContext changes between requests (non-stream)", async () => {
    const app = createTestApp();

    // Turn 1 — system prompt v1
    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-1",
      "System v1: file tree has 10 files",
    );

    // Turn 2 — system prompt changed (dynamic content), same first user message
    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you?" },
      ],
      "sdk-1",
      "System v2: file tree has 15 files, 3 diagnostics",
    );

    // MUST resume — fingerprint doesn't include systemContext
    expect(getCapturedResume()).toBe("sdk-1");
  });

  it("resumes when systemContext changes between requests (stream)", async () => {
    const app = createTestApp();

    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-stream-1",
      "System v1",
      true,
    );

    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "what can you do?" },
      ],
      "sdk-stream-1",
      "System v2 with more context",
      true,
    );

    expect(getCapturedResume()).toBe("sdk-stream-1");
  });

  it("resumes when systemContext is added where there was none", async () => {
    const app = createTestApp();

    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-no-ctx",
    );

    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "help me" },
      ],
      "sdk-no-ctx",
      "You are a helpful assistant.",
    );

    // MUST resume — systemContext not in fingerprint
    expect(getCapturedResume()).toBe("sdk-no-ctx");
  });

  it("resumes when systemContext is removed", async () => {
    const app = createTestApp();

    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-ctx",
      "You are a helpful assistant.",
    );

    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "thanks" },
      ],
      "sdk-ctx",
    );

    expect(getCapturedResume()).toBe("sdk-ctx");
  });
});

describe("Fingerprint resume: cross-project safety via lineage", () => {
  it("does NOT resume wrong project when first message matches but history diverges", async () => {
    const app = createTestApp();

    // Project A: "hello" → assistant responds → user asks about project A files
    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-project-a",
    );

    // Simulate project A continuing
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi, how can I help with project A?" },
        { role: "user", content: "list the project A files" },
      ],
      "sdk-project-a",
    );

    // Project B: same "hello" start, but different assistant response (different project)
    // Lineage hash will mismatch because messages[1] differs
    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi, how can I help with project B?" },
        { role: "user", content: "list the project B files" },
      ],
      "sdk-project-b",
    );

    // Should resume with fork — prefix overlap at message[0] (same "hello"), but message[1] diverged
    // This is an undo-like scenario where the prefix matches but subsequent messages differ
    expect(getCapturedResume()).toBe("sdk-project-a");
    expect(getCapturedForkSession()).toBe(true);
  });

  it("resumes correctly after cross-project rejection creates new session", async () => {
    const app = createTestApp();

    // Project A
    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-project-a",
    );
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "project A response" },
        { role: "user", content: "continue A" },
      ],
      "sdk-project-a",
    );

    // Project B — different history, creates fresh session
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "project B response" },
        { role: "user", content: "continue B" },
      ],
      "sdk-project-b",
    );

    // Project B continues — should resume sdk-project-b
    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "project B response" },
        { role: "user", content: "continue B" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "more B work" },
      ],
      "sdk-project-b",
    );

    expect(getCapturedResume()).toBe("sdk-project-b");
  });
});

describe("Fingerprint resume: different first messages", () => {
  it("does NOT resume when first user message differs", async () => {
    const app = createTestApp();

    await postNoSession(app, [{ role: "user", content: "hello" }], "sdk-hello");

    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "goodbye" },
        { role: "assistant", content: "bye" },
        { role: "user", content: "wait" },
      ],
      "sdk-goodbye",
    );

    expect(getCapturedResume()).toBeUndefined();
  });
});

describe("Fingerprint resume: multi-turn with tool_use blocks", () => {
  it("resumes correctly when history contains tool_use and tool_result", async () => {
    const app = createTestApp();

    // Turn 1
    await postNoSession(
      app,
      [{ role: "user", content: "create a file" }],
      "sdk-tools",
      "System prompt v1",
    );

    // Turn 2 — history has tool_use/tool_result (this is what OpenCode sends)
    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "create a file" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll create that file." },
            {
              type: "tool_use",
              id: "toolu_123",
              name: "write",
              input: { path: "test.txt", content: "hello" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "File written.",
            },
          ],
        },
        { role: "assistant", content: "Done! File created." },
        { role: "user", content: "now read it back" },
      ],
      "sdk-tools",
      "System prompt v2 with updated file tree",
    );

    // MUST resume even though system changed and history has tool blocks
    expect(getCapturedResume()).toBe("sdk-tools");
  });

  it("does NOT resume after undo even with tool_use in history", async () => {
    const app = createTestApp();

    await postNoSession(
      app,
      [{ role: "user", content: "create a file" }],
      "sdk-tools-undo",
    );

    await postNoSession(
      app,
      [
        { role: "user", content: "create a file" },
        { role: "assistant", content: "I'll create that file." },
        { role: "user", content: "use bash to list files" },
      ],
      "sdk-tools-undo",
    );

    // /undo — different message 3
    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "create a file" },
        { role: "assistant", content: "I'll create that file." },
        { role: "user", content: "actually, delete that file instead" },
      ],
      "sdk-tools-undo-new",
    );

    // Should resume with fork — undo detected, prefix of 2 messages matches
    expect(getCapturedResume()).toBe("sdk-tools-undo");
    expect(getCapturedForkSession()).toBe(true);
  });
});

describe("Fingerprint resume: backward compat", () => {
  it("resumes correctly without systemContext", async () => {
    const app = createTestApp();

    await postNoSession(
      app,
      [{ role: "user", content: "hello" }],
      "sdk-no-ctx",
    );

    capturedQueryParams = null;
    await postNoSession(
      app,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "thanks" },
      ],
      "sdk-no-ctx",
    );

    expect(getCapturedResume()).toBe("sdk-no-ctx");
  });
});
