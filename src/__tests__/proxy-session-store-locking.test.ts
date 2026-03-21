import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSharedSessions, lookupSharedSession, storeSharedSession } from "../proxy/sessionStore"

describe("Shared session store locking", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-store-locking-test-"))
    process.env.CLAUDE_PROXY_SESSION_DIR = tmpDir
    clearSharedSessions()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.CLAUDE_PROXY_SESSION_DIR
  })

  it("preserves all entries during concurrent writes", async () => {
    const writes = Array.from({ length: 25 }, (_, i) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          storeSharedSession(`sess-${i}`, `claude-${i}`, i)
          resolve()
        }, Math.floor(Math.random() * 6))
      })
    )

    await Promise.all(writes)

    for (let i = 0; i < 25; i++) {
      const stored = lookupSharedSession(`sess-${i}`)
      expect(stored).toBeDefined()
      if (!stored) {
        throw new Error(`expected sess-${i} to be stored`)
      }
      expect(stored.claudeSessionId).toBe(`claude-${i}`)
      expect(stored.messageCount).toBe(i)
    }
  })

  it("recovers from stale lock files", () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    const lockPath = `${sessionsPath}.lock`

    writeFileSync(lockPath, "")
    const staleTime = (Date.now() - 31_000) / 1000
    utimesSync(lockPath, staleTime, staleTime)

    storeSharedSession("stale-lock-session", "claude-stale")

    expect(lookupSharedSession("stale-lock-session")?.claudeSessionId).toBe("claude-stale")
    expect(existsSync(lockPath)).toBe(false)
  })

  it("logs errors instead of silently swallowing failures", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})

    writeFileSync(join(tmpDir, "sessions.json"), "{invalid-json")
    expect(lookupSharedSession("broken")).toBeUndefined()

    const badDirPath = join(tmpDir, "not-a-dir")
    writeFileSync(badDirPath, "file")
    process.env.CLAUDE_PROXY_SESSION_DIR = badDirPath
    storeSharedSession("write-failure", "claude-write")
    clearSharedSessions()

    const messages = errorSpy.mock.calls.map((call) => call[0])
    expect(messages).toContain("[sessionStore] read failed:")
    expect(messages).toContain("[sessionStore] write failed:")
    expect(messages).toContain("[sessionStore] clear failed:")

    errorSpy.mockRestore()
  })

  it("warns and degrades gracefully when lock cannot be acquired", () => {
    const sessionsPath = join(tmpDir, "sessions.json")
    const lockPath = `${sessionsPath}.lock`
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})

    writeFileSync(lockPath, "")
    storeSharedSession("lock-contention", "claude-fallback")

    expect(lookupSharedSession("lock-contention")?.claudeSessionId).toBe("claude-fallback")
    expect(warnSpy).toHaveBeenCalledWith("[sessionStore] could not acquire lock, proceeding without")

    warnSpy.mockRestore()
  })
})
