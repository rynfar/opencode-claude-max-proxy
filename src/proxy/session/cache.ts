/**
 * Session cache management.
 *
 * Manages in-memory LRU caches for session and fingerprint lookups,
 * coordinates with the shared file store for cross-proxy session resume.
 */

import { LRUMap } from "../../utils/lruMap"
import { lookupSharedSession, storeSharedSession, clearSharedSessions, evictSharedSession } from "../sessionStore"
import { getConversationFingerprint } from "./fingerprint"
import {
  computeLineageHash,
  computeMessageHashes,
  verifyLineage,
  type SessionState,
  type LineageResult,
} from "./lineage"

// --- Cache setup ---

const DEFAULT_MAX_SESSIONS = 1000

export function getMaxSessionsLimit(): number {
  const raw = process.env.MERIDIAN_MAX_SESSIONS ?? process.env.CLAUDE_PROXY_MAX_SESSIONS
  if (!raw) return DEFAULT_MAX_SESSIONS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[PROXY] Invalid MERIDIAN_MAX_SESSIONS value "${raw}"; using default ${DEFAULT_MAX_SESSIONS}`)
    return DEFAULT_MAX_SESSIONS
  }

  return parsed
}

function removeFingerprintEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of fingerprintCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      fingerprintCache.delete(key)
    }
  }
}

function removeSessionEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of sessionCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      sessionCache.delete(key)
    }
  }
}

function createSessionCache(maxSize: number) {
  return new LRUMap<string, SessionState>(maxSize, (_key, evictedState) => {
    removeFingerprintEntriesByClaudeSessionId(evictedState.claudeSessionId)
  })
}

function createFingerprintCache(maxSize: number) {
  return new LRUMap<string, SessionState>(maxSize, (_key, evictedState) => {
    removeSessionEntriesByClaudeSessionId(evictedState.claudeSessionId)
  })
}

// Read limit once at module load — no hot-reload in createProxyServer to avoid
// silently dropping all sessions mid-operation. clearSessionCache() re-reads the
// env var so tests can override the limit.
let activeMaxSessions = getMaxSessionsLimit()
let sessionCache = createSessionCache(activeMaxSessions)
let fingerprintCache = createFingerprintCache(activeMaxSessions)

/** Clear all session caches (used in tests).
 *  Re-reads MERIDIAN_MAX_SESSIONS / CLAUDE_PROXY_MAX_SESSIONS so tests can override the limit. */
export function clearSessionCache() {
  const configuredLimit = getMaxSessionsLimit()
  if (configuredLimit !== activeMaxSessions) {
    activeMaxSessions = configuredLimit
    sessionCache = createSessionCache(activeMaxSessions)
    fingerprintCache = createFingerprintCache(activeMaxSessions)
  } else {
    sessionCache.clear()
    fingerprintCache.clear()
  }
  // Also clear shared file store
  try { clearSharedSessions() } catch {}
}

/** Evict a stale session from all caches and the shared store.
 *  Used when a resume/undo fails because the upstream Claude session is gone. */
export function evictSession(
  sessionId: string | undefined,
  workingDirectory?: string,
  messages?: Array<{ role: string; content: any }>
): void {
  if (sessionId) {
    const cached = sessionCache.get(sessionId)
    if (cached) {
      removeFingerprintEntriesByClaudeSessionId(cached.claudeSessionId)
      sessionCache.delete(sessionId)
    }
    try { evictSharedSession(sessionId) } catch {}
  }
  if (messages) {
    const fp = getConversationFingerprint(messages, workingDirectory)
    if (fp) {
      const cached = fingerprintCache.get(fp)
      if (cached) {
        removeSessionEntriesByClaudeSessionId(cached.claudeSessionId)
        fingerprintCache.delete(fp)
      }
      try { evictSharedSession(fp) } catch {}
    }
  }
}

// --- Session operations ---

/** Refresh lastAccess on a verified session so LRU eviction reflects actual usage */
function touchSession(state: SessionState): SessionState {
  state.lastAccess = Date.now()
  return state
}

/** Look up a cached session by header or fingerprint.
 *  Returns a LineageResult that classifies the mutation and includes the
 *  session state needed for the correct SDK action. */
export function lookupSession(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  workingDirectory?: string
): LineageResult {
  const DEBUG = process.env.DEBUG_PROXY === "true"
  const fp = getConversationFingerprint(messages, workingDirectory)

  if (sessionId) {
    const cached = sessionCache.get(sessionId)
    if (cached) {
      const result = verifyLineage(cached, messages, sessionId, sessionCache)
      if (DEBUG) {
        console.error(`[DEBUG cache] HIT → ${result.type} (claudeSessionId=${cached.claudeSessionId?.substring(0, 8)}..., cache=memory)`)
      }
      if (result.type === "continuation" || result.type === "compaction") touchSession(result.session)
      return result
    }
    const shared = lookupSharedSession(sessionId)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
      }
      const result = verifyLineage(state, messages, sessionId, sessionCache)
      if (DEBUG) {
        console.error(`[DEBUG cache] HIT → SHARED FALLBACK (claudeSessionId=${shared.claudeSessionId?.substring(0, 8)}...)`)
      }
      if (result.type === "continuation" || result.type === "compaction") {
        sessionCache.set(sessionId, state)
      }
      return result
    }
    if (DEBUG) {
      console.error(`[DEBUG cache] MISS → NEW (sessionId=${sessionId.substring(0, 8)}..., fp=${fp?.substring(0, 16) ?? "null"}...)`)
    }
    return { type: "diverged" }
  }

  if (fp) {
    const cached = fingerprintCache.get(fp)
    if (cached) {
      const result = verifyLineage(cached, messages, fp, fingerprintCache)
      if (DEBUG) {
        console.error(`[DEBUG cache] HIT → ${result.type} (claudeSessionId=${cached.claudeSessionId?.substring(0, 8)}..., cache=fingerprint)`)
      }
      if (result.type === "continuation" || result.type === "compaction") touchSession(result.session)
      return result
    }
    const shared = lookupSharedSession(fp)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
      }
      const result = verifyLineage(state, messages, fp, fingerprintCache)
      if (DEBUG) {
        console.error(`[DEBUG cache] HIT → SHARED FALLBACK (claudeSessionId=${shared.claudeSessionId?.substring(0, 8)}..., cache=fingerprint)`)
      }
      if (result.type === "continuation" || result.type === "compaction") {
        fingerprintCache.set(fp, state)
      }
      return result
    }
    if (DEBUG) {
      console.error(`[DEBUG cache] MISS → NEW (sessionId=undefined, fp=${fp.substring(0, 16)}...)`)
    }
  } else {
    if (DEBUG) {
      console.error(`[DEBUG cache] MISS → NEW (sessionId=undefined, fp=null)`)
    }
  }
  return { type: "diverged" }
}

/** Store a session mapping with lineage hash and SDK UUIDs for divergence detection.
 *  @param sdkMessageUuids — per-message SDK assistant UUIDs (null for user messages).
 *    If provided, merged with any previously stored UUIDs to build a complete map. */
export function storeSession(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  claudeSessionId: string,
  workingDirectory?: string,
  sdkMessageUuids?: Array<string | null>
) {
  const DEBUG = process.env.DEBUG_PROXY === "true"
  if (!claudeSessionId) return
  const lineageHash = computeLineageHash(messages)
  const messageHashes = computeMessageHashes(messages)
  const state: SessionState = {
    claudeSessionId,
    lastAccess: Date.now(),
    messageCount: messages?.length || 0,
    lineageHash,
    messageHashes,
    sdkMessageUuids,
  }
  const fp = getConversationFingerprint(messages, workingDirectory)
  // In-memory cache
  if (sessionId) {
    sessionCache.set(sessionId, state)
  }
  if (fp) {
    fingerprintCache.set(fp, state)
  }
  if (DEBUG) {
    console.error(`[DEBUG cache] STORE (sessionId=${sessionId?.substring(0, 8) ?? "null"}..., fp=${fp?.substring(0, 16) ?? "null"}..., claudeSessionId=${claudeSessionId.substring(0, 8)}...)`)
  }
  // Shared file store (cross-proxy resume)
  const key = sessionId || fp
  if (key) storeSharedSession(key, claudeSessionId, state.messageCount, lineageHash, messageHashes, sdkMessageUuids)
}
