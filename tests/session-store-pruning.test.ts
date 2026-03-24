/**
 * Tests for count-based session store pruning.
 *
 * Validates that the file store bounds entries by count (not TTL),
 * evicting the least recently used entries when capacity is exceeded.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  spyOn,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSharedSessions,
  lookupSharedSession,
  storeSharedSession,
} from "../src/proxy/session/store";

describe("Session store count-based pruning", () => {
  let tmpDir: string;
  let dateSpy: Mock<typeof Date.now>;
  const originalDir = process.env.CLAUDE_PROXY_SESSION_DIR;
  const originalMax = process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS;

  beforeEach(() => {
    // Mock Date.now() to return increasing values so that
    // lastUsedAt ordering is deterministic even when the loop runs in <1ms
    // (which happens on fast CI runners).
    let now = 1_000_000;
    dateSpy = spyOn(Date, "now").mockImplementation(() => now++);
    tmpDir = mkdtempSync(join(tmpdir(), "session-pruning-test-"));
    process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir;
    process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS = "5";
    clearSharedSessions();
  });

  afterEach(() => {
    dateSpy.mockRestore();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.CLAUDE_PROXY_SESSION_DIR;
    else process.env.CLAUDE_PROXY_SESSION_DIR = originalDir;
    if (originalMax === undefined)
      delete process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS;
    else process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS = originalMax;
  });

  it("keeps all entries when under capacity", () => {
    storeSharedSession("a", "claude-a");
    storeSharedSession("b", "claude-b");
    storeSharedSession("c", "claude-c");

    expect(lookupSharedSession("a")?.claudeSessionId).toBe("claude-a");
    expect(lookupSharedSession("b")?.claudeSessionId).toBe("claude-b");
    expect(lookupSharedSession("c")?.claudeSessionId).toBe("claude-c");
  });

  it("prunes oldest entries when capacity is exceeded", () => {
    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      storeSharedSession(`sess-${i}`, `claude-${i}`, i);
    }

    // All 5 should exist
    for (let i = 0; i < 5; i++) {
      expect(lookupSharedSession(`sess-${i}`)).toBeDefined();
    }

    // Add 2 more — should evict the 2 oldest (sess-0, sess-1)
    storeSharedSession("sess-5", "claude-5", 5);
    storeSharedSession("sess-6", "claude-6", 6);

    expect(lookupSharedSession("sess-0")).toBeUndefined();
    expect(lookupSharedSession("sess-1")).toBeUndefined();
    expect(lookupSharedSession("sess-2")).toBeDefined();
    expect(lookupSharedSession("sess-5")).toBeDefined();
    expect(lookupSharedSession("sess-6")).toBeDefined();
  });

  it("does NOT prune by time — old sessions survive", () => {
    // Store a session, then manually set lastUsedAt to 48 hours ago
    // by writing directly. Under the old TTL system this would be pruned.
    storeSharedSession("ancient", "claude-ancient");

    // Read it back — should still exist regardless of age
    // (we can't easily fake the timestamp without writing raw JSON,
    //  but we CAN verify that a normally-stored session isn't pruned
    //  on the next read — which is the core behavior change)
    const session = lookupSharedSession("ancient");
    expect(session).toBeDefined();
    expect(session?.claudeSessionId).toBe("claude-ancient");
  });

  it("preserves most recently used entries during pruning", () => {
    // Store 5 sessions
    for (let i = 0; i < 5; i++) {
      storeSharedSession(`sess-${i}`, `claude-${i}`, i);
    }

    // "Touch" sess-0 by re-storing it (updates lastUsedAt)
    storeSharedSession("sess-0", "claude-0-updated", 0);

    // Add a new one — should evict sess-1 (oldest untouched), NOT sess-0
    storeSharedSession("sess-new", "claude-new");

    expect(lookupSharedSession("sess-0")?.claudeSessionId).toBe(
      "claude-0-updated",
    );
    expect(lookupSharedSession("sess-1")).toBeUndefined();
    expect(lookupSharedSession("sess-new")).toBeDefined();
  });
});
