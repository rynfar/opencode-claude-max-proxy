/**
 * SSE streaming response handler.
 *
 * Creates a ReadableStream that forwards SDK stream events to the client,
 * filtering out internal MCP tool blocks and handling passthrough mode
 * tool injection. Includes heartbeat pings and graceful error handling.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@/logger";
import { storeSession } from "@/proxy/session";
import type { SessionState } from "@/proxy/session";
import type { RequestTelemetryContext } from "@/proxy/telemetry/context";
import { telemetryStore } from "@/proxy/telemetry/store";
import {
  classifyError,
  isClosedControllerError,
  isSessionUuidError,
} from "./errors";
import type { CapturedToolUse } from "./hooks";
import type { QueryOptions } from "./options";
import { PASSTHROUGH_MCP_PREFIX, stripMcpPrefix } from "./passthrough";
import type { Message, StreamEvent } from "./types";

export function handleStream(opts: {
  prompt: string | AsyncIterable<unknown>;
  queryOptions: QueryOptions;
  passthrough: boolean;
  capturedToolUses: CapturedToolUse[];
  opencodeSessionId: string | undefined;
  messages: Message[];
  allMessages: Message[];
  workingDirectory?: string;
  resumeSessionId: string | undefined;
  telemetry: RequestTelemetryContext;
  model: string;
  isResume: boolean;
  lineageType: string;
  cachedSession: SessionState | undefined;
}): Response {
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
    telemetry,
    model,
    isResume,
    lineageType,
    cachedSession,
  } = opts;

  const encoder = new TextEncoder();

  const readable = new ReadableStream({
    async start(controller) {
      const upstreamStartAt = Date.now();
      let firstChunkAt: number | undefined;
      let streamEventsSeen = 0;
      let eventsForwarded = 0;
      let textEventsForwarded = 0;
      let streamClosed = false;

      const safeEnqueue = (payload: Uint8Array, source: string): boolean => {
        if (streamClosed) return false;
        try {
          controller.enqueue(payload);
          return true;
        } catch (error) {
          if (isClosedControllerError(error)) {
            streamClosed = true;
            logger.debug(`SSE client disconnected at ${source} (${eventsForwarded}/${streamEventsSeen} events)`);
            return false;
          }
          logger.error(`Failed to write SSE chunk (${source}): ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      };

      try {
        let currentSessionId: string | undefined;
        // Build UUID map from cached session or start fresh
        const sdkUuidMap: Array<string | null> = cachedSession?.sdkMessageUuids
          ? [...cachedSession.sdkMessageUuids]
          : new Array(allMessages.length - 1).fill(null);
        // Ensure map covers all incoming messages
        while (sdkUuidMap.length < allMessages.length) {
          sdkUuidMap.push(null);
        }

        const skipBlockIndices = new Set<number>();
        const streamedToolUseIds = new Set<string>();
        let messageStartEmitted = false;

        const runStreamQuery = async (options: typeof queryOptions) => {
          const response = query({
            prompt: prompt as Parameters<typeof query>[0]["prompt"],
            options,
          });

          const heartbeat = setInterval(() => {
            try {
              if (!safeEnqueue(encoder.encode(`: ping\n\n`), "heartbeat")) {
                clearInterval(heartbeat);
              }
            } catch {
              clearInterval(heartbeat);
            }
          }, 15_000);

          try {
            for await (const message of response) {
              if (streamClosed) break;

              const sessionId = (message as Record<string, unknown>).session_id;
              if (typeof sessionId === "string") {
                currentSessionId = sessionId;
              }

              // Capture UUIDs from assistant messages
              if (message.type === "assistant") {
                const uuid = (message as Record<string, unknown>).uuid;
                if (typeof uuid === "string") {
                  sdkUuidMap.push(uuid);
                }
              }

              if (message.type === "stream_event") {
                streamEventsSeen += 1;
                if (!firstChunkAt) {
                  firstChunkAt = Date.now();
                }

                const event = message.event as StreamEvent;
                const eventType = event.type;
                const eventIndex = event.index;

                if (eventType === "message_start") {
                  skipBlockIndices.clear();
                  if (messageStartEmitted) continue;
                  messageStartEmitted = true;
                }

                // Skip intermediate message_stop — emit only at the end
                if (eventType === "message_stop") continue;

                if (eventType === "content_block_start") {
                  const block = event.content_block;
                  if (
                    block?.type === "tool_use" &&
                    typeof block.name === "string"
                  ) {
                    if (
                      passthrough &&
                      block.name.startsWith(PASSTHROUGH_MCP_PREFIX)
                    ) {
                      block.name = stripMcpPrefix(block.name);
                      if (block.id) streamedToolUseIds.add(block.id);
                    } else if (block.name.startsWith("mcp__")) {
                      if (eventIndex !== undefined)
                        skipBlockIndices.add(eventIndex);
                      continue;
                    }
                  }
                }

                if (
                  eventIndex !== undefined &&
                  skipBlockIndices.has(eventIndex)
                ) {
                  continue;
                }

                if (eventType === "message_delta") {
                  const stopReason = event.delta?.stop_reason;
                  if (stopReason === "tool_use" && skipBlockIndices.size > 0) {
                    continue;
                  }
                }

                const payload = encoder.encode(
                  `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`,
                );
                if (!safeEnqueue(payload, `stream_event:${eventType}`)) break;
                eventsForwarded += 1;
                if (eventType === "content_block_delta") {
                  const delta = event.delta as { type?: string } | undefined;
                  if (delta?.type === "text_delta") {
                    textEventsForwarded += 1;
                  }
                }
              }
            }
          } finally {
            clearInterval(heartbeat);
          }
        };

        try {
          await runStreamQuery(queryOptions);
        } catch (queryError) {
          // Retry without resumeSessionAt if the undo UUID is stale
          if (isSessionUuidError(queryError) && queryOptions.resumeSessionAt) {
            logger.warn(`Stale undo UUID ${queryOptions.resumeSessionAt.slice(0, 12)}, retrying without resumeSessionAt`);
            const retryOptions = { ...queryOptions };
            delete retryOptions.resumeSessionAt;
            delete retryOptions.forkSession;
            await runStreamQuery(retryOptions);
          } else {
            throw queryError;
          }
        }

        logger.debug(`Stream complete ${queryOptions.model} ${Date.now() - upstreamStartAt}ms (${eventsForwarded}/${streamEventsSeen} events)`);

        if (currentSessionId) {
          storeSession(
            opencodeSessionId,
            allMessages,
            currentSessionId,
            workingDirectory,
            sdkUuidMap,
          );
        }

        if (!streamClosed) {
          // Emit passthrough tool blocks not already forwarded
          const unseenToolUses = capturedToolUses.filter(
            (tu) => !streamedToolUseIds.has(tu.id),
          );
          if (passthrough && unseenToolUses.length > 0 && messageStartEmitted) {
            emitPassthroughTools(
              unseenToolUses,
              eventsForwarded,
              encoder,
              safeEnqueue,
            );
          }

          if (messageStartEmitted) {
            safeEnqueue(
              encoder.encode(
                `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
              ),
              "final_message_stop",
            );
          }

          try {
            controller.close();
          } catch {}
          streamClosed = true;
        }

        const queueWaitMs = telemetry.queueWaitMs;
        const streamTotalDurationMs = Date.now() - telemetry.requestStartAt;
        telemetryStore.record({
          requestId: telemetry.requestId,
          timestamp: Date.now(),
          model,
          mode: "stream",
          isResume,
          isPassthrough: passthrough,
          status: 200,
          queueWaitMs,
          proxyOverheadMs:
            upstreamStartAt - telemetry.requestStartAt - queueWaitMs,
          ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
          upstreamDurationMs: Date.now() - upstreamStartAt,
          totalDurationMs: streamTotalDurationMs,
          contentBlocks: eventsForwarded,
          textEvents: textEventsForwarded,
          error: null,
          lineageType: lineageType as "continuation" | "compaction" | "undo" | "diverged" | "new",
          messageCount: allMessages.length,
          sdkSessionId: currentSessionId,
        });
      } catch (error) {
        if (isClosedControllerError(error)) {
          streamClosed = true;
          return;
        }

        logger.error(`Stream failed ${queryOptions.model} ${Date.now() - upstreamStartAt}ms: ${error instanceof Error ? error.message : String(error)}`);

        const streamErr = classifyError(
          error instanceof Error ? error.message : String(error),
        );
        const queueWaitMsErr = telemetry.queueWaitMs;
        telemetryStore.record({
          requestId: telemetry.requestId,
          timestamp: Date.now(),
          model,
          mode: "stream",
          isResume,
          isPassthrough: passthrough,
          status: streamErr.status,
          queueWaitMs: queueWaitMsErr,
          proxyOverheadMs:
            upstreamStartAt - telemetry.requestStartAt - queueWaitMsErr,
          ttfbMs: firstChunkAt ? firstChunkAt - upstreamStartAt : null,
          upstreamDurationMs: Date.now() - upstreamStartAt,
          totalDurationMs: Date.now() - telemetry.requestStartAt,
          contentBlocks: eventsForwarded,
          textEvents: textEventsForwarded,
          error: streamErr.type,
          lineageType: lineageType as "continuation" | "compaction" | "undo" | "diverged" | "new",
          messageCount: allMessages.length,
        });
        safeEnqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: { type: streamErr.type, message: streamErr.message },
            })}\n\n`,
          ),
          "error_event",
        );

        if (!streamClosed) {
          try {
            controller.close();
          } catch {}
          streamClosed = true;
        }
      }
    },
  });

  const streamSessionId = resumeSessionId || `session_${Date.now()}`;
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Claude-Session-ID": streamSessionId,
    },
  });
}

// ── Passthrough Tool Emission ──

function emitPassthroughTools(
  toolUses: CapturedToolUse[],
  baseIndex: number,
  encoder: TextEncoder,
  safeEnqueue: (payload: Uint8Array, source: string) => boolean,
): void {
  for (let i = 0; i < toolUses.length; i++) {
    const tu = toolUses[i];
    if (!tu) continue;
    const blockIndex = baseIndex + i;

    safeEnqueue(
      encoder.encode(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: {},
          },
        })}\n\n`,
      ),
      "passthrough_tool_block_start",
    );

    safeEnqueue(
      encoder.encode(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(tu.input),
          },
        })}\n\n`,
      ),
      "passthrough_tool_input",
    );

    safeEnqueue(
      encoder.encode(
        `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: blockIndex,
        })}\n\n`,
      ),
      "passthrough_tool_block_stop",
    );
  }

  safeEnqueue(
    encoder.encode(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 0 },
      })}\n\n`,
    ),
    "passthrough_message_delta",
  );
}
