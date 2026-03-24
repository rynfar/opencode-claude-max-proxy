/**
 * In-memory ring buffer for telemetry metrics.
 *
 * Append-only, fixed capacity, oldest entries overwritten.
 * No disk I/O in the hot path. Data resets on proxy restart.
 */

import type { PhaseTiming, RequestMetric, TelemetrySummary } from "./types";

const DEFAULT_CAPACITY = 1000;

function getCapacity(): number {
  const raw = process.env.CLAUDE_PROXY_TELEMETRY_SIZE;
  if (!raw) return DEFAULT_CAPACITY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAPACITY;
  return parsed;
}

export class TelemetryStore {
  private buffer: (RequestMetric | null)[];
  private head = 0; // next write position
  private count = 0;
  private readonly capacity: number;

  constructor(capacity?: number) {
    this.capacity = capacity ?? getCapacity();
    this.buffer = new Array(this.capacity).fill(null);
  }

  /** Record a completed request metric. */
  record(metric: RequestMetric): void {
    this.buffer[this.head] = metric;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Get the total number of stored metrics. */
  get size(): number {
    return this.count;
  }

  /**
   * Retrieve recent metrics, newest first.
   * @param options.limit - Max entries to return (default: 50)
   * @param options.since - Only entries after this timestamp
   * @param options.model - Filter by model name
   */
  getRecent(
    options: { limit?: number; since?: number; model?: string } = {},
  ): RequestMetric[] {
    const { limit = 50, since, model } = options;
    const results: RequestMetric[] = [];

    // Walk backwards from most recent entry
    for (let i = 0; i < this.count && results.length < limit; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const metric = this.buffer[idx];
      if (!metric) continue;
      if (since && metric.timestamp < since) break; // ring buffer is time-ordered
      if (model && metric.model !== model) continue;
      results.push(metric);
    }

    return results;
  }

  /**
   * Compute aggregate statistics over a time window.
   * @param windowMs - Time window in ms (default: 1 hour)
   */
  summarize(windowMs: number = 60 * 60 * 1000): TelemetrySummary {
    const since = Date.now() - windowMs;
    const metrics = this.getRecent({ limit: this.capacity, since });

    if (metrics.length === 0) {
      const emptyPhase: PhaseTiming = {
        p50: 0,
        p95: 0,
        p99: 0,
        min: 0,
        max: 0,
        avg: 0,
      };
      return {
        windowMs,
        totalRequests: 0,
        errorCount: 0,
        requestsPerMinute: 0,
        queueWait: emptyPhase,
        proxyOverhead: emptyPhase,
        ttfb: emptyPhase,
        upstreamDuration: emptyPhase,
        totalDuration: emptyPhase,
        byModel: {},
        byMode: {},
      };
    }

    const errorCount = metrics.filter((m) => m.error !== null).length;

    // Compute actual time span for rate calculation
    const oldest = metrics[metrics.length - 1]?.timestamp ?? 0;
    const newest = metrics[0]?.timestamp ?? 0;
    const spanMs = Math.max(newest - oldest, 1);
    const requestsPerMinute = (metrics.length / spanMs) * 60_000;

    // Phase timings
    const queueWaits = metrics.map((m) => m.queueWaitMs);
    const overheads = metrics.map((m) => m.proxyOverheadMs);
    const ttfbs = metrics.flatMap((m) => (m.ttfbMs !== null ? [m.ttfbMs] : []));
    const upstreams = metrics.map((m) => m.upstreamDurationMs);
    const totals = metrics.map((m) => m.totalDurationMs);

    // Model breakdown
    const byModel: Record<string, { count: number; totalMs: number }> = {};
    for (const m of metrics) {
      let entry = byModel[m.model];
      if (!entry) {
        entry = { count: 0, totalMs: 0 };
        byModel[m.model] = entry;
      }
      entry.count++;
      entry.totalMs += m.totalDurationMs;
    }

    // Mode breakdown
    const byMode: Record<string, { count: number; totalMs: number }> = {};
    for (const m of metrics) {
      let entry = byMode[m.mode];
      if (!entry) {
        entry = { count: 0, totalMs: 0 };
        byMode[m.mode] = entry;
      }
      entry.count++;
      entry.totalMs += m.totalDurationMs;
    }

    return {
      windowMs,
      totalRequests: metrics.length,
      errorCount,
      requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
      queueWait: computePercentiles(queueWaits),
      proxyOverhead: computePercentiles(overheads),
      ttfb:
        ttfbs.length > 0
          ? computePercentiles(ttfbs)
          : { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 },
      upstreamDuration: computePercentiles(upstreams),
      totalDuration: computePercentiles(totals),
      byModel: Object.fromEntries(
        Object.entries(byModel).map(([k, v]) => [
          k,
          { count: v.count, avgTotalMs: Math.round(v.totalMs / v.count) },
        ]),
      ),
      byMode: Object.fromEntries(
        Object.entries(byMode).map(([k, v]) => [
          k,
          { count: v.count, avgTotalMs: Math.round(v.totalMs / v.count) },
        ]),
      ),
    };
  }

  /** Clear all stored metrics. */
  clear(): void {
    this.buffer = new Array(this.capacity).fill(null);
    this.head = 0;
    this.count = 0;
  }
}

function computePercentiles(values: number[]): PhaseTiming {
  if (values.length === 0)
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const last = sorted.length - 1;

  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    p99: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted[last] ?? 0,
    avg: Math.round(sum / sorted.length),
  };
}

/** Singleton store instance used by the proxy. */
export const telemetryStore = new TelemetryStore();
