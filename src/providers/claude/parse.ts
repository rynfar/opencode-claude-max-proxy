/**
 * Request parsing and preparation.
 *
 * Extracts model, stream flag, system context, and sanitized env
 * from the incoming Hono request context.
 */

import { exec as execCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Context } from "hono";
import { logger } from "@/logger";
import type { ContentBlock, Message, RequestBody } from "./types";

const exec = promisify(execCallback);

// ── Model Mapping ──

export type ClaudeModel = "sonnet" | "opus" | "opus[1m]" | "haiku";

export function mapModelToClaudeModel(model: string): ClaudeModel {
  if (model.includes("opus")) return "opus[1m]";
  if (model.includes("haiku")) return "haiku";
  return "sonnet";
}

// ── Claude Executable Resolution ──

let cachedClaudePath: string | null = null;
let cachedClaudePathPromise: Promise<string> | null = null;

/**
 * Resolve the Claude executable path asynchronously.
 * Three-tier cache: resolved path → in-flight promise → resolution logic.
 */
export async function resolveClaudeExecutable(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath;
  if (cachedClaudePathPromise) return cachedClaudePathPromise;

  cachedClaudePathPromise = (async () => {
    try {
      const sdkPath = fileURLToPath(
        import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
      );
      const sdkCliJs = join(dirname(sdkPath), "cli.js");
      if (existsSync(sdkCliJs)) {
        cachedClaudePath = sdkCliJs;
        logger.debug(`CLI resolved: ${sdkCliJs}`);
        return sdkCliJs;
      }
    } catch {}

    try {
      const { stdout } = await exec("which claude");
      const claudePath = stdout.trim();
      if (claudePath && existsSync(claudePath)) {
        cachedClaudePath = claudePath;
        logger.debug(`CLI resolved: ${claudePath}`);
        return claudePath;
      }
    } catch {}

    throw new Error(
      "Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code",
    );
  })();

  try {
    return await cachedClaudePathPromise;
  } finally {
    cachedClaudePathPromise = null;
  }
}

// ── Request Parsing ──

export interface ParsedRequest {
  body: RequestBody;
  model: ClaudeModel;
  stream: boolean;
  workingDirectory: string;
  cleanEnv: Record<string, string | undefined>;
  systemContext: string;
  messages: Message[];
  opencodeSessionId: string | undefined;
}

/**
 * Parse the incoming request and extract all fields needed by the handler.
 * Strips env vars that would cause the SDK subprocess to loop back through
 * the proxy, and extracts system context from body.system.
 */
export async function parseRequest(c: Context): Promise<ParsedRequest> {
  const body = (await c.req.json()) as RequestBody;
  const model = mapModelToClaudeModel(body.model || "sonnet");
  const stream = body.stream ?? true;
  const workingDirectory = process.env.CLAUDE_PROXY_WORKDIR || process.cwd();

  const {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
    ANTHROPIC_API_KEY: _dropApiKey,
    ANTHROPIC_BASE_URL: _dropBaseUrl,
    ANTHROPIC_AUTH_TOKEN: _dropAuthToken,
    ...cleanEnv
  } = process.env;

  let systemContext = "";
  if (body.system) {
    if (typeof body.system === "string") {
      systemContext = body.system;
    } else if (Array.isArray(body.system)) {
      systemContext = body.system
        .filter((b: ContentBlock) => b.type === "text" && b.text)
        .map((b: ContentBlock) => b.text)
        .join("\n");
    }
  }

  const opencodeSessionId = c.req.header("x-opencode-session");

  logger.debug(
    `Parse → ${model} stream=${stream} msgs=${body.messages?.length ?? 0} system=${Boolean(systemContext)} session=${Boolean(opencodeSessionId)}`,
  );

  return {
    body,
    model,
    stream,
    workingDirectory,
    cleanEnv,
    systemContext,
    messages: body.messages || [],
    opencodeSessionId,
  };
}
