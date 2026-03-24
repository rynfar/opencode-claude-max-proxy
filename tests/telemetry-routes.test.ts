import { beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { createTelemetryRoutes } from "../src/proxy/telemetry/routes";
import { telemetryStore } from "../src/proxy/telemetry/store";
import type { RequestMetric } from "../src/proxy/telemetry/types";

function makeMetric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    model: "sonnet",
    mode: "stream",
    isResume: false,
    isPassthrough: false,
    status: 200,
    queueWaitMs: 5,
    proxyOverheadMs: 12,
    ttfbMs: 120,
    upstreamDurationMs: 800,
    totalDurationMs: 850,
    contentBlocks: 3,
    textEvents: 10,
    error: null,
    ...overrides,
  };
}

describe("Telemetry routes", () => {
  let app: Hono;

  beforeEach(() => {
    telemetryStore.clear();
    app = new Hono();
    app.route("/telemetry", createTelemetryRoutes());
  });

  it("GET /telemetry returns HTML dashboard", async () => {
    const res = await app.fetch(new Request("http://localhost/telemetry"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Claude Max Proxy");
    expect(html).toContain("Telemetry");
  });

  it("GET /telemetry/requests returns recent metrics as JSON", async () => {
    telemetryStore.record(makeMetric({ requestId: "r1" }));
    telemetryStore.record(makeMetric({ requestId: "r2" }));

    const res = await app.fetch(
      new Request("http://localhost/telemetry/requests"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RequestMetric[];

    expect(body.length).toBe(2);
    expect(body[0]?.requestId).toBe("r2"); // newest first
    expect(body[1]?.requestId).toBe("r1");
  });

  it("GET /telemetry/requests respects limit param", async () => {
    for (let i = 0; i < 10; i++) {
      telemetryStore.record(makeMetric());
    }

    const res = await app.fetch(
      new Request("http://localhost/telemetry/requests?limit=3"),
    );
    const body = (await res.json()) as RequestMetric[];
    expect(body.length).toBe(3);
  });

  it("GET /telemetry/requests filters by model", async () => {
    telemetryStore.record(makeMetric({ model: "sonnet" }));
    telemetryStore.record(makeMetric({ model: "opus" }));

    const res = await app.fetch(
      new Request("http://localhost/telemetry/requests?model=opus"),
    );
    const body = (await res.json()) as RequestMetric[];
    expect(body.length).toBe(1);
    expect(body[0]?.model).toBe("opus");
  });

  it("GET /telemetry/summary returns aggregate stats", async () => {
    telemetryStore.record(makeMetric({ totalDurationMs: 100 }));
    telemetryStore.record(makeMetric({ totalDurationMs: 200 }));
    telemetryStore.record(
      makeMetric({ totalDurationMs: 300, error: "api_error" }),
    );

    const res = await app.fetch(
      new Request("http://localhost/telemetry/summary"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.totalRequests).toBe(3);
    expect(body.errorCount).toBe(1);
    expect((body.totalDuration as { min: number }).min).toBe(100);
    expect((body.totalDuration as { max: number }).max).toBe(300);
    expect(body.byModel).toBeDefined();
    expect(body.byMode).toBeDefined();
  });

  it("GET /telemetry/summary respects window param", async () => {
    telemetryStore.record(
      makeMetric({ timestamp: Date.now() - 120_000 }), // 2 min ago
    );
    telemetryStore.record(makeMetric({ timestamp: Date.now() }));

    const res = await app.fetch(
      new Request("http://localhost/telemetry/summary?window=60000"),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.totalRequests).toBe(1); // only the recent one
  });

  it("caps limit at 500", async () => {
    const res = await app.fetch(
      new Request("http://localhost/telemetry/requests?limit=9999"),
    );
    expect(res.status).toBe(200);
    // Should not crash, just caps internally
  });
});
