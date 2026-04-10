import { describe, expect, it, beforeEach } from "bun:test"
import { MemoryTelemetryStore } from "../telemetry/store"
import type { RequestMetric, ITelemetryStore } from "../telemetry/types"

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
  }
}

describe("MemoryTelemetryStore", () => {
  let store: MemoryTelemetryStore

  beforeEach(() => {
    store = new MemoryTelemetryStore(10)
  })

  it("records and retrieves metrics", () => {
    store.record(makeMetric({ requestId: "r1" }))
    store.record(makeMetric({ requestId: "r2" }))

    expect(store.size).toBe(2)
    const recent = store.getRecent()
    expect(recent.length).toBe(2)
    // Newest first
    expect(recent[0]!.requestId).toBe("r2")
    expect(recent[1]!.requestId).toBe("r1")
  })

  it("evicts oldest entries when capacity is exceeded", () => {
    for (let i = 0; i < 15; i++) {
      store.record(makeMetric({ requestId: `r${i}` }))
    }

    expect(store.size).toBe(10)
    const recent = store.getRecent({ limit: 10 })
    // Should have r5-r14, not r0-r4
    expect(recent[0]!.requestId).toBe("r14")
    expect(recent[9]!.requestId).toBe("r5")
  })

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      store.record(makeMetric())
    }

    const recent = store.getRecent({ limit: 3 })
    expect(recent.length).toBe(3)
  })

  it("filters by model", () => {
    store.record(makeMetric({ model: "sonnet" }))
    store.record(makeMetric({ model: "opus" }))
    store.record(makeMetric({ model: "sonnet" }))

    const sonnets = store.getRecent({ model: "sonnet" })
    expect(sonnets.length).toBe(2)
    expect(sonnets.every(m => m.model === "sonnet")).toBe(true)
  })

  it("filters by since timestamp", () => {
    const old = Date.now() - 60_000
    const recent = Date.now()

    store.record(makeMetric({ timestamp: old, requestId: "old" }))
    store.record(makeMetric({ timestamp: recent, requestId: "new" }))

    const filtered = store.getRecent({ since: old + 1 })
    expect(filtered.length).toBe(1)
    expect(filtered[0]!.requestId).toBe("new")
  })

  it("returns the latest successful metric for an SDK session", () => {
    store.record(makeMetric({ requestId: "older-ok", sdkSessionId: "sdk-1", totalDurationMs: 100 }))
    store.record(makeMetric({ requestId: "latest-error", sdkSessionId: "sdk-1", error: "api_error", totalDurationMs: 200 }))
    store.record(makeMetric({ requestId: "other-session", sdkSessionId: "sdk-2", totalDurationMs: 300 }))

    const metric = store.getLastForSession("sdk-1")

    expect(metric?.requestId).toBe("older-ok")
  })

  it("clears all metrics", () => {
    store.record(makeMetric())
    store.record(makeMetric())
    store.clear()

    expect(store.size).toBe(0)
    expect(store.getRecent().length).toBe(0)
  })
})

describe("MemoryTelemetryStore.summarize", () => {
  let store: MemoryTelemetryStore

  beforeEach(() => {
    store = new MemoryTelemetryStore(100)
  })

  it("returns empty summary when no metrics exist", () => {
    const summary = store.summarize()

    expect(summary.totalRequests).toBe(0)
    expect(summary.errorCount).toBe(0)
    expect(summary.requestsPerMinute).toBe(0)
    expect(summary.totalDuration.p50).toBe(0)
  })

  it("computes correct percentiles", () => {
    // Add 100 metrics with totalDurationMs from 1 to 100
    for (let i = 1; i <= 100; i++) {
      store.record(makeMetric({ totalDurationMs: i, queueWaitMs: i, upstreamDurationMs: i }))
    }

    const summary = store.summarize()

    expect(summary.totalRequests).toBe(100)
    // Math.floor(100 * 0.5) = index 50 in sorted [1..100] = value 51
    expect(summary.totalDuration.p50).toBe(51)
    expect(summary.totalDuration.p95).toBe(96)
    expect(summary.totalDuration.p99).toBe(100)
    expect(summary.totalDuration.min).toBe(1)
    expect(summary.totalDuration.max).toBe(100)
  })

  it("counts errors correctly", () => {
    store.record(makeMetric({ error: null }))
    store.record(makeMetric({ error: "api_error" }))
    store.record(makeMetric({ error: "timeout_error" }))

    const summary = store.summarize()
    expect(summary.errorCount).toBe(2)
  })

  it("breaks down by model", () => {
    store.record(makeMetric({ model: "sonnet", totalDurationMs: 100 }))
    store.record(makeMetric({ model: "sonnet", totalDurationMs: 200 }))
    store.record(makeMetric({ model: "opus", totalDurationMs: 300 }))

    const summary = store.summarize()

    expect(summary.byModel["sonnet"]!.count).toBe(2)
    expect(summary.byModel["sonnet"]!.avgTotalMs).toBe(150)
    expect(summary.byModel["opus"]!.count).toBe(1)
    expect(summary.byModel["opus"]!.avgTotalMs).toBe(300)
  })

  it("breaks down by mode", () => {
    store.record(makeMetric({ mode: "stream", totalDurationMs: 100 }))
    store.record(makeMetric({ mode: "non-stream", totalDurationMs: 200 }))

    const summary = store.summarize()

    expect(summary.byMode["stream"]!.count).toBe(1)
    expect(summary.byMode["non-stream"]!.count).toBe(1)
  })

  it("respects window parameter", () => {
    const old = Date.now() - 120_000 // 2 minutes ago
    const recent = Date.now()

    store.record(makeMetric({ timestamp: old, requestId: "old" }))
    store.record(makeMetric({ timestamp: recent, requestId: "new" }))

    const summary = store.summarize(60_000) // 1 minute window
    expect(summary.totalRequests).toBe(1)
  })

  it("handles null TTFB values in percentiles", () => {
    store.record(makeMetric({ ttfbMs: null }))
    store.record(makeMetric({ ttfbMs: 100 }))

    const summary = store.summarize()
    // TTFB should only include non-null values
    expect(summary.ttfb.p50).toBe(100)
  })
})

describe("ITelemetryStore conformance", () => {
  it("MemoryTelemetryStore satisfies ITelemetryStore", () => {
    const store: ITelemetryStore = new MemoryTelemetryStore(10)
    store.record(makeMetric())
    expect(store.size).toBe(1)
    expect(store.getRecent().length).toBe(1)
    expect(store.summarize().totalRequests).toBe(1)
    store.clear()
    expect(store.size).toBe(0)
  })
})
