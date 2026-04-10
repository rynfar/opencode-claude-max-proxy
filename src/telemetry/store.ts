/**
 * In-memory ring buffer for telemetry metrics.
 *
 * Append-only, fixed capacity, oldest entries overwritten.
 * No disk I/O in the hot path. Data resets on proxy restart.
 */

import type { RequestMetric, TelemetrySummary, ITelemetryStore } from "./types"
import { computeSummary } from "./percentiles"

const DEFAULT_CAPACITY = 1000

function getCapacity(): number {
  const raw = process.env.MERIDIAN_TELEMETRY_SIZE ?? process.env.CLAUDE_PROXY_TELEMETRY_SIZE
  if (!raw) return DEFAULT_CAPACITY
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CAPACITY
  return parsed
}

export class MemoryTelemetryStore implements ITelemetryStore {
  private buffer: (RequestMetric | null)[]
  private head = 0 // next write position
  private count = 0
  private readonly capacity: number

  constructor(capacity?: number) {
    this.capacity = capacity ?? getCapacity()
    this.buffer = new Array(this.capacity).fill(null)
  }

  /** Record a completed request metric. */
  record(metric: RequestMetric): void {
    this.buffer[this.head] = metric
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Get the total number of stored metrics. */
  get size(): number {
    return this.count
  }

  /**
   * Retrieve recent metrics, newest first.
   * @param options.limit - Max entries to return (default: 50)
   * @param options.since - Only entries after this timestamp
   * @param options.model - Filter by model name
   */
  getRecent(options: { limit?: number; since?: number; model?: string } = {}): RequestMetric[] {
    const { limit = 50, since, model } = options
    const results: RequestMetric[] = []

    // Walk backwards from most recent entry
    for (let i = 0; i < this.count && results.length < limit; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity
      const metric = this.buffer[idx]
      if (!metric) continue
      if (since && metric.timestamp < since) break // ring buffer is time-ordered
      if (model && metric.model !== model) continue
      results.push(metric)
    }

    return results
  }

  /** Find the most recent successful metric for a given SDK session ID.
   *  Used by anomaly detection to compare consecutive turns. */
  getLastForSession(sdkSessionId: string): RequestMetric | undefined {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity
      const metric = this.buffer[idx]
      if (metric && metric.sdkSessionId === sdkSessionId && metric.error === null) {
        return metric
      }
    }
    return undefined
  }

  /**
   * Compute aggregate statistics over a time window.
   * @param windowMs - Time window in ms (default: 1 hour)
   */
  summarize(windowMs: number = 60 * 60 * 1000): TelemetrySummary {
    const since = Date.now() - windowMs
    const metrics = this.getRecent({ limit: this.capacity, since })
    return computeSummary(metrics, windowMs)
  }

  /** Clear all stored metrics. */
  clear(): void {
    this.buffer = new Array(this.capacity).fill(null)
    this.head = 0
    this.count = 0
  }
}

/** Singleton store instance used by the proxy. */
export const telemetryStore = new MemoryTelemetryStore()
