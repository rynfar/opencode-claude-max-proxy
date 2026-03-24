/**
 * Non-streaming (buffered) response handler.
 *
 * Collects all content blocks from the SDK query, merges any passthrough
 * tool_use blocks captured by the PreToolUse hook, and returns a single
 * JSON response.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@/logger";
import { storeSession } from "@/proxy/session";
import type { SessionState } from "@/proxy/session";
import type { RequestTelemetryContext } from "@/proxy/telemetry/context";
import { telemetryStore } from "@/proxy/telemetry/store";
import { isSessionUuidError } from "./errors";
import type { CapturedToolUse } from "./hooks";
import type { QueryOptions } from "./options";
import { stripMcpPrefix } from "./passthrough";
import type { Message } from "./types";

export async function handleNonStream(opts: {
  prompt: string | AsyncIterable<unknown>;
  queryOptions: QueryOptions;
  passthrough: boolean;
  capturedToolUses: CapturedToolUse[];
  opencodeSessionId: string | undefined;
  messages: Message[];
  allMessages: Message[];
  workingDirectory?: string;
  resumeSessionId: string | undefined;
  requestModel: string;
  telemetry: RequestTelemetryContext;
  model: string;
  isResume: boolean;
  lineageType: string;
  cachedSession: SessionState | undefined;
}): Promise<Response> {
  const {
    prompt,
    queryOptions,
    passthrough,
    capturedToolUses,
    opencodeSessionId,
    messages,
    allMessages,
    workingDirectory,
    resumeSessionId,
    requestModel,
    telemetry,
    model,
    isResume,
    lineageType,
    cachedSession,
  } = opts;

  const contentBlocks: Array<Record<string, unknown>> = [];
  let currentSessionId: string | undefined;
  let firstChunkAt: number | undefined;
  const upstreamStartAt = Date.now();

  // Build UUID map from cached session or start fresh
  const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
    ? [...cachedSession.sdkMessageUuids]
    : new Array(allMessages.length - 1).fill(null);
  while (sdkUuidMap.length < allMessages.length) {
    sdkUuidMap.push(null);
  }

  logger.debug(`Non-stream query ${queryOptions.model}`);

  const runQuery = async (options: typeof queryOptions) => {
    const response = query({
      prompt: prompt as Parameters<typeof query>[0]["prompt"],
      options,
    });

    for await (const message of response) {
      const sessionId = (message as Record<string, unknown>).session_id;
      if (typeof sessionId === "string") {
        currentSessionId = sessionId;
      }
      if (message.type === "assistant") {
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
        }
        // Capture UUID from assistant messages
        const uuid = (message as Record<string, unknown>).uuid;
        if (typeof uuid === "string") {
          sdkUuidMap.push(uuid);
        }
        for (const block of message.message.content) {
          const b = block as Record<string, unknown>;
          if (
            passthrough &&
            b.type === "tool_use" &&
            typeof b.name === "string"
          ) {
            b.name = stripMcpPrefix(b.name as string);
          }
          contentBlocks.push(b);
        }
      }
    }
  };

  try {
    await runQuery(queryOptions);

    logger.debug(`Non-stream complete ${queryOptions.model} ${Date.now() - upstreamStartAt}ms`);
  } catch (error) {
    // Retry without resumeSessionAt if the undo UUID is stale
    if (isSessionUuidError(error) && queryOptions.resumeSessionAt) {
      logger.warn(`Stale undo UUID ${queryOptions.resumeSessionAt.slice(0, 12)}, retrying without resumeSessionAt`);
      const retryOptions = { ...queryOptions };
      delete retryOptions.resumeSessionAt;
      delete retryOptions.forkSession;
      try {
        await runQuery(retryOptions);
      } catch (retryError) {
        logger.error(`Non-stream retry failed ${queryOptions.model} ${Date.now() - upstreamStartAt}ms: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        throw retryError;
      }
    } else {
      logger.error(`Non-stream failed ${queryOptions.model} ${Date.now() - upstreamStartAt}ms: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  // Merge passthrough tool_use blocks not already in content
  if (passthrough && capturedToolUses.length > 0) {
    for (const tu of capturedToolUses) {
      if (!contentBlocks.some((b) => b.type === "tool_use" && b.id === tu.id)) {
        contentBlocks.push({
          type: "tool_use",
          id: tu.id,
          name: tu.name,
          input: tu.input,
        });
      }
    }
  }

  const hasToolUse = contentBlocks.some((b) => b.type === "tool_use");
  const stopReason = hasToolUse ? "tool_use" : "end_turn";

  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: "text",
      text: "I can help with that. Could you provide more details about what you'd like me to do?",
    });
  }

  if (currentSessionId) {
    storeSession(
      opencodeSessionId,
      allMessages,
      currentSessionId,
      workingDirectory,
      sdkUuidMap,
    );
  }

  const responseSessionId =
    currentSessionId || resumeSessionId || `session_${Date.now()}`;

  const queueWaitMs = telemetry.queueWaitMs;
  const totalDurationMs = Date.now() - telemetry.requestStartAt;
  telemetryStore.record({
    requestId: telemetry.requestId,
    timestamp: Date.now(),
    model,
    mode: "non-stream",
    isResume,
    isPassthrough: passthrough,
    status: 200,
    queueWaitMs,
    proxyOverheadMs: upstreamStartAt - telemetry.requestStartAt - queueWaitMs,
    ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
    upstreamDurationMs: Date.now() - upstreamStartAt,
    totalDurationMs,
    contentBlocks: contentBlocks.length,
    textEvents: 0,
    error: null,
    lineageType: lineageType as "continuation" | "compaction" | "undo" | "diverged" | "new",
    messageCount: allMessages.length,
    sdkSessionId: currentSessionId,
  });

  return new Response(
    JSON.stringify({
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: contentBlocks,
      model: requestModel,
      stop_reason: stopReason,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Claude-Session-ID": responseSessionId,
      },
    },
  );
}
