/**
 * Unit tests for filterBetasForProfile.
 *
 * Pure function, no mocks required.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  filterBetasForProfile,
  BILLABLE_BETA_PREFIXES_ON_MAX,
  getBetaPolicyFromEnv,
  DEFAULT_BETA_POLICY,
} from "../proxy/betas"

describe("filterBetasForProfile", () => {
  describe("empty / undefined input", () => {
    it("returns no forwarded betas for undefined header", () => {
      const result = filterBetasForProfile(undefined, "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([])
    })

    it("returns no forwarded betas for empty string", () => {
      const result = filterBetasForProfile("", "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([])
    })

    it("returns no forwarded betas for whitespace-only string", () => {
      const result = filterBetasForProfile("   ,  ,", "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([])
    })
  })

  describe("api profile — pass-through", () => {
    it("forwards a single beta", () => {
      const result = filterBetasForProfile("context-1m-2025-08-07", "api")
      expect(result.forwarded).toEqual(["context-1m-2025-08-07"])
      expect(result.stripped).toEqual([])
    })

    it("forwards all betas unchanged, including billable ones", () => {
      const result = filterBetasForProfile(
        "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07",
        "api",
      )
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "extended-cache-ttl-2025-04-11",
        "context-1m-2025-08-07",
      ])
      expect(result.stripped).toEqual([])
    })

    it("trims whitespace", () => {
      const result = filterBetasForProfile(
        "  prompt-caching-2024-07-31 ,  context-1m-2025-08-07  ",
        "api",
      )
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "context-1m-2025-08-07",
      ])
    })
  })

  describe("claude-max profile — selective stripping", () => {
    it("forwards prompt-caching beta (GA, free on Max)", () => {
      const result = filterBetasForProfile("prompt-caching-2024-07-31", "claude-max")
      expect(result.forwarded).toEqual(["prompt-caching-2024-07-31"])
      expect(result.stripped).toEqual([])
    })

    it("forwards context-1m beta (included in Max for Opus)", () => {
      const result = filterBetasForProfile("context-1m-2025-08-07", "claude-max")
      expect(result.forwarded).toEqual(["context-1m-2025-08-07"])
      expect(result.stripped).toEqual([])
    })

    it("forwards interleaved-thinking beta (free on Max)", () => {
      const result = filterBetasForProfile("interleaved-thinking-2025-05-14", "claude-max")
      expect(result.forwarded).toEqual(["interleaved-thinking-2025-05-14"])
      expect(result.stripped).toEqual([])
    })

    it("forwards fine-grained-tool-streaming beta (free on Max)", () => {
      const result = filterBetasForProfile("fine-grained-tool-streaming-2025-05-14", "claude-max")
      expect(result.forwarded).toEqual(["fine-grained-tool-streaming-2025-05-14"])
      expect(result.stripped).toEqual([])
    })

    it("strips extended-cache-ttl beta (billable on Max)", () => {
      const result = filterBetasForProfile("extended-cache-ttl-2025-04-11", "claude-max")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual(["extended-cache-ttl-2025-04-11"])
    })

    it("forwards safe betas while stripping billable ones from a mixed list", () => {
      const result = filterBetasForProfile(
        "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07",
        "claude-max",
      )
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "context-1m-2025-08-07",
      ])
      expect(result.stripped).toEqual(["extended-cache-ttl-2025-04-11"])
    })

    it("returns undefined forwarded when all betas are billable", () => {
      const result = filterBetasForProfile(
        "extended-cache-ttl-2025-04-11, extended-cache-ttl-2026-01-01",
        "claude-max",
      )
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([
        "extended-cache-ttl-2025-04-11",
        "extended-cache-ttl-2026-01-01",
      ])
    })

    it("forwards unknown betas (conservative default: allow through)", () => {
      const result = filterBetasForProfile("some-future-beta-2030-01-01", "claude-max")
      expect(result.forwarded).toEqual(["some-future-beta-2030-01-01"])
      expect(result.stripped).toEqual([])
    })

    it("trims whitespace and drops empty entries", () => {
      const result = filterBetasForProfile(
        ",,  prompt-caching-2024-07-31 , ,  context-1m-2025-08-07  ,",
        "claude-max",
      )
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "context-1m-2025-08-07",
      ])
      expect(result.stripped).toEqual([])
    })
  })

  describe("billable prefix list", () => {
    it("includes extended-cache-ttl-", () => {
      expect(BILLABLE_BETA_PREFIXES_ON_MAX).toContain("extended-cache-ttl-")
    })

    it("is a readonly array (type-level)", () => {
      // Compile-time: readonly string[] cannot be mutated.
      // Runtime: just verify it has entries.
      expect(BILLABLE_BETA_PREFIXES_ON_MAX.length).toBeGreaterThan(0)
    })
  })

  describe("policy: strip-all", () => {
    const MIXED = "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07"

    it("strips all betas for claude-max regardless of billable status", () => {
      const result = filterBetasForProfile(MIXED, "claude-max", "strip-all")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual([
        "prompt-caching-2024-07-31",
        "extended-cache-ttl-2025-04-11",
        "context-1m-2025-08-07",
      ])
    })

    it("strips free betas for claude-max under strip-all", () => {
      const result = filterBetasForProfile("prompt-caching-2024-07-31", "claude-max", "strip-all")
      expect(result.forwarded).toBeUndefined()
      expect(result.stripped).toEqual(["prompt-caching-2024-07-31"])
    })

    it("still forwards everything for api profile even under strip-all", () => {
      const result = filterBetasForProfile(MIXED, "api", "strip-all")
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "extended-cache-ttl-2025-04-11",
        "context-1m-2025-08-07",
      ])
      expect(result.stripped).toEqual([])
    })
  })

  describe("policy: allow-all", () => {
    const MIXED = "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11, context-1m-2025-08-07"

    it("forwards all betas for claude-max including billable ones", () => {
      const result = filterBetasForProfile(MIXED, "claude-max", "allow-all")
      expect(result.forwarded).toEqual([
        "prompt-caching-2024-07-31",
        "extended-cache-ttl-2025-04-11",
        "context-1m-2025-08-07",
      ])
      expect(result.stripped).toEqual([])
    })

    it("forwards billable beta alone for claude-max under allow-all", () => {
      const result = filterBetasForProfile("extended-cache-ttl-2025-04-11", "claude-max", "allow-all")
      expect(result.forwarded).toEqual(["extended-cache-ttl-2025-04-11"])
      expect(result.stripped).toEqual([])
    })
  })

  describe("policy: allow-safe (default)", () => {
    it("matches the default behaviour when no policy is passed", () => {
      const implicitResult = filterBetasForProfile(
        "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11",
        "claude-max",
      )
      const explicitResult = filterBetasForProfile(
        "prompt-caching-2024-07-31, extended-cache-ttl-2025-04-11",
        "claude-max",
        "allow-safe",
      )
      expect(implicitResult).toEqual(explicitResult)
    })
  })
})

describe("getBetaPolicyFromEnv", () => {
  const ORIGINAL = process.env.MERIDIAN_BETA_POLICY

  beforeEach(() => {
    delete process.env.MERIDIAN_BETA_POLICY
  })

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.MERIDIAN_BETA_POLICY
    } else {
      process.env.MERIDIAN_BETA_POLICY = ORIGINAL
    }
  })

  it("returns the default policy when env var is unset", () => {
    expect(getBetaPolicyFromEnv()).toBe(DEFAULT_BETA_POLICY)
    expect(DEFAULT_BETA_POLICY).toBe("allow-safe")
  })

  it("returns 'allow-safe' when explicitly set", () => {
    process.env.MERIDIAN_BETA_POLICY = "allow-safe"
    expect(getBetaPolicyFromEnv()).toBe("allow-safe")
  })

  it("returns 'strip-all' when env var is 'strip-all'", () => {
    process.env.MERIDIAN_BETA_POLICY = "strip-all"
    expect(getBetaPolicyFromEnv()).toBe("strip-all")
  })

  it("returns 'allow-all' when env var is 'allow-all'", () => {
    process.env.MERIDIAN_BETA_POLICY = "allow-all"
    expect(getBetaPolicyFromEnv()).toBe("allow-all")
  })

  it("falls back to default for invalid values", () => {
    process.env.MERIDIAN_BETA_POLICY = "yolo"
    expect(getBetaPolicyFromEnv()).toBe(DEFAULT_BETA_POLICY)
  })

  it("falls back to default for empty string", () => {
    process.env.MERIDIAN_BETA_POLICY = ""
    expect(getBetaPolicyFromEnv()).toBe(DEFAULT_BETA_POLICY)
  })

  it("is case-sensitive (does not accept 'STRIP-ALL')", () => {
    process.env.MERIDIAN_BETA_POLICY = "STRIP-ALL"
    expect(getBetaPolicyFromEnv()).toBe(DEFAULT_BETA_POLICY)
  })
})
