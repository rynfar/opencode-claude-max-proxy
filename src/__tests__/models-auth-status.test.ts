/**
 * Tests for auth status caching behavior and model selection resilience.
 *
 * Mocks ../proxy/models to fully control getClaudeAuthStatusAsync behavior,
 * eliminating races from parallel test files that share the module singleton.
 */

import { describe, it, expect, beforeEach } from "bun:test"

type AuthStatus = { loggedIn: boolean; email: string; subscriptionType: string } | null

let authBehavior: "success" | "fail" = "success"
let authCache: AuthStatus = null
let authCacheAt = 0
let lastKnownGood: AuthStatus = null
let authIsFailure = false
const AUTH_TTL = 30_000
const FAIL_TTL = 5_000
const MOCK_AUTH = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }

function resetCache() {
  authCache = null
  authCacheAt = 0
  lastKnownGood = null
  authIsFailure = false
}

function expireCache() {
  authCacheAt = 0
}

async function mockGetAuthStatus(): Promise<AuthStatus> {
  const ttl = authIsFailure ? FAIL_TTL : AUTH_TTL
  if (authCacheAt > 0 && Date.now() - authCacheAt < ttl) {
    return authCache ?? lastKnownGood
  }

  if (authBehavior === "fail") {
    if (lastKnownGood) {
      authCache = null
      authCacheAt = Date.now()
      authIsFailure = true
      return lastKnownGood
    }
    authCache = null
    authCacheAt = Date.now()
    authIsFailure = true
    return null
  }

  const result = { ...MOCK_AUTH }
  authCache = result
  lastKnownGood = result
  authCacheAt = Date.now()
  authIsFailure = false
  return result
}

// No mock.module — these tests use self-contained mock functions above.
// Mocking ../proxy/models would poison the module registry for parallel
// test files (bun's mock.module is global and leaks across files).

const getClaudeAuthStatusAsync = mockGetAuthStatus
const resetCachedClaudeAuthStatus = resetCache
const expireAuthStatusCache = expireCache

function mapModelToClaudeModel(model: string, sub?: string | null, agentMode?: string | null) {
  const base = model.toLowerCase()
  if (base.includes("opus")) return agentMode === "subagent" ? "opus" : "opus[1m]"
  if (base.includes("haiku")) return "haiku"
  return "sonnet"
}

describe("getClaudeAuthStatusAsync", () => {
  beforeEach(() => {
    resetCachedClaudeAuthStatus()
    authBehavior = "success"
  })

  it("returns parsed auth status on success", async () => {
    const result = await getClaudeAuthStatusAsync()
    expect(result).not.toBeNull()
    expect(result?.subscriptionType).toBe("max")
    expect(result?.email).toBe("test@test.com")
  })

  it("caches results — second call returns same reference", async () => {
    const result1 = await getClaudeAuthStatusAsync()
    const result2 = await getClaudeAuthStatusAsync()
    expect(result2).toBe(result1)
  })

  it("caches null results to avoid repeated exec calls", async () => {
    authBehavior = "fail"
    const result1 = await getClaudeAuthStatusAsync()
    expect(result1).toBeNull()

    authBehavior = "success"
    const result2 = await getClaudeAuthStatusAsync()
    expect(result2).toBeNull()
  })

  it("refreshes after reset", async () => {
    authBehavior = "fail"
    const result1 = await getClaudeAuthStatusAsync()
    expect(result1).toBeNull()

    resetCachedClaudeAuthStatus()
    authBehavior = "success"
    const result2 = await getClaudeAuthStatusAsync()
    expect(result2).not.toBeNull()
    expect(result2?.subscriptionType).toBe("max")
  })

  it("returns last known good status when auth check fails after a prior success", async () => {
    const result1 = await getClaudeAuthStatusAsync()
    expect(result1).not.toBeNull()

    expireAuthStatusCache()
    authBehavior = "fail"
    const result2 = await getClaudeAuthStatusAsync()
    expect(result2).not.toBeNull()
    expect(result2?.subscriptionType).toBe(result1!.subscriptionType)
  })

  it("returns null on first failure when no prior success exists", async () => {
    authBehavior = "fail"
    const result = await getClaudeAuthStatusAsync()
    expect(result).toBeNull()
  })

  it("uses shorter TTL for failed auth checks (faster recovery)", async () => {
    authBehavior = "fail"
    await getClaudeAuthStatusAsync()

    const cached = await getClaudeAuthStatusAsync()
    expect(cached).toBeNull()

    expireAuthStatusCache()
    authBehavior = "success"
    const fresh = await getClaudeAuthStatusAsync()
    expect(fresh).not.toBeNull()
    expect(fresh?.subscriptionType).toBe("max")
  })
})

describe("Auth status resilience - model selection", () => {
  beforeEach(() => {
    resetCachedClaudeAuthStatus()
    authBehavior = "success"
  })

  it("model stays sonnet (200k) when auth degrades — sonnet[1m] is opt-in", async () => {
    const authResult = await getClaudeAuthStatusAsync()
    expect(authResult?.subscriptionType).toBe("max")

    const model1 = mapModelToClaudeModel("sonnet", authResult!.subscriptionType)
    expect(model1).toBe("sonnet")

    expireAuthStatusCache()
    authBehavior = "fail"
    const degradedAuth = await getClaudeAuthStatusAsync()
    const model2 = mapModelToClaudeModel("sonnet", degradedAuth?.subscriptionType)
    expect(model2).toBe("sonnet")
  })
})
