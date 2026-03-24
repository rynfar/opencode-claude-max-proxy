import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSharedSessions,
  lookupSharedSession,
  storeSharedSession,
} from "../src/proxy/session/store";

describe("Shared session store locking", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-locking-test-"));
    process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir;
    clearSharedSessions();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.CLAUDE_PROXY_SESSION_DIR;
  });

  it("preserves all entries during concurrent writes", async () => {
    const writes = Array.from(
      { length: 25 },
      (_, i) =>
        new Promise<void>((resolve) => {
          setTimeout(
            () => {
              storeSharedSession(`sess-${i}`, `claude-${i}`, i);
              resolve();
            },
            Math.floor(Math.random() * 6),
          );
        }),
    );

    await Promise.all(writes);

    for (let i = 0; i < 25; i++) {
      const stored = lookupSharedSession(`sess-${i}`);
      expect(stored).toBeDefined();
      if (!stored) {
        throw new Error(`expected sess-${i} to be stored`);
      }
      expect(stored.claudeSessionId).toBe(`claude-${i}`);
      expect(stored.messageCount).toBe(i);
    }
  });

  it("recovers from stale lock files", () => {
    const sessionsPath = join(tmpDir, "sessions.json");
    const lockPath = `${sessionsPath}.lock`;

    writeFileSync(lockPath, "");
    const staleTime = (Date.now() - 31_000) / 1000;
    utimesSync(lockPath, staleTime, staleTime);

    storeSharedSession("stale-lock-session", "claude-stale");

    expect(lookupSharedSession("stale-lock-session")?.claudeSessionId).toBe(
      "claude-stale",
    );
    expect(existsSync(lockPath)).toBe(false);
  });

  it("handles corrupted and bad paths gracefully", () => {
    writeFileSync(join(tmpDir, "sessions.json"), "not json{{{");
    expect(lookupSharedSession("broken")).toBeUndefined();

    const badDirPath = join(tmpDir, "not-a-dir");
    writeFileSync(badDirPath, "file");
    process.env.CLAUDE_PROXY_SESSION_DIR = badDirPath;
    storeSharedSession("write-failure", "claude-write");
    clearSharedSessions();
    process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir;
  });

  it("degrades gracefully when lock cannot be acquired", () => {
    const sessionsPath = join(tmpDir, "sessions.json");
    const lockPath = `${sessionsPath}.lock`;

    writeFileSync(lockPath, "");
    storeSharedSession("lock-contention", "claude-fallback");

    expect(lookupSharedSession("lock-contention")?.claudeSessionId).toBe(
      "claude-fallback",
    );
  });
});
