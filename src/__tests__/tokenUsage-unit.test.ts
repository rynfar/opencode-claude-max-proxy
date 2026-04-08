/**
 * Unit tests for the pure token-usage helpers extracted from server.ts.
 *
 * These cover the cache-hit-rate denominator fix: `input_tokens` from the SDK
 * reports only the non-cached portion, so the real total input size is
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 * The previous `logUsage` implementation divided by `input_tokens` alone,
 * producing absurdities like `cache=2600000%` whenever a cache hit occurred.
 */

import { describe, it, expect } from "bun:test"
import { computeCacheHitRate, formatUsageSummary, formatTokenCount } from "../proxy/tokenUsage"
import type { TokenUsage } from "../proxy/session/lineage"

describe("computeCacheHitRate", () => {
  it("returns undefined for undefined usage", () => {
    expect(computeCacheHitRate(undefined)).toBeUndefined()
  })

  it("returns undefined when all token counts are zero", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    expect(computeCacheHitRate(usage)).toBeUndefined()
  })

  it("returns 0 for a fresh request with no caching activity", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    expect(computeCacheHitRate(usage)).toBe(0)
  })

  it("returns 0 on cache-creation-only turn (no reads yet)", () => {
    // Turn 1 of a new session: the SDK writes cache but can't read from it.
    const usage: TokenUsage = {
      input_tokens: 10,
      output_tokens: 8,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 59_000,
    }
    expect(computeCacheHitRate(usage)).toBe(0)
  })

  it("uses (uncached + read + creation) as the denominator, not input_tokens alone", () => {
    // This is the steady-state cache hit case that the old logUsage formula
    // blew past 100% on: input_tokens=3, cache_read=71k, cache_write=2k.
    // Old formula: 71000 / 3 = 23666.67 → displayed as "cache=2366667%".
    // Correct:    71000 / (3 + 71000 + 2000) ≈ 0.9726
    const usage: TokenUsage = {
      input_tokens: 3,
      output_tokens: 416,
      cache_read_input_tokens: 71_000,
      cache_creation_input_tokens: 2_000,
    }
    const rate = computeCacheHitRate(usage)
    expect(rate).toBeDefined()
    expect(rate! * 100).toBeCloseTo(97.26, 1)
    expect(rate!).toBeGreaterThan(0)
    expect(rate!).toBeLessThanOrEqual(1)
  })

  it("returns 1.0 (100%) when every input token came from cache", () => {
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 5,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 0,
    }
    expect(computeCacheHitRate(usage)).toBe(1)
  })

  it("is capped at 1.0 for all realistic inputs", () => {
    // Property: the returned ratio is always in [0, 1].
    const cases: TokenUsage[] = [
      { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 999_999, cache_creation_input_tokens: 0 },
      { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_000 },
      { input_tokens: 500_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ]
    for (const u of cases) {
      const rate = computeCacheHitRate(u)!
      expect(rate).toBeGreaterThanOrEqual(0)
      expect(rate).toBeLessThanOrEqual(1)
    }
  })

  it("tolerates missing optional fields by treating them as zero", () => {
    const usage = { input_tokens: 1000, output_tokens: 50 } as TokenUsage
    expect(computeCacheHitRate(usage)).toBe(0)
  })
})

describe("formatTokenCount", () => {
  it("prints small values as exact integers", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(3)).toBe("3")
    expect(formatTokenCount(847)).toBe("847")
    expect(formatTokenCount(1000)).toBe("1000")
  })

  it("rounds values above 1000 to nearest thousand with k suffix", () => {
    expect(formatTokenCount(1001)).toBe("1k")
    expect(formatTokenCount(1500)).toBe("2k")
    expect(formatTokenCount(71_000)).toBe("71k")
    expect(formatTokenCount(1_234_567)).toBe("1235k")
  })
})

describe("formatUsageSummary", () => {
  it("produces the steady-state cache-hit line with the correct percentage", () => {
    const usage: TokenUsage = {
      input_tokens: 3,
      output_tokens: 416,
      cache_read_input_tokens: 71_000,
      cache_creation_input_tokens: 2_000,
    }
    // The old logUsage produced "cache=2366667%". The new one must produce
    // a two-digit percentage in the 90s.
    const out = formatUsageSummary(usage)
    expect(out).toContain("input=3")
    expect(out).toContain("output=416")
    expect(out).toContain("cache_read=71k")
    expect(out).toContain("cache_write=2k")
    expect(out).toMatch(/cache=9[0-9]%/)
  })

  it("omits cache_read when zero but still prints cache_write", () => {
    // Turn 1 of a new session: the SDK writes cache but no reads yet.
    const usage: TokenUsage = {
      input_tokens: 10,
      output_tokens: 8,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 59_000,
    }
    const out = formatUsageSummary(usage)
    expect(out).toContain("input=10")
    expect(out).toContain("cache_write=59k")
    expect(out).not.toContain("cache_read=")
    expect(out).toContain("cache=0%")
  })

  it("omits cache_write when zero but still prints cache_read", () => {
    const usage: TokenUsage = {
      input_tokens: 3,
      output_tokens: 100,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 0,
    }
    const out = formatUsageSummary(usage)
    expect(out).toContain("cache_read=80k")
    expect(out).not.toContain("cache_write=")
    expect(out).toMatch(/cache=9[0-9]%|cache=100%/)
  })

  it("omits both cache fields when there is no caching activity", () => {
    const usage: TokenUsage = {
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    const out = formatUsageSummary(usage)
    expect(out).toContain("input=1000")
    expect(out).toContain("output=50")
    expect(out).not.toContain("cache_read=")
    expect(out).not.toContain("cache_write=")
    expect(out).toContain("cache=0%")
  })

  it("suppresses the cache= tag entirely when there is no input data at all", () => {
    // computeCacheHitRate returns undefined for total=0, so formatUsageSummary
    // must not emit a misleading "cache=NaN%" or "cache=0%".
    const usage: TokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    const out = formatUsageSummary(usage)
    expect(out).toContain("input=0")
    expect(out).toContain("output=0")
    expect(out).not.toContain("cache=")
  })

  it("never emits a percentage over 100%", () => {
    // Regression guard for the original bug. The old formula divided
    // cache_read by input_tokens, which produced values like 2,600,000%
    // when the user message was only 3 tokens and cache_read was 78k.
    const usage: TokenUsage = {
      input_tokens: 3,
      output_tokens: 598,
      cache_read_input_tokens: 78_000,
      cache_creation_input_tokens: 6_000,
    }
    const out = formatUsageSummary(usage)
    const match = out.match(/cache=(\d+)%/)
    if (!match) throw new Error(`expected cache=N% tag, got: ${out}`)
    const percent = Number.parseInt(match[1] ?? "", 10)
    expect(percent).toBeLessThanOrEqual(100)
    expect(percent).toBeGreaterThanOrEqual(0)
  })
})
