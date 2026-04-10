import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSqliteStores } from "../telemetry/sqlite"
import type { ITelemetryStore, IDiagnosticLogStore, RequestMetric } from "../telemetry/types"

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

describe("SqliteTelemetryStore", () => {
  let tmpDir: string
  let store: ITelemetryStore
  let logStore: IDiagnosticLogStore
  let close: () => void

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const dbPath = join(tmpDir, "test.db")
    const stores = createSqliteStores(dbPath, 7)
    store = stores.telemetry
    logStore = stores.diagnostics
    close = stores.close
  })

  afterEach(() => {
    close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("records and retrieves metrics (newest first)", () => {
    store.record(makeMetric({ requestId: "r1", timestamp: 1000 }))
    store.record(makeMetric({ requestId: "r2", timestamp: 2000 }))

    expect(store.size).toBe(2)
    const recent = store.getRecent()
    expect(recent.length).toBe(2)
    expect(recent[0]!.requestId).toBe("r2")
    expect(recent[1]!.requestId).toBe("r1")
  })

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.record(makeMetric({ timestamp: 1000 + i }))
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
    store.record(makeMetric({ timestamp: 1000, requestId: "old" }))
    store.record(makeMetric({ timestamp: 2000, requestId: "new" }))

    const filtered = store.getRecent({ since: 1500 })
    expect(filtered.length).toBe(1)
    expect(filtered[0]!.requestId).toBe("new")
  })

  it("clears all metrics", () => {
    store.record(makeMetric())
    store.record(makeMetric())
    store.clear()

    expect(store.size).toBe(0)
    expect(store.getRecent().length).toBe(0)
  })

  it("summarize output matches MemoryTelemetryStore for same data", () => {
    const { MemoryTelemetryStore } = require("../telemetry/store")
    const memStore = new MemoryTelemetryStore(100)

    const metrics = [
      makeMetric({ model: "sonnet", totalDurationMs: 100, timestamp: Date.now() - 1000 }),
      makeMetric({ model: "opus", totalDurationMs: 300, timestamp: Date.now() }),
      makeMetric({ model: "sonnet", totalDurationMs: 200, error: "api_error", timestamp: Date.now() }),
    ]

    for (const m of metrics) {
      store.record(m)
      memStore.record(m)
    }

    const sqlSummary = store.summarize(3600_000)
    const memSummary = memStore.summarize(3600_000)

    expect(sqlSummary.totalRequests).toBe(memSummary.totalRequests)
    expect(sqlSummary.errorCount).toBe(memSummary.errorCount)
    expect(sqlSummary.totalDuration.p50).toBe(memSummary.totalDuration.p50)
    expect(sqlSummary.byModel["sonnet"]!.count).toBe(memSummary.byModel["sonnet"]!.count)
  })

  it("handles null ttfb values", () => {
    store.record(makeMetric({ ttfbMs: null }))
    store.record(makeMetric({ ttfbMs: 100 }))

    const recent = store.getRecent()
    expect(recent[0]!.ttfbMs).toBe(100)
    expect(recent[1]!.ttfbMs).toBeNull()
  })

  it("preserves all RequestMetric fields through round-trip", () => {
    const metric = makeMetric({
      requestId: "rt-1",
      adapter: "opencode",
      model: "sonnet",
      requestModel: "claude-sonnet-4-6-20250312",
      mode: "stream",
      isResume: true,
      isPassthrough: true,
      lineageType: "continuation",
      hasDeferredTools: true,
      deferredToolCount: 44,
      toolCount: 50,
      discoveredTools: ["task_update", "lsp_diagnostics"],
      sessionDiscoveredCount: 3,
      messageCount: 5,
      sdkSessionId: "sess-abc",
      status: 200,
      queueWaitMs: 5,
      proxyOverheadMs: 12,
      ttfbMs: 120,
      upstreamDurationMs: 800,
      totalDurationMs: 850,
      contentBlocks: 3,
      textEvents: 10,
      error: null,
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 120,
      cacheHitRate: 0.88,
    })

    store.record(metric)
    const [retrieved] = store.getRecent()

    expect(retrieved!.requestId).toBe("rt-1")
    expect(retrieved!.adapter).toBe("opencode")
    expect(retrieved!.requestModel).toBe("claude-sonnet-4-6-20250312")
    expect(retrieved!.isResume).toBe(true)
    expect(retrieved!.isPassthrough).toBe(true)
    expect(retrieved!.lineageType).toBe("continuation")
    expect(retrieved!.hasDeferredTools).toBe(true)
    expect(retrieved!.deferredToolCount).toBe(44)
    expect(retrieved!.toolCount).toBe(50)
    expect(retrieved!.discoveredTools).toEqual(["task_update", "lsp_diagnostics"])
    expect(retrieved!.sessionDiscoveredCount).toBe(3)
    expect(retrieved!.messageCount).toBe(5)
    expect(retrieved!.sdkSessionId).toBe("sess-abc")
    expect(retrieved!.inputTokens).toBe(1200)
    expect(retrieved!.outputTokens).toBe(340)
    expect(retrieved!.cacheReadInputTokens).toBe(900)
    expect(retrieved!.cacheCreationInputTokens).toBe(120)
    expect(retrieved!.cacheHitRate).toBe(0.88)
  })

  it("returns the latest successful metric for an SDK session", () => {
    store.record(makeMetric({ requestId: "older-ok", sdkSessionId: "sdk-1", inputTokens: 100 }))
    store.record(makeMetric({ requestId: "latest-error", sdkSessionId: "sdk-1", error: "api_error", inputTokens: 200 }))
    store.record(makeMetric({ requestId: "other-session", sdkSessionId: "sdk-2", inputTokens: 300 }))

    const metric = store.getLastForSession("sdk-1")

    expect(metric?.requestId).toBe("older-ok")
    expect(metric?.inputTokens).toBe(100)
  })

  it("handles interleaved timestamps correctly", () => {
    store.record(makeMetric({ requestId: "r1", timestamp: 3000 }))
    store.record(makeMetric({ requestId: "r2", timestamp: 1000 }))
    store.record(makeMetric({ requestId: "r3", timestamp: 2000 }))

    const recent = store.getRecent()
    expect(recent[0]!.requestId).toBe("r1")
    expect(recent[1]!.requestId).toBe("r3")
    expect(recent[2]!.requestId).toBe("r2")
  })

  it("persists data across close/reopen", () => {
    const dbPath = join(tmpDir, "persist-test.db")
    const stores1 = createSqliteStores(dbPath, 7)
    stores1.telemetry.record(makeMetric({ requestId: "survive" }))
    stores1.close()

    const stores2 = createSqliteStores(dbPath, 7)
    const recent = stores2.telemetry.getRecent()
    expect(recent.length).toBe(1)
    expect(recent[0]!.requestId).toBe("survive")
    stores2.close()
  })
})

