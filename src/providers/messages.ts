/**
 * Shared message utilities for all providers.
 *
 * Handles session-resume message slicing, cache_control stripping,
 * and last-user-message extraction — logic that applies regardless
 * of which backend provider is in use.
 */

import type { SessionState } from "@/proxy/session/lineage";
import type { Message, MessageContent } from "./types";

export function stripCacheControl(content: MessageContent): MessageContent {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.cache_control) {
      const { cache_control, ...rest } = block;
      return rest;
    }
    return block;
  });
}

export function getLastUserMessage(messages: Message[]): Message[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user") return [msg];
  }
  return messages.slice(-1);
}

/**
 * Determine which messages to send to the backend.
 * On resume, only send the delta (new messages the backend hasn't seen).
 * On undo with a rollback UUID, send only the last user message (SDK forks to the right point).
 */
export function prepareMessages(
  allMessages: Message[],
  isResume: boolean,
  cachedSession: SessionState | undefined,
  isUndo?: boolean,
): Message[] {
  if (isUndo) {
    // On undo, SDK handles rollback via resumeSessionAt — just send the new user message
    return getLastUserMessage(allMessages);
  }
  if (isResume && cachedSession) {
    const knownCount = cachedSession.messageCount || 0;
    if (knownCount > 0 && knownCount < allMessages.length) {
      return allMessages.slice(knownCount);
    }
    return getLastUserMessage(allMessages);
  }
  return allMessages;
}
