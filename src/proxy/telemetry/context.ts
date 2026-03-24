import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ProxyEnv } from "@/proxy/env";

export type RequestTelemetryContext = {
  requestId: string;
  queueWaitMs: number;
  requestStartAt: number;
};

export function getRequestTelemetryContext(
  c: Context<ProxyEnv>,
): RequestTelemetryContext {
  const requestStartAt = Date.now();
  const meta = c.get("proxyTelemetry");
  if (!meta) {
    return {
      requestId: c.req.header("x-request-id") || randomUUID(),
      queueWaitMs: 0,
      requestStartAt,
    };
  }
  return {
    requestId: meta.requestId,
    queueWaitMs: meta.queueStartedAt - meta.queueEnteredAt,
    requestStartAt,
  };
}
