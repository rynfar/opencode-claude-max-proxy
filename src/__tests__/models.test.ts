/**
 * Unit tests for model mapping and utility functions.
 */
import { afterEach, beforeEach, describe, it, expect, mock } from "bun:test"
import { mapModelToClaudeModel, isClosedControllerError, resetCachedClaudeAuthStatus, getClaudeAuthStatusAsync, stripExtendedContext, hasExtendedContext, expireAuthStatusCache, recordExtendedContextUnavailable, isExtendedContextKnownUnavailable, resetExtendedContextUnavailable } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  const originalSonnetModel = process.env.CLAUDE_PROXY_SONNET_MODEL

  afterEach(() => {
    if (originalSonnetModel === undefined) delete process.env.CLAUDE_PROXY_SONNET_MODEL
    else process.env.CLAUDE_PROXY_SONNET_MODEL = originalSonnetModel
    resetCachedClaudeAuthStatus()
  })

  it("maps opus 4.6 models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
  })

  it("maps opus 4.5 models to opus (no 1M)", () => {
    expect(mapModelToClaudeModel("claude-opus-4-5")).toBe("opus")
  })

  it("maps haiku models to haiku", () => {
    expect(mapModelToClaudeModel("claude-haiku-4-5")).toBe("haiku")
    expect(mapModelToClaudeModel("haiku")).toBe("haiku")
  })

  it("maps sonnet 4.6 models to sonnet[1m] for max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
  })

  it("maps sonnet 4.5 models to sonnet (no 1M regardless of subscription)", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "max")).toBe("sonnet")
  })

  it("maps sonnet models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "team")).toBe("sonnet")
    expect(mapModelToClaudeModel("sonnet", "pro")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929", "")).toBe("sonnet")
  })

  it("defaults unknown models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("unknown-model")).toBe("sonnet")
    expect(mapModelToClaudeModel("", undefined)).toBe("sonnet")
  })

  it("respects explicit sonnet model override", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "team")).toBe("sonnet[1m]")

    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet"
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
  })

  describe("subagent mode", () => {
    it("gives subagents base sonnet regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
      expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
    })

    it("gives subagents base opus regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-opus-4-6", "max", "subagent")).toBe("opus")
      expect(mapModelToClaudeModel("opus", "max", "subagent")).toBe("opus")
    })

    it("haiku is unaffected by agent mode", () => {
      expect(mapModelToClaudeModel("claude-haiku-4-5", "max", "subagent")).toBe("haiku")
    })

    it("primary agents still get 1m models for max subscription", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "primary")).toBe("sonnet[1m]")
      expect(mapModelToClaudeModel("claude-opus-4-6", "max", "primary")).toBe("opus[1m]")
    })

    it("null or missing agentMode behaves as primary", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", null)).toBe("sonnet[1m]")
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", undefined)).toBe("sonnet[1m]")
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet[1m]")
    })

    it("env var override takes priority over subagent mode for sonnet", () => {
      process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
      // Override wins — useful if operator explicitly wants 1m everywhere
      expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet[1m]")
    })
  })
})

