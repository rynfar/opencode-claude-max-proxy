/**
 * Session lineage verification.
 *
 * Pure functions for hashing messages and classifying mutations
 * (continuation, compaction, undo, diverged).
 */

import { createHash } from "crypto"
import { normalizeContent } from "../messages"
import { diagnosticLog } from "../../telemetry"

// --- Types ---

/** Minimum suffix overlap (stored messages found at the end of incoming)
 *  required to classify a mutation as compaction rather than a branch. */
export const MIN_SUFFIX_FOR_COMPACTION = 2

export interface TokenBudget {
  inputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  usedTokens: number
  maxTokens: number
  totalProcessedTokens: number
  toolUses: number
  durationMs: number
}

export function defaultTokenBudget(): TokenBudget {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    usedTokens: 0,
    maxTokens: 0,
    totalProcessedTokens: 0,
    toolUses: 0,
    durationMs: 0,
  }
}

export interface SessionState {
  claudeSessionId: string
  lastAccess: number
  messageCount: number
  /** Hash of messages[0..messageCount-1] for fast-path lineage verification.
   *  When the full prefix matches, the conversation is a strict continuation
   *  and we skip the per-message diff entirely. */
  lineageHash: string
  /** Per-message content hashes from the last stored request.
   *  Used for precise diff-based mutation classification when the aggregate
   *  lineageHash mismatches. */
  messageHashes?: string[]
  /** SDK assistant message UUIDs indexed by message position.
   *  Only assistant messages have UUIDs (user messages are null).
   *  Used to find the rollback point for undo. */
  sdkMessageUuids?: Array<string | null>
  /** Token usage tracking for proactive rate limit prevention. */
  tokenBudget?: TokenBudget
}

/**
 * Result of lineage verification — classifies the mutation and provides
 * the information needed to take the correct SDK action.
 */
export type LineageResult =
  | { type: "continuation"; session: SessionState }
  | { type: "compaction";   session: SessionState }
  | { type: "undo";         session: SessionState; prefixOverlap: number; rollbackUuid: string | undefined }
  | { type: "diverged" }

// --- Hashing ---

/**
 * Compute a lineage hash of an ordered message array.
 * Used as a fast-path check: if the aggregate hash matches, the messages
 * are an exact prefix-extension and we skip the per-message diff.
 */
export function computeLineageHash(messages: Array<{ role: string; content: any }>): string {
  if (!messages || messages.length === 0) return ""
  const parts = messages.map(m => `${m.role}:${normalizeContent(m.content)}`)
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)
}

/**
 * Compute a content hash for a single message (role + normalised content).
 * Used to build per-message hash arrays for precise diff-based verification.
 */
export function hashMessage(message: { role: string; content: any }): string {
  return createHash("sha256")
    .update(`${message.role}:${normalizeContent(message.content)}`)
    .digest("hex")
    .slice(0, 32)
}

/**
 * Compute per-message hashes for an entire message array.
 */
export function computeMessageHashes(messages: Array<{ role: string; content: any }>): string[] {
  if (!messages || messages.length === 0) return []
  return messages.map(hashMessage)
}

// --- Overlap measurement ---

/**
 * Measure how many stored hashes match from the START of the stored array
 * against the incoming hashes (order-preserving).
 *
 * Prefix overlap means the beginning of the conversation is intact (undo
 * changes the end but preserves the beginning).
 */
export function measurePrefixOverlap(storedHashes: string[], incomingSet: Set<string>): number {
  let overlap = 0
  for (const h of storedHashes) {
    if (incomingSet.has(h)) overlap++
    else break
  }
  return overlap
}

/**
 * Measure how many stored hashes match from the END of the stored array
 * against the incoming hashes (order-preserving).
 *
 * Suffix overlap means the recent conversation is intact (compaction
 * changes the beginning but preserves the end).
 */
export function measureSuffixOverlap(storedHashes: string[], incomingSet: Set<string>): number {
  let overlap = 0
  for (let i = storedHashes.length - 1; i >= 0; i--) {
    if (incomingSet.has(storedHashes[i]!)) overlap++
    else break
  }
  return overlap
}

// --- Lineage verification ---

/** Cache-like interface for verifyLineage — only needs get/set/delete */
export interface SessionCacheLike {
  delete(key: string): boolean
}

/**
 * Verify that incoming messages are a valid continuation of a cached session.
 * Uses per-message hash comparison to deterministically classify mutations.
 *
 * Decision matrix:
 *   Full prefix match (fast-path)          → continuation (resume normally)
 *   Suffix overlap >= MIN_SUFFIX           → compaction   (resume normally)
 *   Prefix overlap > 0, no suffix          → undo         (fork at rollback point)
 *   No overlap                             → diverged     (start fresh)
 */
