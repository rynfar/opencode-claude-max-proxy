/**
 * Claude provider — thin orchestrator.
 *
 * Parses the incoming request, resolves session state, builds the SDK
 * query options, and delegates to either the streaming or non-streaming
 * response handler.
 */

import type { Context } from "hono";
import { logger } from "@/logger";
import type { ProxyEnv } from "@/proxy/env";
import { lookupSession } from "@/proxy/session";
import type { LineageResult } from "@/proxy/session";
import { getRequestTelemetryContext } from "@/proxy/telemetry/context";
import { telemetryStore } from "@/proxy/telemetry/store";
import { extractAgents } from "./agents";
import { classifyError } from "./errors";
import { buildHooks, type CapturedToolUse } from "./hooks";
import { handleNonStream } from "./non-stream";
import { buildQueryOptions } from "./options";
import { parseRequest, resolveClaudeExecutable } from "./parse";
import { createPassthroughMcpServer } from "./passthrough";
import { buildPrompt, prepareMessages } from "./prompt";
import { handleStream } from "./stream";

let claudeExecutable = "";

export async function handleMessages(c: Context<ProxyEnv>): Promise<Response> {
  const telemetry = getRequestTelemetryContext(c);

  try {
    const parsed = await parseRequest(c);
    const { body, model, stream, messages, opencodeSessionId } = parsed;

    // Session resume
    const lineageResult: LineageResult | undefined = lookupSession(
      opencodeSessionId,
      messages,
      parsed.workingDirectory,
    );

    const isUndo = lineageResult?.type === "undo";
    const cachedSession =
      lineageResult && lineageResult.type !== "diverged"
        ? lineageResult.session
        : undefined;
    const resumeSessionId = cachedSession?.claudeSessionId;
    const isResume =
      lineageResult?.type === "continuation" ||
      lineageResult?.type === "compaction";
    const undoRollbackUuid =
      isUndo && lineageResult.type === "undo"
        ? lineageResult.rollbackUuid
        : undefined;
    const lineageType = lineageResult?.type ?? "new";

    logger.info(
      `${stream ? "Stream" : "Request"} → ${model} [${lineageType}${isResume ? ", resume" : ""}] ${messages.length} msgs`,
    );

    // Agent extraction
    const agents = extractAgents(body.tools);
    const systemContext = parsed.systemContext + agents.systemContextAppend;

    // Message preparation & prompt building
    const messagesToConvert = prepareMessages(
      messages,
      isResume,
      cachedSession,
      isUndo,
    );
    const prompt = buildPrompt(messagesToConvert, isResume);

    // Passthrough mode
    const passthrough = Boolean(process.env.CLAUDE_PROXY_PASSTHROUGH);
    const capturedToolUses: CapturedToolUse[] = [];
    const passthroughMcp =
      passthrough && Array.isArray(body.tools) && body.tools.length > 0
        ? createPassthroughMcpServer(body.tools)
        : undefined;

    // Hooks
    const sdkHooks = buildHooks(
      passthrough,
      agents.validAgentNames,
      capturedToolUses,
    );

    // Resolve executable
    if (!claudeExecutable) {
      claudeExecutable = await resolveClaudeExecutable();
    }

    // Build SDK options
    const queryOptions = buildQueryOptions({
      model,
      workingDirectory: parsed.workingDirectory,
      claudeExecutable,
      systemContext,
      cleanEnv: parsed.cleanEnv,
      passthrough,
      passthroughMcp,
      sdkAgents: agents.sdkAgents,
      resumeSessionId,
      sdkHooks,
      includePartialMessages: stream ? true : undefined,
      isUndo,
      undoRollbackUuid,
    });

    if (stream) {
      return handleStream({
        prompt,
        queryOptions,
        passthrough,
        capturedToolUses,
        opencodeSessionId,
        messages,
        allMessages: messages,
        workingDirectory: parsed.workingDirectory,
        resumeSessionId,
        telemetry,
        model,
        isResume,
        lineageType,
        cachedSession,
      });
    }

    return await handleNonStream({
      prompt,
      queryOptions,
      passthrough,
      capturedToolUses,
      opencodeSessionId,
      messages,
      allMessages: messages,
      workingDirectory: parsed.workingDirectory,
      resumeSessionId,
      requestModel: body.model,
      telemetry,
      model,
      isResume,
      lineageType,
      cachedSession,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error("Request handler error", {
      durationMs: Date.now() - telemetry.requestStartAt,
      message: errMsg,
    });

    const classified = classifyError(errMsg);

    telemetryStore.record({
      requestId: telemetry.requestId,
      timestamp: Date.now(),
      model: "unknown",
      mode: "non-stream",
      isResume: false,
      isPassthrough: Boolean(process.env.CLAUDE_PROXY_PASSTHROUGH),
      status: classified.status,
      queueWaitMs: telemetry.queueWaitMs,
      proxyOverheadMs:
        Date.now() - telemetry.requestStartAt - telemetry.queueWaitMs,
      ttfbMs: null,
      upstreamDurationMs: Date.now() - telemetry.requestStartAt,
      totalDurationMs: Date.now() - telemetry.requestStartAt,
      contentBlocks: 0,
      textEvents: 0,
      error: classified.type,
    });

    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: classified.type, message: classified.message },
      }),
      {
        status: classified.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