describe("SqliteDiagnosticLogStore", () => {
  let tmpDir: string
  let logStore: IDiagnosticLogStore
  let close: () => void

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const dbPath = join(tmpDir, "test.db")
    const stores = createSqliteStores(dbPath, 7)
    logStore = stores.diagnostics
    close = stores.close
  })

  afterEach(() => {
    close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("records and retrieves logs (newest first)", () => {
    logStore.session("msg1")
    logStore.error("msg2")

    const logs = logStore.getRecent()
    expect(logs.length).toBe(2)
    expect(logs[0]!.message).toBe("msg2")
    expect(logs[0]!.category).toBe("error")
    expect(logs[1]!.message).toBe("msg1")
    expect(logs[1]!.category).toBe("session")
  })

  it("filters by category", () => {
    logStore.session("s1")
    logStore.error("e1")
    logStore.lineage("l1")

    const errors = logStore.getRecent({ category: "error" })
    expect(errors.length).toBe(1)
    expect(errors[0]!.message).toBe("e1")
  })

  it("filters by since timestamp", () => {
    logStore.log({ level: "info", category: "session", message: "old" })
    logStore.log({ level: "info", category: "session", message: "new" })

    const all = logStore.getRecent()
    const since = all[all.length - 1]!.timestamp + 1
    const filtered = logStore.getRecent({ since })
    expect(filtered.length).toBeLessThan(all.length)
  })

  it("attaches requestId", () => {
    logStore.session("test", "req-42")
    const [log] = logStore.getRecent()
    expect(log!.requestId).toBe("req-42")
  })

  it("clears all logs", () => {
    logStore.session("x")
    logStore.error("y")
    logStore.clear()
    expect(logStore.getRecent().length).toBe(0)
  })
})

describe("SqliteTelemetryStore error handling", () => {
  it("record() does not throw on disk error", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const dbPath = join(tmpDir, "err-test.db")
    const stores = createSqliteStores(dbPath, 7)

    stores.close()

    expect(() => {
      stores.telemetry.record(makeMetric())
    }).not.toThrow()

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe("SqliteTelemetryStore retention", () => {
  it("cleanup removes rows older than retention period", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const dbPath = join(tmpDir, "retention-test.db")
    const stores = createSqliteStores(dbPath, 1)

    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000
    const now = Date.now()

    stores.telemetry.record(makeMetric({ requestId: "old", timestamp: twoDaysAgo }))
    stores.telemetry.record(makeMetric({ requestId: "new", timestamp: now }))

    ;(stores.telemetry as any).cleanup()

    const recent = stores.telemetry.getRecent({ limit: 100 })
    expect(recent.length).toBe(1)
    expect(recent[0]!.requestId).toBe("new")

    stores.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