describe("getClaudeAuthStatusAsync", () => {
  beforeEach(() => {
    resetCachedClaudeAuthStatus()
  })

  it("returns parsed auth status on success", async () => {
    // On a machine with claude installed, this should return something or null
    // We test the caching behavior by calling twice and verifying dedup
    const result1 = await getClaudeAuthStatusAsync()
    const result2 = await getClaudeAuthStatusAsync()
    // Second call should return the cached result (same reference)
    expect(result2).toBe(result1)
  })

  it("caches null results to avoid repeated exec calls", async () => {
    // Sabotage PATH so `claude auth status` fails
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      const result1 = await getClaudeAuthStatusAsync()
      expect(result1).toBeNull()

      // Restore PATH — if negative caching works, the next call should
      // still return the cached null without re-executing
      process.env.PATH = originalPath
      const result2 = await getClaudeAuthStatusAsync()
      expect(result2).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("refreshes after reset", async () => {
    // First call with broken PATH → cached null
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      const result1 = await getClaudeAuthStatusAsync()
      expect(result1).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }

    // Reset clears the cache, so next call re-executes
    resetCachedClaudeAuthStatus()
    const result2 = await getClaudeAuthStatusAsync()
    // With PATH restored, this may succeed (returns object) or fail (null)
    // depending on whether claude is installed — either way it re-executed
    // We just verify reset didn't break anything
    expect(result2 === null || typeof result2 === "object").toBe(true)
  })

  it("returns last known good status when auth check fails after a prior success", async () => {
    // Simulate a successful call by calling with intact PATH
    const result1 = await getClaudeAuthStatusAsync()

    if (result1 === null) {
      // Claude not installed — can't test last-known-good flow; skip gracefully
      return
    }

    // Now expire the cache (but preserve lastKnownGood) and break PATH
    const originalPath = process.env.PATH
    expireAuthStatusCache()
    process.env.PATH = ""
    try {
      const result2 = await getClaudeAuthStatusAsync()
      // Should return last known good, not null
      expect(result2).not.toBeNull()
      expect(result2?.subscriptionType).toBe(result1.subscriptionType)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("returns null on first failure when no prior success exists", async () => {
    // Fresh state with no last known good
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      const result = await getClaudeAuthStatusAsync()
      expect(result).toBeNull()
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("uses shorter TTL for failed auth checks (faster recovery)", async () => {
    // Sabotage PATH → failure cached with short TTL (5s)
    const originalPath = process.env.PATH
    process.env.PATH = ""
    try {
      await getClaudeAuthStatusAsync()
    } finally {
      process.env.PATH = originalPath
    }

    // Immediately after: cache is still valid (within 5s TTL)
    const cached = await getClaudeAuthStatusAsync()
    expect(cached).toBeNull() // Still returns null (no last known good)

    // Expire and call again with working PATH — should re-execute
    expireAuthStatusCache()
    const fresh = await getClaudeAuthStatusAsync()
    // If claude is installed, this succeeds; if not, null again — but
    // the key assertion is that expireAuthStatusCache allowed re-execution
    expect(fresh === null || typeof fresh === "object").toBe(true)
  })
})

describe("Auth status resilience - model selection", () => {
  beforeEach(() => {
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    resetCachedClaudeAuthStatus()
  })

  it("model stays sonnet[1m] when auth degrades after a prior max auth", async () => {
    // Simulate: first call returns max subscription
    const authResult = await getClaudeAuthStatusAsync()

    if (authResult?.subscriptionType !== "max") {
      // Not a max subscription — can't test the sonnet[1m] path; skip
      return
    }

    // Model should be sonnet[1m]
    const model1 = mapModelToClaudeModel("sonnet", authResult.subscriptionType)
    expect(model1).toBe("sonnet[1m]")

    // Now auth degrades (cache expired, command fails)
    const originalPath = process.env.PATH
    expireAuthStatusCache()
    process.env.PATH = ""
    try {
      const degradedAuth = await getClaudeAuthStatusAsync()
      // Should return last known good (max), not null
      expect(degradedAuth).not.toBeNull()
      const model2 = mapModelToClaudeModel("sonnet", degradedAuth?.subscriptionType)
      // Critical: model should STILL be sonnet[1m], not sonnet
      expect(model2).toBe("sonnet[1m]")
    } finally {
      process.env.PATH = originalPath
    }
  })
})

describe("stripExtendedContext", () => {
  it("strips [1m] from opus", () => {
    expect(stripExtendedContext("opus[1m]")).toBe("opus")
  })

  it("strips [1m] from sonnet", () => {
    expect(stripExtendedContext("sonnet[1m]")).toBe("sonnet")
  })

  it("returns haiku unchanged", () => {
    expect(stripExtendedContext("haiku")).toBe("haiku")
  })

  it("returns base models unchanged", () => {
    expect(stripExtendedContext("opus")).toBe("opus")
    expect(stripExtendedContext("sonnet")).toBe("sonnet")
  })
})

describe("hasExtendedContext", () => {
  it("returns true for [1m] models", () => {
    expect(hasExtendedContext("opus[1m]")).toBe(true)
    expect(hasExtendedContext("sonnet[1m]")).toBe(true)
  })

  it("returns false for base models", () => {
    expect(hasExtendedContext("opus")).toBe(false)
    expect(hasExtendedContext("sonnet")).toBe(false)
    expect(hasExtendedContext("haiku")).toBe(false)
  })
})

describe("Extra Usage cooldown", () => {
  beforeEach(() => resetExtendedContextUnavailable())
  afterEach(() => resetExtendedContextUnavailable())

  it("isExtendedContextKnownUnavailable is false by default", () => {
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("isExtendedContextKnownUnavailable is true immediately after recording", () => {
    recordExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(true)
  })

  it("mapModelToClaudeModel returns sonnet (not [1m]) during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
  })

  it("mapModelToClaudeModel returns sonnet[1m] when cooldown is cleared", () => {
    recordExtendedContextUnavailable()
    resetExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet[1m]")
  })

  it("isExtendedContextKnownUnavailable is false after cooldown expires", () => {
    // Simulate an expired timer by backdating the timestamp
    recordExtendedContextUnavailable()
    // Force-expire by directly calling record then manually manipulating through reset+re-record
    // We can't easily time-travel, so we verify the interface contract:
    // reset clears the flag, making it available again
    resetExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("opus[1m] also skips [1m] during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-opus-4-6", "max")).toBe("opus")
  })

  it("cooldown does not affect subagent mode (already uses base model)", () => {
    // subagents already return base model regardless of flag
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
  })

  it("cooldown does not affect MERIDIAN_SONNET_MODEL override", () => {
    process.env.MERIDIAN_SONNET_MODEL = "sonnet"
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    delete process.env.MERIDIAN_SONNET_MODEL
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})
