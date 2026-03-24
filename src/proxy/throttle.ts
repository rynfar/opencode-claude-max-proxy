import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { logger } from "@/logger";
import type { ProxyEnv } from "@/proxy/env";

const MAX_CONCURRENT = Number.parseInt(
  process.env.CLAUDE_PROXY_MAX_CONCURRENT || "10",
  10,
);

let active = 0;
const waiting: (() => void)[] = [];

function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push(resolve));
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export function withThrottle(
  handler: (c: Context<ProxyEnv>) => Promise<Response>,
) {
  return async (c: Context<ProxyEnv>) => {
    const requestId = c.req.header("x-request-id") || randomUUID();
    const queueEnteredAt = Date.now();
    await acquireSlot();
    const queueStartedAt = Date.now();
    c.set("proxyTelemetry", { requestId, queueEnteredAt, queueStartedAt });
    const queueMs = queueStartedAt - queueEnteredAt;
    if (queueMs > 50) {
      logger.debug(`Throttle: waited ${queueMs}ms for slot`);
    }
    try {
      return await handler(c);
    } finally {
      releaseSlot();
    }
  };
}

export function throttleStats() {
  return { active, waiting: waiting.length, max: MAX_CONCURRENT };
}
