/**
 * Integration tests for `GET /v1/usage/quota`.
 *
 * Verifies the route exists, returns the expected shape on cold start
 * (no SDK events observed), reflects the rate-limit store after events
 * have been recorded, and filters out the internal "default" bucket.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test"

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

// By default, mock OAuth usage to null so tests exercise the SDK-only path.
// Tests that exercise OAuth merge override this mock locally.
mock.module("../proxy/oauthUsage", () => ({
  fetchOAuthUsage: async () => null,
  resetOAuthUsageCache: () => {},
}))

const { createProxyServer } = await import("../proxy/server")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

interface QuotaResponseBucket {
  type: string
  status: string
  utilization: number | null
  resetsAt: number | null
  isUsingOverage: boolean
  overageStatus: string | null
  overageResetsAt: number | null
  overageDisabledReason: string | null
  surpassedThreshold: number | null
  observedAt: number
}

interface QuotaResponse {
  buckets: QuotaResponseBucket[]
  asOf: number
}

describe("GET /v1/usage/quota", () => {
  beforeEach(() => {
    rateLimitStore.clear()
  })

  it("returns 200 with empty buckets and a freshness timestamp on cold start", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    const before = Date.now()
    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const after = Date.now()

    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse
    expect(body.buckets).toEqual([])
    expect(typeof body.asOf).toBe("number")
    expect(body.asOf).toBeGreaterThanOrEqual(before)
    expect(body.asOf).toBeLessThanOrEqual(after)
  })

  it("reflects entries written to the rate-limit store, newest first", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    rateLimitStore.record({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.42,
      resetsAt: 1_730_000_000_000,
    })
    // Force monotonic observedAt so newest-first ordering is deterministic
    await Bun.sleep(2)
    rateLimitStore.record({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.91,
      resetsAt: 1_730_500_000_000,
      surpassedThreshold: 0.9,
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse
    expect(body.buckets).toHaveLength(2)

    const types = body.buckets.map(b => b.type)
    expect(types).toEqual(["seven_day", "five_hour"])

    const sevenDay = body.buckets[0]!
    expect(sevenDay.status).toBe("allowed_warning")
    expect(sevenDay.utilization).toBe(0.91)
    expect(sevenDay.surpassedThreshold).toBe(0.9)

    const fiveHour = body.buckets[1]!
    expect(fiveHour.status).toBe("allowed")
    expect(fiveHour.utilization).toBe(0.42)
    expect(fiveHour.surpassedThreshold).toBeNull()
    expect(fiveHour.isUsingOverage).toBe(false)
  })

  it("hides the internal 'default' fallback bucket from the endpoint", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // SDK event without rateLimitType — store buckets it under "default"
    rateLimitStore.record({ status: "allowed", utilization: 0.1 })
    rateLimitStore.record({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const types = body.buckets.map(b => b.type)
    expect(types).not.toContain("default")
    expect(types).toContain("five_hour")
    expect(body.buckets).toHaveLength(1)
  })

  it("nulls out unset optional fields (utilization, resetsAt, overage*)", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    rateLimitStore.record({ status: "rejected", rateLimitType: "five_hour" })
    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const bucket = body.buckets[0]!
    expect(bucket.type).toBe("five_hour")
    expect(bucket.status).toBe("rejected")
    expect(bucket.utilization).toBeNull()
    expect(bucket.resetsAt).toBeNull()
    expect(bucket.overageStatus).toBeNull()
    expect(bucket.overageResetsAt).toBeNull()
    expect(bucket.overageDisabledReason).toBeNull()
    expect(bucket.surpassedThreshold).toBeNull()
    // isUsingOverage defaults to false (not null) so consumers can use the
    // boolean directly without nullish handling.
    expect(bucket.isUsingOverage).toBe(false)
  })

  it("merges OAuth-sourced buckets onto SDK buckets, OAuth wins for utilization/resetsAt", async () => {
    // Override the default null mock for this test only.
    mock.module("../proxy/oauthUsage", () => ({
      fetchOAuthUsage: async () => ({
        windows: [
          { type: "five_hour", utilization: 0.36, resetsAt: 1_730_111_111_111 },
          { type: "seven_day", utilization: 0.05, resetsAt: 1_730_222_222_222 },
          { type: "seven_day_omelette", utilization: 0.01, resetsAt: 1_730_333_333_333 },
        ],
        extraUsage: { isEnabled: true, monthlyLimit: 0, usedCredits: 23630, utilization: null, currency: "USD" },
        fetchedAt: 1_730_000_000_000,
      }),
      resetOAuthUsageCache: () => {},
    }))
    // The createProxyServer factory captures `fetchOAuthUsage` lazily via
    // ES module live binding, so the route picks up the new mock without
    // needing to re-import.
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // SDK has its own bucket for five_hour with overage info we want preserved.
    rateLimitStore.record({
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.10,         // OAuth (0.36) should win
      resetsAt: 999_999_999_999,  // OAuth (1_730_111_111_111) should win
      isUsingOverage: false,
      overageStatus: "rejected",  // SDK should win — OAuth doesn't expose this
      overageDisabledReason: "org_level_disabled_until",
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    expect(res.status).toBe(200)
    const body = await res.json() as QuotaResponse & { extraUsage?: any; sources?: any }

    const fiveHour = body.buckets.find(b => b.type === "five_hour")!
    expect(fiveHour.utilization).toBeCloseTo(0.36, 5)
    expect(fiveHour.resetsAt).toBe(1_730_111_111_111)
    // SDK overage details preserved through the merge
    expect(fiveHour.overageStatus).toBe("rejected")
    expect(fiveHour.overageDisabledReason).toBe("org_level_disabled_until")

    // OAuth-only buckets are appended
    expect(body.buckets.find(b => b.type === "seven_day")).toBeDefined()
    expect(body.buckets.find(b => b.type === "seven_day_omelette")).toBeDefined()

    // extra_usage block exposed at top level
    expect(body.extraUsage).toBeDefined()
    expect(body.extraUsage!.usedCredits).toBe(23630)

    // Reset module mock for any subsequent tests
    mock.module("../proxy/oauthUsage", () => ({
      fetchOAuthUsage: async () => null,
      resetOAuthUsageCache: () => {},
    }))
  })

  it("preserves overage fields when present", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    rateLimitStore.record({
      status: "allowed_warning",
      rateLimitType: "overage",
      utilization: 0.78,
      resetsAt: 1_730_000_000_000,
      overageStatus: "allowed",
      overageResetsAt: 1_730_100_000_000,
      isUsingOverage: true,
      surpassedThreshold: 0.75,
      overageDisabledReason: "no_limits_configured",
    })

    const res = await app.fetch(new Request("http://localhost/v1/usage/quota"))
    const body = await res.json() as QuotaResponse
    const bucket = body.buckets[0]!
    expect(bucket.type).toBe("overage")
    expect(bucket.isUsingOverage).toBe(true)
    expect(bucket.overageStatus).toBe("allowed")
    expect(bucket.overageResetsAt).toBe(1_730_100_000_000)
    expect(bucket.overageDisabledReason).toBe("no_limits_configured")
    expect(bucket.surpassedThreshold).toBe(0.75)
  })
})
