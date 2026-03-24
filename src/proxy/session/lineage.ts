/**
 * Conversation lineage hashing and verification.
 *
 * Used to verify that incoming messages are a strict prefix-extension
 * of what the SDK session has seen. Detects undo, edit, and branch
 * divergence to prevent resuming with stale context.
 */

import { createHash } from "node:crypto";
import { logger } from "@/logger";
import type { ContentBlock, Message, MessageContent } from "@/providers/types";

/**
 * Normalize message content to a stable string for hashing.
 * OpenCode sends content as a string on the first request but as an
 * array of content blocks on follow-ups. Both must hash identically.
 */
export function normalizeContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: ContentBlock) => {
        if (block.type === "text" && block.text) return block.text;
        if (block.type === "tool_use")
          return `tool_use:${block.id}:${block.name}:${JSON.stringify(block.input)}`;
        if (block.type === "tool_result")
          return `tool_result:${block.tool_use_id}:${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return String(content);
}

/**
 * Compute a lineage hash of an ordered message array.
 * Covers undo, edit, branch detection by hashing all messages in order.
 */
export function computeLineageHash(messages: Message[]): string {
  if (!messages || messages.length === 0) return "";
  const parts = messages.map((m) => `${m.role}:${normalizeContent(m.content)}`);
  return createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Hash the first user message + working directory to fingerprint a conversation.
 * Used to find a cached session when no x-opencode-session header is present.
 *
 * Includes workingDirectory (stable per project, unlike systemContext which
 * contains dynamic file trees/diagnostics that change every request).
 * This prevents cross-project collisions when different projects start
 * with the same first message.
 */
export function getConversationFingerprint(
  messages: Message[],
  workingDirectory?: string,
): string {
  const firstUser = messages?.find((m) => m.role === "user");
  if (!firstUser) return "";
  const text =
    typeof firstUser.content === "string"
      ? firstUser.content
      : Array.isArray(firstUser.content)
        ? firstUser.content
            .filter((b: ContentBlock) => b.type === "text")
            .map((b: ContentBlock) => b.text)
            .join("")
        : "";
  if (!text) return "";
  const seed = workingDirectory
    ? `${workingDirectory}\n${text.slice(0, 2000)}`
    : text.slice(0, 2000);
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

export interface SessionState {
  claudeSessionId: string;
  lastAccess: number;
  messageCount: number;
  lineageHash: string;
  messageHashes?: string[];
  sdkMessageUuids?: Array<string | null>;
}

/**
 * Hash a single message to a hex string.
 */
export function hashMessage(message: Message): string {
  const raw = `${message.role}:${normalizeContent(message.content)}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Compute per-message hashes for an ordered message array.
 */
export function computeMessageHashes(messages: Message[]): string[] {
  return messages.map(hashMessage);
}

// ── Lineage Result Types ──

export type LineageResult =
  | { type: "continuation"; session: SessionState }
  | { type: "compaction"; session: SessionState }
  | {
      type: "undo";
      session: SessionState;
      rollbackUuid: string | null;
      prefixLength: number;
    }
  | { type: "diverged" };

const MIN_SUFFIX_FOR_COMPACTION = 2;
const MIN_STORED_FOR_COMPACTION = 6;

/**
 * Count how many stored hashes from the START exist in the incoming set.
 * Stops at the first non-match (order-preserving prefix).
 *
 * Uses set-based membership: a stored hash counts as "matching" if it
 * appears ANYWHERE in the incoming messages, not necessarily at the same
 * position. This handles cases where message order shifts slightly.
 */
function measurePrefixOverlap(
  storedHashes: string[],
  incomingSet: Set<string>,
): number {
  let overlap = 0;
  for (const h of storedHashes) {
    if (incomingSet.has(h)) overlap++;
    else break;
  }
  return overlap;
}

/**
 * Count how many stored hashes from the END exist in the incoming set.
 * Stops at the first non-match (order-preserving suffix).
 *
 * Suffix overlap means recent conversation is intact (compaction changes
 * the beginning but preserves the end).
 */
function measureSuffixOverlap(
  storedHashes: string[],
  incomingSet: Set<string>,
): number {
  let overlap = 0;
  for (let i = storedHashes.length - 1; i >= 0; i--) {
    if (incomingSet.has(storedHashes[i]!)) overlap++;
    else break;
  }
  return overlap;
}

/**
 * Verify that incoming messages are a valid continuation of a cached session.
 * Returns a discriminated LineageResult instead of just session-or-undefined.
 *
 * - continuation: full prefix match → resume normally
 * - compaction: suffix overlap (LLM provider compressed middle) → resume normally
 * - undo: prefix overlap (user undid recent messages) → SDK fork via resumeSessionAt
 * - diverged: no meaningful overlap → start fresh
 */
export function verifyLineage(
  cached: SessionState,
  messages: Message[],
  cacheKey: string,
  cache: { delete(key: string): boolean },
): LineageResult {
  if (!cached.lineageHash || cached.messageCount === 0) {
    return { type: "continuation", session: cached };
  }

  // Fast path: aggregate hash still matches → continuation
  const prefix = messages.slice(0, cached.messageCount);
  const prefixHash = computeLineageHash(prefix);
  if (prefixHash === cached.lineageHash) {
    return { type: "continuation", session: cached };
  }

  // Slow path: per-message comparison
  const storedHashes = cached.messageHashes;
  if (!storedHashes || storedHashes.length === 0) {
    // Legacy session without per-message hashes — fall back to old behavior
    logger.warn("Session dropped — legacy session without per-message hashes");
    cache.delete(cacheKey);
    return { type: "diverged" };
  }

  const incomingHashes = computeMessageHashes(messages);
  const incomingSet = new Set(incomingHashes);

  const prefixOverlap = measurePrefixOverlap(storedHashes, incomingSet);
  const suffixOverlap = measureSuffixOverlap(storedHashes, incomingSet);

  // Compaction: suffix preserved, long enough conversation.
  // Checked BEFORE undo — compaction preserves the end while changing the
  // beginning, and takes priority over undo classification.
  if (
    suffixOverlap >= MIN_SUFFIX_FOR_COMPACTION &&
    storedHashes.length >= MIN_STORED_FOR_COMPACTION
  ) {
    logger.info(`Session compaction detected (${storedHashes.length}→${incomingHashes.length} msgs, ${suffixOverlap} preserved)`);
    // Update cached state so the next request's fast-path check works
    cached.lineageHash = computeLineageHash(messages);
    cached.messageHashes = incomingHashes;
    cached.messageCount = messages.length;
    return { type: "compaction", session: cached };
  }

  // Undo: prefix preserved (beginning intact) but suffix changed,
  // AND incoming is not longer than stored (longer = modified continuation, not undo)
  if (prefixOverlap > 0 && suffixOverlap === 0 && incomingHashes.length <= storedHashes.length) {
    // Scan backwards from the last matching position to find the nearest
    // assistant UUID — user message positions have null UUIDs.
    let rollbackUuid: string | null = null;
    if (cached.sdkMessageUuids) {
      for (let i = prefixOverlap - 1; i >= 0; i--) {
        if (cached.sdkMessageUuids[i]) {
          rollbackUuid = cached.sdkMessageUuids[i]!;
          break;
        }
      }
    }

    logger.info(`Session undo detected (${storedHashes.length}→${incomingHashes.length} msgs, rollback=${Boolean(rollbackUuid)})`);

    return {
      type: "undo",
      session: cached,
      rollbackUuid,
      prefixLength: prefixOverlap,
    };
  }

  // Modified continuation: most messages match and incoming is longer.
  // A message changed (e.g. OpenCode updated tool results or system context)
  // but the conversation is the same — resume with updated hashes.
  if (prefixOverlap > 0 && incomingHashes.length > storedHashes.length) {
    logger.debug(`Lineage: modified continuation ${cacheKey.slice(0, 12)} (${storedHashes.length}→${incomingHashes.length} msgs, ${prefixOverlap} prefix)`);
    cached.lineageHash = computeLineageHash(messages);
    cached.messageHashes = incomingHashes;
    cached.messageCount = messages.length;
    return { type: "continuation", session: cached };
  }

  // No meaningful overlap — completely different conversation.
  logger.warn(`Session diverged — conversation history changed, starting fresh (${storedHashes.length}→${incomingHashes.length} msgs)`);
  cache.delete(cacheKey);
  return { type: "diverged" };
}
