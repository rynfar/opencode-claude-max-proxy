/**
 * In-memory session cache with LRU eviction and shared file store fallback.
 *
 * Maps OpenCode session IDs (or conversation fingerprints) to Claude SDK
 * session IDs for session resume. Uses lineage verification to detect
 * diverged history (undo, edit, branch).
 */

import { logger } from "@/logger";
import type { Message } from "@/providers/types";
import { LRUMap } from "@/utils/lru-map";
import {
  computeLineageHash,
  computeMessageHashes,
  getConversationFingerprint,
  hashMessage,
  type LineageResult,
  type SessionState,
  verifyLineage,
} from "./lineage";
import {
  clearSharedSessions,
  lookupSharedSession,
  storeSharedSession,
} from "./store";

export type { LineageResult, SessionState } from "./lineage";
export {
  computeLineageHash,
  computeMessageHashes,
  getConversationFingerprint,
  hashMessage,
} from "./lineage";

// ── Cache Configuration ──

const DEFAULT_MAX_SESSIONS = 1000;

export function getMaxSessionsLimit(): number {
  const raw = process.env.CLAUDE_PROXY_MAX_SESSIONS;
  if (!raw) return DEFAULT_MAX_SESSIONS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `Ignoring invalid CLAUDE_PROXY_MAX_SESSIONS="${raw}"; using ${DEFAULT_MAX_SESSIONS}`,
    );
    return DEFAULT_MAX_SESSIONS;
  }
  return parsed;
}

// ── Dual LRU Caches ──
// When one cache evicts, clean the corresponding entry in the other.

let activeMaxSessions = getMaxSessionsLimit();

function removeFingerprintEntriesByClaudeSessionId(
  claudeSessionId: string,
): void {
  for (const [key, state] of fingerprintCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      fingerprintCache.delete(key);
    }
  }
}

function removeSessionEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of sessionCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      sessionCache.delete(key);
    }
  }
}

let sessionCache = new LRUMap<string, SessionState>(
  activeMaxSessions,
  (_key, evicted) =>
    removeFingerprintEntriesByClaudeSessionId(evicted.claudeSessionId),
);

let fingerprintCache = new LRUMap<string, SessionState>(
  activeMaxSessions,
  (_key, evicted) =>
    removeSessionEntriesByClaudeSessionId(evicted.claudeSessionId),
);

// ── Public API ──

function touchSession(state: SessionState): SessionState {
  state.lastAccess = Date.now();
  return state;
}

/**
 * Look up a cached session by header ID or conversation fingerprint.
 * Falls back to the shared file store for cross-proxy resume.
 * Returns a LineageResult describing continuation, compaction, undo, or divergence.
 */
export function lookupSession(
  opencodeSessionId: string | undefined,
  messages: Message[],
  workingDirectory?: string,
): LineageResult | undefined {
  if (opencodeSessionId) {
    const cached = sessionCache.get(opencodeSessionId);
    if (cached) {
      const result = verifyLineage(
        cached,
        messages,
        opencodeSessionId,
        sessionCache,
      );
      logger.debug(`Session hit (id, memory) ${opencodeSessionId.slice(0, 12)} → ${result.type}`);
      if (result.type === "continuation" || result.type === "compaction") {
        touchSession(result.session);
      }
      if (result.type === "diverged") return undefined;
      return result;
    }
    const shared = lookupSharedSession(opencodeSessionId);
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
      };
      const result = verifyLineage(
        state,
        messages,
        opencodeSessionId,
        sessionCache,
      );
      if (result.type !== "diverged") {
        sessionCache.set(opencodeSessionId, state);
      }
      logger.debug(`Session hit (id, disk) ${opencodeSessionId.slice(0, 12)} → ${result.type}`);
      if (result.type === "diverged") return undefined;
      return result;
    }
    logger.debug(`Session miss (id) ${opencodeSessionId.slice(0, 12)}`);
    return undefined;
  }

  const fp = getConversationFingerprint(messages, workingDirectory);
  if (fp) {
    const cached = fingerprintCache.get(fp);
    if (cached) {
      const result = verifyLineage(cached, messages, fp, fingerprintCache);
      logger.debug(`Session hit (fp, memory) ${fp.slice(0, 12)} → ${result.type}`);
      if (result.type === "continuation" || result.type === "compaction") {
        touchSession(result.session);
      }
      if (result.type === "diverged") return undefined;
      return result;
    }
    const shared = lookupSharedSession(fp);
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
      };
      const result = verifyLineage(state, messages, fp, fingerprintCache);
      if (result.type !== "diverged") {
        fingerprintCache.set(fp, state);
      }
      logger.debug(`Session hit (fp, disk) ${fp.slice(0, 12)} → ${result.type}`);
      if (result.type === "diverged") return undefined;
      return result;
    }
  }
  logger.debug("Session miss (no id or fingerprint)");
  return undefined;
}

/**
 * Store a session mapping with lineage hash for divergence detection.
 * Writes to both in-memory cache and shared file store.
 */
export function storeSession(
  opencodeSessionId: string | undefined,
  messages: Message[],
  claudeSessionId: string,
  workingDirectory?: string,
  sdkMessageUuids?: Array<string | null>,
): void {
  if (!claudeSessionId) return;
  const lineageHash = computeLineageHash(messages);
  const messageHashes = computeMessageHashes(messages);
  const state: SessionState = {
    claudeSessionId,
    lastAccess: Date.now(),
    messageCount: messages?.length || 0,
    lineageHash,
    messageHashes,
    sdkMessageUuids,
  };
  if (opencodeSessionId) sessionCache.set(opencodeSessionId, state);
  const fp = getConversationFingerprint(messages, workingDirectory);
  if (fp) fingerprintCache.set(fp, state);
  const key = opencodeSessionId || fp;
  if (key)
    storeSharedSession(
      key,
      claudeSessionId,
      state.messageCount,
      lineageHash,
      messageHashes,
      sdkMessageUuids,
    );
  logger.debug(`Session saved ${claudeSessionId.slice(0, 12)} msgs=${state.messageCount}`);
}

/**
 * Clear all session caches and the shared file store.
 * Re-reads CLAUDE_PROXY_MAX_SESSIONS so tests can override the limit.
 */
export function clearSessionCache(): void {
  const configuredLimit = getMaxSessionsLimit();
  if (configuredLimit !== activeMaxSessions) {
    activeMaxSessions = configuredLimit;
    sessionCache = new LRUMap<string, SessionState>(
      activeMaxSessions,
      (_key, evicted) =>
        removeFingerprintEntriesByClaudeSessionId(evicted.claudeSessionId),
    );
    fingerprintCache = new LRUMap<string, SessionState>(
      activeMaxSessions,
      (_key, evicted) =>
        removeSessionEntriesByClaudeSessionId(evicted.claudeSessionId),
    );
  } else {
    sessionCache.clear();
    fingerprintCache.clear();
  }
  try {
    clearSharedSessions();
  } catch {}
}
