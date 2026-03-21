/**
 * File-based session store for cross-proxy session resume.
 *
 * When running per-terminal proxies (each on a different port),
 * sessions need to be shared so you can resume a conversation
 * started in one terminal from another. This stores session
 * mappings in a JSON file that all proxy instances read/write.
 *
 * Format: { [key]: { claudeSessionId, createdAt, lastUsedAt } }
 * Keys are either OpenCode session IDs or conversation fingerprints.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface StoredSession {
  claudeSessionId: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const STALE_LOCK_THRESHOLD_MS = 30_000

function acquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx")
    closeSync(fd)
    return true
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== "EEXIST") {
      console.error("[sessionStore] lock acquire failed:", err.message)
      return false
    }
    try {
      const stat = statSync(lockPath)
      if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
        unlinkSync(lockPath)
        const fd = openSync(lockPath, "wx")
        closeSync(fd)
        return true
      }
    } catch (staleError) {
      console.error("[sessionStore] stale lock recovery failed:", (staleError as Error).message)
    }
    return false
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch (e) {
    console.error("[sessionStore] lock release failed:", (e as Error).message)
  }
}

function getStorePath(): string {
  const dir = process.env.CLAUDE_PROXY_SESSION_DIR
    || join(homedir(), ".cache", "opencode-claude-max-proxy")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, "sessions.json")
}

function readStore(): Record<string, StoredSession> {
  const path = getStorePath()
  if (!existsSync(path)) return {}
  try {
    const data = readFileSync(path, "utf-8")
    const store = JSON.parse(data) as Record<string, StoredSession>
    // Prune expired entries
    const now = Date.now()
    const pruned: Record<string, StoredSession> = {}
    for (const [key, session] of Object.entries(store)) {
      if (now - session.lastUsedAt < SESSION_TTL_MS) {
        pruned[key] = session
      }
    }
    return pruned
  } catch (e) {
    console.error("[sessionStore] read failed:", (e as Error).message)
    return {}
  }
}

function writeStore(store: Record<string, StoredSession>): void {
  const path = getStorePath()
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2))
    renameSync(tmp, path) // atomic write
  } catch (e) {
    console.error("[sessionStore] write failed:", (e as Error).message)
    // If rename fails, try direct write
    try {
      writeFileSync(path, JSON.stringify(store, null, 2))
    } catch (directWriteError) {
      console.error("[sessionStore] write failed:", (directWriteError as Error).message)
    }
  }
}

export function lookupSharedSession(key: string): StoredSession | undefined {
  const store = readStore()
  const session = store[key]
  if (!session) return undefined
  if (Date.now() - session.lastUsedAt >= SESSION_TTL_MS) return undefined
  return session
}

export function storeSharedSession(key: string, claudeSessionId: string, messageCount?: number): void {
  const path = getStorePath()
  const lockPath = `${path}.lock`
  const hasLock = acquireLock(lockPath)
  if (!hasLock) {
    console.warn("[sessionStore] could not acquire lock, proceeding without")
  }
  try {
    const store = readStore()
    const existing = store[key]
    store[key] = {
      claudeSessionId,
      createdAt: existing?.createdAt || Date.now(),
      lastUsedAt: Date.now(),
      messageCount: messageCount ?? existing?.messageCount ?? 0,
    }
    writeStore(store)
  } finally {
    if (hasLock) {
      releaseLock(lockPath)
    }
  }
}

export function clearSharedSessions(): void {
  const path = getStorePath()
  try {
    writeFileSync(path, "{}")
  } catch (e) {
    console.error("[sessionStore] clear failed:", (e as Error).message)
  }
}
