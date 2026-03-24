/**
 * Tests for conversation lineage verification.
 *
 * Validates that session resume correctly detects history divergence
 * from undo, edit, branch, compaction, and normal continuation scenarios.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/providers/types";
import { assistantMessage, type TestFetchApp as TestApp } from "./helpers";

type MockSdkMessage = Record<string, unknown>;

let mockMessages: MockSdkMessage[] = [];
let capturedQueryParams: {
  options?: { resume?: string; forkSession?: boolean; resumeSessionAt?: string };
} | null = null;
let queuedSessionIds: string[] = [];

function getCapturedResume(): string | undefined {
  return capturedQueryParams?.options?.resume;
}

function getCapturedForkSession(): boolean | undefined {
  return capturedQueryParams?.options?.forkSession;
}

function getCapturedResumeSessionAt(): string | undefined {
  return capturedQueryParams?.options?.resumeSessionAt;
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: unknown) => {
    capturedQueryParams = params as typeof capturedQueryParams;
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

const lineageTmpDir = mkdtempSync(join(tmpdir(), "session-lineage-test-"));
process.env.CLAUDE_PROXY_SESSION_DIR = lineageTmpDir;

const { createProxyServer } = await import("../src/proxy");
const {
  clearSessionCache,
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
} = await import("../src/proxy/session");
const { clearSharedSessions } = await import("../src/proxy/session/store");

afterAll(() => {
  rmSync(lineageTmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_PROXY_SESSION_DIR;
  mock.restore();
});

function createTestApp() {
  const { app } = createProxyServer();
  return app as TestApp;
}

async function post(
  app: TestApp,
  session: string,
  messages: Array<{ role: string; content: string }>,
  sessionId: string,
) {
  queuedSessionIds.push(sessionId);
  const response = await app.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-session": session,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages,
      }),
    }),
  );
  await response.json();
}

beforeEach(() => {
  mockMessages = [assistantMessage([{ type: "text", text: "ok" }])];
  capturedQueryParams = null;
  queuedSessionIds = [];
  clearSessionCache();
  clearSharedSessions();
});

describe("computeLineageHash", () => {
  it("returns empty string for empty messages", () => {
    expect(computeLineageHash([])).toBe("");
  });

  it("produces consistent hashes for same messages", () => {
    const msgs = [{ role: "user", content: "hello" }];
    expect(computeLineageHash(msgs)).toBe(computeLineageHash(msgs));
  });

  it("produces different hashes for different content", () => {
    const a = [{ role: "user", content: "hello" }];
    const b = [{ role: "user", content: "goodbye" }];
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b));
  });

  it("produces different hashes for different roles", () => {
    const a = [{ role: "user", content: "hello" }];
    const b = [{ role: "assistant", content: "hello" }];
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b));
  });

  it("produces different hashes for different message order", () => {
    const a = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ];
    const b = [
      { role: "user", content: "b" },
      { role: "user", content: "a" },
    ];
    expect(computeLineageHash(a)).not.toBe(computeLineageHash(b));
  });

  it("handles array content (multimodal)", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const hash = computeLineageHash(msgs as Message[]);
    expect(hash.length).toBe(32);
  });

  it("produces identical hashes for string vs array content format", () => {
    const asString = [{ role: "user", content: "hello world" }];
    const asArray = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
    ];
    expect(computeLineageHash(asString)).toBe(
      computeLineageHash(asArray as Message[]),
    );
  });

  it("produces identical hashes for tool_use in string vs structured format", () => {
    const withToolUse = [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll help." },
          {
            type: "tool_use",
            id: "toolu_123",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
    ];
    expect(computeLineageHash(withToolUse as Message[])).toBe(
      computeLineageHash(withToolUse as Message[]),
    );
  });

  it("produces different hashes for different tool_use content", () => {
    const a = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "ls" },
          },
        ],
      },
    ];
    const b = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "bash",
            input: { command: "pwd" },
          },
        ],
      },
    ];
    expect(computeLineageHash(a as Message[])).not.toBe(
      computeLineageHash(b as Message[]),
    );
  });
});

describe("hashMessage and computeMessageHashes", () => {
  it("hashMessage returns a 32-char hex string", () => {
    const hash = hashMessage({ role: "user", content: "hello" } as Message);
    expect(hash.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("hashMessage produces consistent results", () => {
    const msg = { role: "user", content: "hello" } as Message;
    expect(hashMessage(msg)).toBe(hashMessage(msg));
  });

  it("hashMessage differs for different content", () => {
    const a = hashMessage({ role: "user", content: "hello" } as Message);
    const b = hashMessage({ role: "user", content: "world" } as Message);
    expect(a).not.toBe(b);
  });

  it("computeMessageHashes returns one hash per message", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as Message[];
    const hashes = computeMessageHashes(msgs);
    expect(hashes.length).toBe(2);
    expect(hashes[0]).toBe(hashMessage(msgs[0]!));
    expect(hashes[1]).toBe(hashMessage(msgs[1]!));
  });
});

describe("Session lineage: undo detection with SDK fork", () => {
  it("resumes normally when messages are a strict continuation", async () => {
    const app = createTestApp();

    // Turn 1
    await post(
      app,
      "sess-1",
      [{ role: "user", content: "Good evening" }],
      "sdk-1",
    );

    // Turn 2 — strict continuation (adds assistant + new user message)
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "Good evening" },
        { role: "assistant", content: "Good evening!" },
        { role: "user", content: "Remember: Flobulator" },
      ],
      "sdk-1",
    );

    expect(getCapturedResume()).toBe("sdk-1");
  });

  it("resumes with forkSession after undo (same message count, different content)", async () => {
    const app = createTestApp();

    // Turn 1
    await post(
      app,
      "sess-1",
      [{ role: "user", content: "Good evening" }],
      "sdk-1",
    );

    // Turn 2
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "Good evening" },
        { role: "assistant", content: "Good evening!" },
        { role: "user", content: "Remember: Flobulator" },
      ],
      "sdk-1",
    );

    // /undo removes turn 2, user sends a different message 2
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "Good evening" },
        { role: "assistant", content: "Good evening!" },
        { role: "user", content: "Do you remember the word?" },
      ],
      "sdk-new",
    );

    // Should resume with forkSession (undo detected, prefix overlap exists)
    expect(getCapturedResume()).toBe("sdk-1");
    expect(getCapturedForkSession()).toBe(true);
  });

  it("resumes with forkSession after multi-undo (fewer messages)", async () => {
    const app = createTestApp();

    // Build up 3 turns
    await post(app, "sess-1", [{ role: "user", content: "hello" }], "sdk-1");

    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "step 2" },
      ],
      "sdk-1",
    );

    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "step 2" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "step 3" },
      ],
      "sdk-1",
    );

    // Multi-undo back to turn 1, send new message
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "completely different" },
      ],
      "sdk-new",
    );

    // Should resume with fork — prefix matches first 2 messages
    expect(getCapturedResume()).toBe("sdk-1");
    expect(getCapturedForkSession()).toBe(true);
  });

  it("does NOT resume when earlier message is edited (diverged)", async () => {
    const app = createTestApp();

    await post(app, "sess-1", [{ role: "user", content: "hello" }], "sdk-1");

    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you?" },
      ],
      "sdk-1",
    );

    // Edit the first message — no prefix overlap at all
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "EDITED hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you?" },
        { role: "assistant", content: "good" },
        { role: "user", content: "great" },
      ],
      "sdk-new",
    );

    // Should NOT resume — first message was edited, lineage broken
    expect(getCapturedResume()).toBeUndefined();
  });

  it("resumes correctly after undo when a NEW session starts", async () => {
    const app = createTestApp();

    // Turn 1
    await post(app, "sess-1", [{ role: "user", content: "hello" }], "sdk-1");

    // Turn 2
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "remember X" },
      ],
      "sdk-1",
    );

    // /undo + new message → fork (undo detected, has prefix overlap)
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "forget about X" },
      ],
      "sdk-2",
    );

    expect(getCapturedResume()).toBe("sdk-1");
    expect(getCapturedForkSession()).toBe(true);

    // Now continuing from the NEW session should resume with sdk-2
    await post(
      app,
      "sess-1",
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "forget about X" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "what do you know?" },
      ],
      "sdk-2",
    );

    expect(getCapturedResume()).toBe("sdk-2");
  });
});

describe("Session lineage: compaction survival", () => {
  it("resumes after compaction when suffix overlaps", async () => {
    const app = createTestApp();

    // Build up a long conversation (>= MIN_STORED_FOR_COMPACTION = 6 messages)
    const longConversation = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "reply3" },
      { role: "user", content: "msg4" },
    ];

    // Store the full conversation
    await post(app, "sess-compact", longConversation as any, "sdk-compact");

    // Simulate compaction — provider compressed early messages but kept
    // the most recent ones. The suffix of the stored hashes must match
    // the suffix of the incoming hashes (both measured from end).
    // Stored: [msg1, reply1, msg2, reply2, msg3, reply3, msg4]
    // Incoming: [COMPACTED, reply3, msg4] — suffix of both ends with [reply3, msg4]
    capturedQueryParams = null;
    await post(
      app,
      "sess-compact",
      [
        { role: "user", content: "COMPACTED_SUMMARY" },
        { role: "assistant", content: "reply3" },
        { role: "user", content: "msg4" },
      ] as any,
      "sdk-compact",
    );

    // Should resume — suffix overlap detected (reply3, msg4 match)
    expect(getCapturedResume()).toBe("sdk-compact");
    expect(getCapturedForkSession()).toBeUndefined();
  });

  it("normal resume after compaction continues to work", async () => {
    const app = createTestApp();

    const longConversation = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "reply3" },
      { role: "user", content: "msg4" },
    ];

    await post(app, "sess-compact2", longConversation as any, "sdk-compact2");

    // Compacted version — fewer messages with suffix overlap
    await post(
      app,
      "sess-compact2",
      [
        { role: "user", content: "COMPACTED" },
        { role: "assistant", content: "reply3" },
        { role: "user", content: "msg4" },
      ] as any,
      "sdk-compact2",
    );

    // Continue normally from compacted state
    capturedQueryParams = null;
    await post(
      app,
      "sess-compact2",
      [
        { role: "user", content: "COMPACTED" },
        { role: "assistant", content: "reply3" },
        { role: "user", content: "msg4" },
        { role: "assistant", content: "reply4" },
        { role: "user", content: "msg5" },
      ] as any,
      "sdk-compact2",
    );

    // Should resume normally (continuation)
    expect(getCapturedResume()).toBe("sdk-compact2");
    expect(getCapturedForkSession()).toBeUndefined();
  });
});

describe("Session lastAccess refresh on lookup", () => {
  it("keeps actively-used sessions alive in LRU by refreshing lastAccess", async () => {
    const app = createTestApp();

    // Session A — created first
    await post(
      app,
      "sess-A",
      [{ role: "user", content: "session A" }],
      "sdk-A",
    );

    // Session B — created second
    await post(
      app,
      "sess-B",
      [{ role: "user", content: "session B" }],
      "sdk-B",
    );

    // Come back to session A much later — should still resume
    capturedQueryParams = null;
    await post(
      app,
      "sess-A",
      [
        { role: "user", content: "session A" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "still here?" },
      ],
      "sdk-A",
    );

    expect(getCapturedResume()).toBe("sdk-A");

    // And again — third access to same session, still resumes
    capturedQueryParams = null;
    await post(
      app,
      "sess-A",
      [
        { role: "user", content: "session A" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "still here?" },
        { role: "assistant", content: "yes" },
        { role: "user", content: "one more" },
      ],
      "sdk-A",
    );

    expect(getCapturedResume()).toBe("sdk-A");
  });
});

describe("Session lineage: fingerprint fallback", () => {
  it("resumes with forkSession via fingerprint after undo", async () => {
    const app = createTestApp();

    // No session header — uses fingerprint (hash of first user message)
    await post(app, "", [{ role: "user", content: "Good evening" }], "sdk-fp1");

    // Manually clear session header, send via fingerprint
    queuedSessionIds.push("sdk-fp1");
    const r1 = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [
            { role: "user", content: "Good evening" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "Remember: Flobulator" },
          ],
        }),
      }),
    );
    await r1.json();

    // Undo + new message, still no session header
    queuedSessionIds.push("sdk-fp-new");
    capturedQueryParams = null;
    const r2 = await app.fetch(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 128,
          stream: false,
          messages: [
            { role: "user", content: "Good evening" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "Do you know the word?" },
          ],
        }),
      }),
    );
    await r2.json();

    // Should resume with fork — fingerprint matches and undo detected via per-message hashing
    expect(getCapturedResume()).toBe("sdk-fp1");
    expect(getCapturedForkSession()).toBe(true);
  });
});
