#!/usr/bin/env node

import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@/logger";
import type { ProxyConfig } from "@/proxy";
import { startProxyServer } from "@/proxy";

const exec = promisify(execCallback);
installProcessGuards();

type ClaudeAuthStatus = {
  loggedIn?: boolean;
  subscriptionType?: string;
};

function readProxyConfig(): Partial<ProxyConfig> {
  return {
    port: Number.parseInt(process.env.CLAUDE_PROXY_PORT || "3456", 10),
    host: process.env.CLAUDE_PROXY_HOST || "127.0.0.1",
    idleTimeoutSeconds: Number.parseInt(
      process.env.CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS || "120",
      10,
    ),
  };
}

function installProcessGuards() {
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { message: err.message });
  });
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.error("Unhandled promise rejection", { message });
  });
}

async function ensureClaudeAuth() {
  try {
    const { stdout } = await exec("claude auth status", { timeout: 5000 });
    const auth = JSON.parse(stdout) as ClaudeAuthStatus;
    if (!auth.loggedIn) {
      logger.error("Not signed in to Claude Code. Run: claude login");
      process.exit(1);
    }
    if (auth.subscriptionType !== "max") {
      logger.warn(
        `Subscription is ${auth.subscriptionType ?? "unknown"}; Claude Max is recommended for this proxy.`,
      );
    }
  } catch {
    logger.warn(
      "Could not run `claude auth status`. If requests fail, run: claude login",
    );
  }
}

function printOpencodeHint(host: string, port: number) {
  const baseUrl = `http://${host}:${port}`;
  logger.box(
    `OpenCode — point Anthropic at this proxy:

ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=${baseUrl} opencode`,
  );
}

async function main() {
  const config = readProxyConfig();
  await ensureClaudeAuth();
  const instance = await startProxyServer(config);
  printOpencodeHint(instance.config.host, instance.config.port);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error("Proxy failed to start", { message });
  process.exit(1);
});
