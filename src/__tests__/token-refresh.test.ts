/**
 * Unit tests for tokenRefresh.
 *
 * The credential store is injected so tests are platform-agnostic — no fs
 * or child_process mocking required. Network (fetch) is swapped via
 * globalThis.fetch.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import type { CredentialStore } from "../proxy/tokenRefresh"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "old-access-token",
    refreshToken: "the-refresh-token",
    expiresAt: Date.now() - 1000,
    scopes: ["openid", "profile"],
    subscriptionType: "max",
    rateLimitTier: "standard",
  },
  extraField: "keep-me",
}

const MOCK_TOKEN_RESPONSE = {
  access_token: "new-access-token",
  refresh_token: "new-refresh-token",
  expires_in: 3600,
}

function makeSuccessResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

// ---------------------------------------------------------------------------
// In-memory credential store
// ---------------------------------------------------------------------------

function makeStore(initial: typeof MOCK_CREDENTIALS | null = MOCK_CREDENTIALS) {
  let stored = initial ? JSON.parse(JSON.stringify(initial)) : null
  const writes: string[] = []

  const store: CredentialStore = {
    async read() { return stored },
    async write(credentials) {
      stored = credentials
      writes.push(JSON.stringify(credentials))
      return true
    },
  }

  return { store, writes, getStored: () => stored }
}

function makeFailingWriteStore() {
  const store: CredentialStore = {
    async read() { return JSON.parse(JSON.stringify(MOCK_CREDENTIALS)) },
    async write() { return false },
  }
  return store
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refreshOAuthToken", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    const { resetInflightRefresh } = await import("../proxy/tokenRefresh")
    resetInflightRefresh()
  })

  // -------------------------------------------------------------------------
  // Credential read failures
  // -------------------------------------------------------------------------

  it("returns false when store cannot read credentials", async () => {
    const store: CredentialStore = { async read() { return null }, async write() { return false } }
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  it("returns false when credentials have no refreshToken", async () => {
    const { store } = makeStore({
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, refreshToken: "" },
    })
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Network failures
  // -------------------------------------------------------------------------

  it("returns false when fetch throws", async () => {
    const { store } = makeStore()
    globalThis.fetch = mock(async () => { throw new Error("network error") })
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  it("returns false on non-ok HTTP response", async () => {
    const { store } = makeStore()
    globalThis.fetch = mock(async () => new Response("Unauthorized", { status: 401 }))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  it("returns false when response body is invalid JSON", async () => {
    const { store } = makeStore()
    globalThis.fetch = mock(async () => new Response("not-json", { status: 200 }))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Write failures
  // -------------------------------------------------------------------------

  it("returns false when credential write fails", async () => {
    const store = makeFailingWriteStore()
    globalThis.fetch = mock(async () => makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Success paths
  // -------------------------------------------------------------------------

  it("returns true and writes updated tokens on success", async () => {
    const { store, getStored } = makeStore()
    globalThis.fetch = mock(async () => makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.claudeAiOauth.accessToken).toBe("new-access-token")
    expect(getStored()?.claudeAiOauth.refreshToken).toBe("new-refresh-token")
  })

  it("preserves old refreshToken when response omits it", async () => {
    const { store, getStored } = makeStore()
    globalThis.fetch = mock(async () =>
      makeSuccessResponse({ access_token: "new-access-token", expires_in: 3600 })
    )
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.claudeAiOauth.refreshToken).toBe("the-refresh-token")
  })

  it("preserves extra top-level credential file fields", async () => {
    const { store, getStored } = makeStore()
    globalThis.fetch = mock(async () => makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.extraField).toBe("keep-me")
  })

  it("sets expiresAt from expires_in", async () => {
    const { store, getStored } = makeStore()
    const before = Date.now()
    globalThis.fetch = mock(async () =>
      makeSuccessResponse({ access_token: "tok", expires_in: 3600 })
    )
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    const exp = getStored()?.claudeAiOauth.expiresAt ?? 0
    expect(exp).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100)
    expect(exp).toBeLessThanOrEqual(before + 3600 * 1000 + 5000)
  })

  it("prefers expires_at over expires_in when both present", async () => {
    const { store, getStored } = makeStore()
    const fixedExpiry = Date.now() + 9999999
    globalThis.fetch = mock(async () =>
      makeSuccessResponse({ access_token: "tok", expires_at: fixedExpiry, expires_in: 3600 })
    )
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.claudeAiOauth.expiresAt).toBe(fixedExpiry)
  })

  // -------------------------------------------------------------------------
  // Concurrency deduplication
  // -------------------------------------------------------------------------

  it("concurrent calls share one in-flight request", async () => {
    const { store } = makeStore()
    let fetchCount = 0
    globalThis.fetch = mock(async () => {
      fetchCount++
      return makeSuccessResponse(MOCK_TOKEN_RESPONSE)
    })
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    const [r1, r2, r3] = await Promise.all([
      refreshOAuthToken(store),
      refreshOAuthToken(store),
      refreshOAuthToken(store),
    ])

    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(r3).toBe(true)
    expect(fetchCount).toBe(1)
  })

  it("allows a second refresh after the first completes", async () => {
    const { store } = makeStore()
    let fetchCount = 0
    globalThis.fetch = mock(async () => {
      fetchCount++
      return makeSuccessResponse(MOCK_TOKEN_RESPONSE)
    })
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    await refreshOAuthToken(store)
    await refreshOAuthToken(store)

    expect(fetchCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// createPlatformCredentialStore
// ---------------------------------------------------------------------------

describe("createPlatformCredentialStore", () => {
  it("returns a store with read and write methods", async () => {
    const { createPlatformCredentialStore } = await import("../proxy/tokenRefresh")
    const store = createPlatformCredentialStore()
    expect(typeof store.read).toBe("function")
    expect(typeof store.write).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// isExpiredTokenError
// ---------------------------------------------------------------------------

describe("isExpiredTokenError", () => {
  it("detects the exact SDK error message", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError(
      "API Error: 401 {\"error\":{\"message\":\"OAuth token has expired. Please obtain a new token or refresh your existing token.\"}}"
    )).toBe(true)
  })

  it("is case-insensitive", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError("oauth token has expired")).toBe(true)
    expect(isExpiredTokenError("OAUTH TOKEN HAS EXPIRED")).toBe(true)
  })

  it("returns false for unrelated auth errors", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError("authentication failed")).toBe(false)
    expect(isExpiredTokenError("rate limit exceeded")).toBe(false)
    expect(isExpiredTokenError("invalid credentials")).toBe(false)
    expect(isExpiredTokenError("token refresh failed")).toBe(false)
  })
})