export function verifyLineage(
  cached: SessionState,
  messages: Array<{ role: string; content: any }>,
  cacheKey: string,
  cache: SessionCacheLike
): LineageResult {
  // No stored lineage (legacy entry or first request) — allow resume
  if (!cached.lineageHash || cached.messageCount === 0) {
    return { type: "continuation", session: cached }
  }

  // --- Fast path: aggregate lineage hash ---
  const prefix = messages.slice(0, cached.messageCount)
  const prefixHash = computeLineageHash(prefix)
  if (prefixHash === cached.lineageHash) {
    // Same or fewer messages with matching hash = replay/retry, not continuation.
    // Without this guard, identical requests resume the old SDK session and
    // re-send the last user message, causing ghost context accumulation.
    if (messages.length <= cached.messageCount) {
      cache.delete(cacheKey)
      return { type: "diverged" }
    }
    return { type: "continuation", session: cached }
  }

  // --- Slow path: per-message diff ---
  if (!cached.messageHashes || cached.messageHashes.length === 0) {
    // No per-message hashes stored (legacy session). Can't diff — reject.
    cache.delete(cacheKey)
    return { type: "diverged" }
  }

  const incomingHashes = computeMessageHashes(messages)
  const incomingSet = new Set(incomingHashes)

  const prefixOverlap = measurePrefixOverlap(cached.messageHashes, incomingSet)
  const suffixOverlap = measureSuffixOverlap(cached.messageHashes, incomingSet)

  // Compaction: suffix preserved, long enough conversation
  const MIN_STORED_FOR_COMPACTION = 6
  if (
    suffixOverlap >= MIN_SUFFIX_FOR_COMPACTION &&
    cached.messageHashes.length >= MIN_STORED_FOR_COMPACTION
  ) {
    const compactionMsg = `Compaction detected (key=${cacheKey.slice(0, 8)}…): suffix overlap ${suffixOverlap}/${cached.messageHashes.length}. Allowing resume.`
    console.error(`[PROXY] ${compactionMsg}`)
    diagnosticLog.lineage(compactionMsg)
    cached.lineageHash = computeLineageHash(messages)
    cached.messageHashes = incomingHashes
    cached.messageCount = messages.length
    return { type: "compaction", session: cached }
  }

  // Undo: prefix preserved (beginning intact) but suffix changed,
  // AND the conversation shrank (fewer messages). If the conversation grew
  // (messages.length > cached.messageCount), the client added new messages
  // after modifying a previous one — that's a continuation, not an undo.
  if (prefixOverlap > 0 && suffixOverlap === 0 && messages.length <= cached.messageCount) {
    // Find the SDK UUID at the last matching position.
    let rollbackUuid: string | undefined
    if (cached.sdkMessageUuids) {
      for (let i = prefixOverlap - 1; i >= 0; i--) {
        if (cached.sdkMessageUuids[i]) {
          rollbackUuid = cached.sdkMessageUuids[i]!
          break
        }
      }
    }
    const undoMsg = `Undo detected (key=${cacheKey.slice(0, 8)}…): prefix overlap ${prefixOverlap}/${cached.messageHashes.length}, rollback UUID: ${rollbackUuid || "none (legacy session)"}.`
    console.error(`[PROXY] ${undoMsg}`)
    diagnosticLog.lineage(undoMsg)
    return { type: "undo", session: cached, prefixOverlap, rollbackUuid }
  }

  // Modified continuation: most prefix matches but a message was modified
  // (e.g., cache_control added) and new messages were appended. Treat as
  // continuation — update stored hashes and resume normally.
  if (prefixOverlap > 0 && messages.length > cached.messageCount) {
    const modifiedMsg = `Modified continuation (key=${cacheKey.slice(0, 8)}…): prefix overlap ${prefixOverlap}/${cached.messageHashes.length}, incoming ${messages.length} msgs. Allowing resume.`
    console.error(`[PROXY] ${modifiedMsg}`)
    diagnosticLog.lineage(modifiedMsg)
    cached.lineageHash = computeLineageHash(messages.slice(0, messages.length))
    cached.messageHashes = incomingHashes
    cached.messageCount = messages.length
    return { type: "continuation", session: cached }
  }

  // No meaningful overlap — completely different conversation.
  cache.delete(cacheKey)
  return { type: "diverged" }
}
