/**
 * Shared Session Store Tests
 *
 * Tests the file-based session store that enables cross-proxy
 * session resume when running per-terminal proxies.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSharedSessions,
  lookupSharedSession,
  storeSharedSession,
} from "../src/proxy/session/store";

describe("Shared session store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-test-"));
    process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir;
    clearSharedSessions();
  });

  it("should store and retrieve a session", () => {
    storeSharedSession("session-123", "claude-sess-abc");
    const result = lookupSharedSession("session-123");
    expect(result).toBeDefined();
    expect(result?.claudeSessionId).toBe("claude-sess-abc");
  });

  it("should return undefined for unknown session", () => {
    const result = lookupSharedSession("nonexistent");
    expect(result).toBeUndefined();
  });

  it("should update lastUsedAt on store", () => {
    storeSharedSession("session-123", "claude-sess-abc");
    const first = lookupSharedSession("session-123")?.lastUsedAt;

    // Small delay
    const start = Date.now();
    while (Date.now() - start < 10) {} // busy wait 10ms

    storeSharedSession("session-123", "claude-sess-abc");
    const second = lookupSharedSession("session-123")?.lastUsedAt;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) {
      throw new Error("expected lastUsedAt timestamps");
    }
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("should preserve createdAt on update", () => {
    storeSharedSession("session-123", "claude-sess-abc");
    const created = lookupSharedSession("session-123")?.createdAt;

    storeSharedSession("session-123", "claude-sess-def");
    const result = lookupSharedSession("session-123");
    expect(result).toBeDefined();
    expect(result?.createdAt).toBe(created);
    expect(result?.claudeSessionId).toBe("claude-sess-def");
  });

  it("should handle multiple sessions", () => {
    storeSharedSession("sess-1", "claude-1");
    storeSharedSession("sess-2", "claude-2");
    storeSharedSession("sess-3", "claude-3");

    expect(lookupSharedSession("sess-1")?.claudeSessionId).toBe("claude-1");
    expect(lookupSharedSession("sess-2")?.claudeSessionId).toBe("claude-2");
    expect(lookupSharedSession("sess-3")?.claudeSessionId).toBe("claude-3");
  });

  it("should clear all sessions", () => {
    storeSharedSession("sess-1", "claude-1");
    storeSharedSession("sess-2", "claude-2");
    clearSharedSessions();
    expect(lookupSharedSession("sess-1")).toBeUndefined();
    expect(lookupSharedSession("sess-2")).toBeUndefined();
  });

  it("should handle concurrent writes safely", async () => {
    // Simulate two proxies writing at the same time
    const writes = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() =>
        storeSharedSession(`sess-${i}`, `claude-${i}`),
      ),
    );
    await Promise.all(writes);

    // All should be readable
    for (let i = 0; i < 10; i++) {
      const session = lookupSharedSession(`sess-${i}`);
      expect(session).toBeDefined();
      expect(session?.claudeSessionId).toBe(`claude-${i}`);
    }
  });

  it("should handle corrupted file gracefully", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(tmpDir, "sessions.json"), "not json{{{");
    const result = lookupSharedSession("anything");
    expect(result).toBeUndefined();
    // Should still be able to write after corruption
    storeSharedSession("new-sess", "claude-new");
    expect(lookupSharedSession("new-sess")?.claudeSessionId).toBe("claude-new");
  });
});
