/**
 * Unit tests for the rate-limit store.
 *
 * The store is a process-wide singleton; each test instantiates a fresh
 * private copy via `_RateLimitStoreForTests` to avoid cross-test bleed.
 */

import { describe, expect, it } from "bun:test"
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { _RateLimitStoreForTests } from "../proxy/rateLimitStore"

const FIVE_HOUR: SDKRateLimitInfo = {
  status: "allowed",
  rateLimitType: "five_hour",
  utilization: 0.42,
  resetsAt: 1_730_000_000_000,
}

const SEVEN_DAY: SDKRateLimitInfo = {
  status: "allowed_warning",
  rateLimitType: "seven_day",
  utilization: 0.91,
  resetsAt: 1_730_500_000_000,
  surpassedThreshold: 0.9,
}

describe("rateLimitStore", () => {
  it("starts empty", () => {
    const store = new _RateLimitStoreForTests()
    expect(store.size).toBe(0)
    expect(store.getAll()).toEqual([])
  })

  it("records distinct buckets keyed by rateLimitType", () => {
    const store = new _RateLimitStoreForTests()
    store.record(FIVE_HOUR)
    store.record(SEVEN_DAY)
    expect(store.size).toBe(2)
    const types = store.getAll().map(e => e.rateLimitType).sort()
    expect(types).toEqual(["five_hour", "seven_day"])
  })

  it("overwrites on second record for same bucket (last-write-wins)", () => {
    const store = new _RateLimitStoreForTests()
    store.record({ ...FIVE_HOUR, utilization: 0.42 })
    store.record({ ...FIVE_HOUR, utilization: 0.55 })
    expect(store.size).toBe(1)
    expect(store.get("five_hour")?.utilization).toBe(0.55)
  })

  it("buckets entries without rateLimitType under 'default'", () => {
    const store = new _RateLimitStoreForTests()
    store.record({ status: "allowed", utilization: 0.1 })
    expect(store.size).toBe(1)
    expect(store.get("default")?.utilization).toBe(0.1)
  })

  it("ignores nullish or non-object input without throwing", () => {
    const store = new _RateLimitStoreForTests()
    store.record(undefined)
    store.record(null as unknown as SDKRateLimitInfo)
    store.record("nope" as unknown as SDKRateLimitInfo)
    expect(store.size).toBe(0)
  })

  it("stamps observedAt on each record", () => {
    const store = new _RateLimitStoreForTests()
    const before = Date.now()
    store.record(FIVE_HOUR)
    const after = Date.now()
    const entry = store.get("five_hour")
    expect(entry?.observedAt).toBeGreaterThanOrEqual(before)
    expect(entry?.observedAt).toBeLessThanOrEqual(after)
  })

  it("getAll returns entries newest-first by observedAt", async () => {
    const store = new _RateLimitStoreForTests()
    store.record(FIVE_HOUR)
    // Force monotonic observedAt — Bun's `Date.now()` resolution is fine here.
    await Bun.sleep(2)
    store.record(SEVEN_DAY)
    // Compare the mapped sequence rather than indexing into the array directly
    // so the test stays under TypeScript's `noUncheckedIndexedAccess` strict
    // mode (which CI's `tsc --noEmit` enforces but Bun's lenient default tsc
    // does not).
    const orderedTypes = store.getAll().map(e => e.rateLimitType)
    expect(orderedTypes).toEqual(["seven_day", "five_hour"])
  })

  it("clear() empties the store", () => {
    const store = new _RateLimitStoreForTests()
    store.record(FIVE_HOUR)
    store.record(SEVEN_DAY)
    store.clear()
    expect(store.size).toBe(0)
    expect(store.getAll()).toEqual([])
  })

  it("preserves all SDKRateLimitInfo fields verbatim", () => {
    const store = new _RateLimitStoreForTests()
    const full: SDKRateLimitInfo = {
      status: "allowed_warning",
      rateLimitType: "overage",
      utilization: 0.78,
      resetsAt: 1_730_000_000_000,
      overageStatus: "allowed",
      overageResetsAt: 1_730_100_000_000,
      isUsingOverage: true,
      surpassedThreshold: 0.75,
      overageDisabledReason: "no_limits_configured",
    }
    store.record(full)
    const got = store.get("overage")
    expect(got).toMatchObject(full)
  })
})
