/**
 * File-based session store for cross-proxy session resume.
 *
 * When running per-terminal proxies (each on a different port),
 * sessions need to be shared so you can resume a conversation
 * started in one terminal from another. This stores session
 * mappings in a JSON file that all proxy instances read/write.
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
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@/logger";

export interface StoredSession {
  claudeSessionId: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  lineageHash?: string;
  messageHashes?: string[];
  sdkMessageUuids?: Array<string | null>;
}

const DEFAULT_MAX_STORED_SESSIONS = 10_000;
const STALE_LOCK_THRESHOLD_MS = 30_000;

function getMaxStoredSessions(): number {
  const raw = process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS;
  if (!raw) return DEFAULT_MAX_STORED_SESSIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_MAX_STORED_SESSIONS;
  return parsed;
}

function acquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") {
      logger.error("Failed to acquire session store lock", {
        message: err.message,
      });
      return false;
    }
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, "wx");
        closeSync(fd);
        return true;
      }
    } catch (staleError) {
      logger.error("Could not remove stale session store lock", {
        message: (staleError as Error).message,
      });
    }
    return false;
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (e) {
    logger.error("Failed to release session store lock", {
      message: (e as Error).message,
    });
  }
}

function getStorePath(): string {
  const dir =
    process.env.CLAUDE_PROXY_SESSION_DIR ||
    join(homedir(), ".cache", "opencode-claude-max-proxy");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "sessions.json");
}

function readStore(): Record<string, StoredSession> {
  const storePath = getStorePath();
  if (!existsSync(storePath)) return {};
  try {
    const data = readFileSync(storePath, "utf-8");
    return JSON.parse(data) as Record<string, StoredSession>;
  } catch (e) {
    logger.error("Failed to read session store", {
      message: (e as Error).message,
    });
    return {};
  }
}

function writeStore(store: Record<string, StoredSession>): void {
  const storePath = getStorePath();
  const tmp = `${storePath}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, storePath);
  } catch (e) {
    logger.error("Failed to write session store (atomic replace)", {
      message: (e as Error).message,
    });
    try {
      writeFileSync(storePath, JSON.stringify(store, null, 2));
    } catch (directWriteError) {
      logger.error("Failed to write session store (direct)", {
        message: (directWriteError as Error).message,
      });
    }
  }
}

export function lookupSharedSession(key: string): StoredSession | undefined {
  const store = readStore();
  const found = store[key];
  logger.debug(`Store lookup ${key.slice(0, 12)} → ${found ? "hit" : "miss"}`);
  return found;
}

export function storeSharedSession(
  key: string,
  claudeSessionId: string,
  messageCount?: number,
  lineageHash?: string,
  messageHashes?: string[],
  sdkMessageUuids?: Array<string | null>,
): void {
  const storePath = getStorePath();
  const lockPath = `${storePath}.lock`;
  const hasLock = acquireLock(lockPath);
  if (!hasLock) {
    logger.warn("Session store lock busy; continuing without exclusive write");
  }
  try {
    const store = readStore();
    const existing = store[key];
    store[key] = {
      claudeSessionId,
      createdAt: existing?.createdAt || Date.now(),
      lastUsedAt: Date.now(),
      messageCount: messageCount ?? existing?.messageCount ?? 0,
      lineageHash: lineageHash ?? existing?.lineageHash,
      messageHashes: messageHashes ?? existing?.messageHashes,
      sdkMessageUuids: sdkMessageUuids ?? existing?.sdkMessageUuids,
    };

    const maxEntries = getMaxStoredSessions();
    const keys = Object.keys(store);
    if (keys.length > maxEntries) {
      const sorted = keys.sort(
        (a, b) => (store[a]?.lastUsedAt || 0) - (store[b]?.lastUsedAt || 0),
      );
      const toRemove = sorted.slice(0, keys.length - maxEntries);
      logger.debug(`Store trim: ${toRemove.length} evicted (${keys.length}/${maxEntries})`);
      for (const k of toRemove) {
        delete store[k];
      }
    }

    writeStore(store);
  } finally {
    if (hasLock) {
      releaseLock(lockPath);
    }
  }
}

export function clearSharedSessions(): void {
  const storePath = getStorePath();
  try {
    writeFileSync(storePath, "{}");
  } catch (e) {
    logger.error("Failed to clear session store", {
      message: (e as Error).message,
    });
  }
}
