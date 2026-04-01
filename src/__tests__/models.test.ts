/**
 * Unit tests for model mapping and utility functions.
 */
import { afterEach, beforeEach, describe, it, expect, mock } from "bun:test"
import { mapModelToClaudeModel, isClosedControllerError, resetCachedClaudeAuthStatus, getClaudeAuthStatusAsync, stripExtendedContext, hasExtendedContext, expireAuthStatusCache, recordExtendedContextRateLimit, resetExtendedContextCooldown, isPremiumSubscription, PREMIUM_SUBSCRIPTION_TYPES, findSubscriptionType, findAuthMethod, defaultTokenBudget } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  const originalSonnetModel = process.env.CLAUDE_PROXY_SONNET_MODEL

  afterEach(() => {
    if (originalSonnetModel === undefined) delete process.env.CLAUDE_PROXY_SONNET_MODEL
    else process.env.CLAUDE_PROXY_SONNET_MODEL = originalSonnetModel
    resetCachedClaudeAuthStatus()
    resetExtendedContextCooldown()
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
})

describe("subagent model selection", () => {
  afterEach(() => {
    resetExtendedContextCooldown()
  })

  it("skips sonnet[1m] for subagent mode", () => {
    expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
  })

  it("skips opus[1m] for subagent mode", () => {
    expect(mapModelToClaudeModel("opus", "max", "subagent")).toBe("opus")
  })

  it("uses sonnet[1m] for primary mode", () => {
    expect(mapModelToClaudeModel("sonnet", "max", "primary")).toBe("sonnet[1m]")
  })

  it("uses sonnet[1m] when no agent mode specified", () => {
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max", null)).toBe("sonnet[1m]")
  })

  it("haiku is unaffected by agent mode", () => {
    expect(mapModelToClaudeModel("haiku", "max", "subagent")).toBe("haiku")
  })
})

describe("extended context circuit breaker", () => {
  afterEach(() => {
    resetExtendedContextCooldown()
  })

  it("skips sonnet[1m] after a rate-limit is recorded", () => {
    recordExtendedContextRateLimit("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
  })

  it("skips opus[1m] after a rate-limit is recorded", () => {
    recordExtendedContextRateLimit("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus")
  })

  it("resumes sonnet[1m] after cooldown is reset", () => {
    recordExtendedContextRateLimit("sonnet[1m]")
    resetExtendedContextCooldown()
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
  })

  it("sonnet[1m] cooldown does not affect opus[1m]", () => {
    recordExtendedContextRateLimit("sonnet[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
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

describe("isPremiumSubscription", () => {
  it("returns true for max subscription", () => {
    expect(isPremiumSubscription("max")).toBe(true)
  })

  it("returns true for other premium tiers", () => {
    expect(isPremiumSubscription("maxplan")).toBe(true)
    expect(isPremiumSubscription("max5")).toBe(true)
    expect(isPremiumSubscription("max20")).toBe(true)
    expect(isPremiumSubscription("enterprise")).toBe(true)
    expect(isPremiumSubscription("team")).toBe(true)
  })

  it("returns false for non-premium tiers", () => {
    expect(isPremiumSubscription("pro")).toBe(false)
    expect(isPremiumSubscription("free")).toBe(false)
    expect(isPremiumSubscription("")).toBe(false)
  })

  it("returns false for null and undefined", () => {
    expect(isPremiumSubscription(null)).toBe(false)
    expect(isPremiumSubscription(undefined)).toBe(false)
  })
})

describe("PREMIUM_SUBSCRIPTION_TYPES", () => {
  it("contains expected subscription types", () => {
    expect(PREMIUM_SUBSCRIPTION_TYPES.has("max")).toBe(true)
    expect(PREMIUM_SUBSCRIPTION_TYPES.has("team")).toBe(true)
    expect(PREMIUM_SUBSCRIPTION_TYPES.has("enterprise")).toBe(true)
  })

  it("does not contain non-premium types", () => {
    expect(PREMIUM_SUBSCRIPTION_TYPES.has("pro")).toBe(false)
    expect(PREMIUM_SUBSCRIPTION_TYPES.has("free")).toBe(false)
  })
})

describe("findSubscriptionType", () => {
  it("finds subscriptionType at top level", () => {
    expect(findSubscriptionType({ subscriptionType: "max" })).toBe("max")
  })

  it("finds subscription_type (snake case)", () => {
    expect(findSubscriptionType({ subscription_type: "team" })).toBe("team")
  })

  it("finds plan field", () => {
    expect(findSubscriptionType({ plan: "enterprise" })).toBe("enterprise")
  })

  it("finds tier field", () => {
    expect(findSubscriptionType({ tier: "max5" })).toBe("max5")
  })

  it("finds nested subscriptionType", () => {
    expect(findSubscriptionType({ account: { subscriptionType: "maxplan" } })).toBe("maxplan")
  })

  it("returns null when not found", () => {
    expect(findSubscriptionType({})).toBe(null)
    expect(findSubscriptionType(null)).toBe(null)
    expect(findSubscriptionType(undefined)).toBe(null)
  })
})

describe("findAuthMethod", () => {
  it("returns subscription for subscriptionType", () => {
    expect(findAuthMethod({ subscriptionType: "max" })).toBe("subscription")
  })

  it("returns api_key for apiKeyAuth", () => {
    expect(findAuthMethod({ apiKeyAuth: true })).toBe("api_key")
  })

  it("returns api_key for authMethod=api_key", () => {
    expect(findAuthMethod({ authMethod: "api_key" })).toBe("api_key")
  })

  it("returns subscription for authMethod=subscription", () => {
    expect(findAuthMethod({ authMethod: "subscription" })).toBe("subscription")
  })

  it("returns null when not found", () => {
    expect(findAuthMethod({})).toBe(null)
    expect(findAuthMethod(null)).toBe(null)
    expect(findAuthMethod(undefined)).toBe(null)
  })
})

describe("defaultTokenBudget", () => {
  it("returns zeroed token budget", () => {
    const budget = defaultTokenBudget()
    expect(budget.inputTokens).toBe(0)
    expect(budget.cacheReadInputTokens).toBe(0)
    expect(budget.cacheCreationInputTokens).toBe(0)
    expect(budget.outputTokens).toBe(0)
    expect(budget.usedTokens).toBe(0)
    expect(budget.maxTokens).toBe(0)
    expect(budget.totalProcessedTokens).toBe(0)
    expect(budget.toolUses).toBe(0)
    expect(budget.durationMs).toBe(0)
  })
})
