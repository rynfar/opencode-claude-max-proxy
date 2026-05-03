/**
 * Unit tests for tokenRefresh.
 *
 * The credential store is injected so tests are platform-agnostic — no fs
 * or child_process mocking required. Network (fetch) is swapped via
 * globalThis.fetch.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import type { CredentialStore } from "../proxy/tokenRefresh"
import { serializeCredentials } from "../proxy/tokenRefresh"

/** Assign a mock to globalThis.fetch without TS complaining about missing `preconnect` */
function mockFetch(fn: (...args: unknown[]) => Promise<Response | never>): void {
  globalThis.fetch = fn as typeof fetch
}

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
    mockFetch(mock(async () => { throw new Error("network error") }))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  it("returns false on non-ok HTTP response", async () => {
    const { store } = makeStore()
    mockFetch(mock(async () => new Response("Unauthorized", { status: 401 })))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  it("returns false when response body is invalid JSON", async () => {
    const { store } = makeStore()
    mockFetch(mock(async () => new Response("not-json", { status: 200 })))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Write failures
  // -------------------------------------------------------------------------

  it("returns false when credential write fails", async () => {
    const store = makeFailingWriteStore()
    mockFetch(mock(async () => makeSuccessResponse(MOCK_TOKEN_RESPONSE)))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    expect(await refreshOAuthToken(store)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Success paths
  // -------------------------------------------------------------------------

  it("returns true and writes updated tokens on success", async () => {
    const { store, getStored } = makeStore()
    mockFetch(mock(async () => makeSuccessResponse(MOCK_TOKEN_RESPONSE)))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.claudeAiOauth.accessToken).toBe("new-access-token")
    expect(getStored()?.claudeAiOauth.refreshToken).toBe("new-refresh-token")
  })

  it("preserves old refreshToken when response omits it", async () => {
    const { store, getStored } = makeStore()
    mockFetch(mock(async () =>
      makeSuccessResponse({ access_token: "new-access-token", expires_in: 3600 })
    ))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.claudeAiOauth.refreshToken).toBe("the-refresh-token")
  })

  it("preserves extra top-level credential file fields", async () => {
    const { store, getStored } = makeStore()
    mockFetch(mock(async () => makeSuccessResponse(MOCK_TOKEN_RESPONSE)))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(getStored()?.extraField).toBe("keep-me")
  })

  it("sets expiresAt from expires_in", async () => {
    const { store, getStored } = makeStore()
    const before = Date.now()
    mockFetch(mock(async () =>
      makeSuccessResponse({ access_token: "tok", expires_in: 3600 })
    ))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    expect(await refreshOAuthToken(store)).toBe(true)
    const exp = getStored()?.claudeAiOauth.expiresAt ?? 0
    expect(exp).toBeGreaterThanOrEqual(before + 3600 * 1000 - 100)
    expect(exp).toBeLessThanOrEqual(before + 3600 * 1000 + 5000)
  })

  it("prefers expires_at over expires_in when both present", async () => {
    const { store, getStored } = makeStore()
    const fixedExpiry = Date.now() + 9999999
    mockFetch(mock(async () =>
      makeSuccessResponse({ access_token: "tok", expires_at: fixedExpiry, expires_in: 3600 })
    ))
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
    mockFetch(mock(async () => {
      fetchCount++
      return makeSuccessResponse(MOCK_TOKEN_RESPONSE)
    }))
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
    mockFetch(mock(async () => {
      fetchCount++
      return makeSuccessResponse(MOCK_TOKEN_RESPONSE)
    }))
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    await refreshOAuthToken(store)
    await refreshOAuthToken(store)

    expect(fetchCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// ensureFreshToken — proactive refresh before SDK call
// ---------------------------------------------------------------------------

describe("ensureFreshToken", () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    const { resetInflightRefresh } = await import("../proxy/tokenRefresh")
    resetInflightRefresh()
  })

  function makeStoreWithExpiry(expiresAt: number) {
    return makeStore({ ...MOCK_CREDENTIALS, claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt } })
  }

  it("returns true without refreshing when token is far from expiry", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const fetchSpy = mock(() => Promise.reject(new Error("fetch should not be called")))
    mockFetch(fetchSpy)
    const { store, writes } = makeStoreWithExpiry(Date.now() + 60 * 60 * 1000) // +1h, well outside default 5min buffer

    const ok = await ensureFreshToken(store)
    expect(ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it("refreshes when token is inside the buffer (near-expiry)", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const fetchSpy = mock(() => Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE)))
    mockFetch(fetchSpy)
    const { store, getStored } = makeStoreWithExpiry(Date.now() + 60 * 1000) // +1min, well inside default 5min buffer

    const ok = await ensureFreshToken(store)
    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getStored()?.claudeAiOauth.accessToken).toBe("new-access-token")
  })

  it("refreshes when token is already expired", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const fetchSpy = mock(() => Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE)))
    mockFetch(fetchSpy)
    const { store, getStored } = makeStoreWithExpiry(Date.now() - 60 * 60 * 1000) // -1h

    const ok = await ensureFreshToken(store)
    expect(ok).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(getStored()?.claudeAiOauth.accessToken).toBe("new-access-token")
  })

  it("returns false when no credentials stored", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const fetchSpy = mock(() => Promise.reject(new Error("fetch should not be called")))
    mockFetch(fetchSpy)
    const { store } = makeStore(null)
    const ok = await ensureFreshToken(store)
    expect(ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns false when expiresAt missing", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const fetchSpy = mock(() => Promise.reject(new Error("fetch should not be called")))
    mockFetch(fetchSpy)
    // expiresAt = 0 is falsy via `!expiresAt`
    const { store } = makeStoreWithExpiry(0)
    const ok = await ensureFreshToken(store)
    expect(ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("returns false when refresh request fails", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    mockFetch(() => Promise.resolve(new Response("invalid_grant", { status: 400 })))
    const { store } = makeStoreWithExpiry(Date.now() - 1000)
    const ok = await ensureFreshToken(store)
    expect(ok).toBe(false)
  })

  it("respects custom bufferMs", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const fetchSpy = mock(() => Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE)))
    mockFetch(fetchSpy)
    // Token expires in 2h. Default 5-min buffer → no refresh; 3-h buffer → refresh.
    const { store } = makeStoreWithExpiry(Date.now() + 2 * 60 * 60 * 1000)
    expect(await ensureFreshToken(store, 60 * 1000)).toBe(true)            // 1-min buffer: skip
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await ensureFreshToken(store, 3 * 60 * 60 * 1000)).toBe(true)   // 3-h buffer: refresh
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// startBackgroundRefresh — traffic-independent scheduled refresh
// ---------------------------------------------------------------------------

describe("startBackgroundRefresh", () => {
  let originalFetch: typeof globalThis.fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(async () => {
    const { stopBackgroundRefresh, resetInflightRefresh } = await import("../proxy/tokenRefresh")
    stopBackgroundRefresh()
    resetInflightRefresh()
    globalThis.fetch = originalFetch
  })

  // Wait for any pending timers + microtasks to flush. Real timers — keeps
  // the test runner simple at the cost of slightly longer test runs.
  const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it("immediately refreshes when token is already expired", async () => {
    const { startBackgroundRefresh, isBackgroundRefreshActive } = await import("../proxy/tokenRefresh")
    let fetchCalls = 0
    mockFetch(() => {
      fetchCalls++
      return Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    })
    const { store, getStored } = makeStore({
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() - 60_000 },
    })

    startBackgroundRefresh(store, 1000, 60_000)
    expect(isBackgroundRefreshActive()).toBe(true)
    await tick(50)

    expect(fetchCalls).toBe(1)
    expect(getStored()?.claudeAiOauth.accessToken).toBe("new-access-token")
  })

  it("schedules — does not refresh — when token has time", async () => {
    const { startBackgroundRefresh } = await import("../proxy/tokenRefresh")
    let fetchCalls = 0
    mockFetch(() => {
      fetchCalls++
      return Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    })
    const { store } = makeStore({
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() + 60 * 60 * 1000 }, // +1h
    })

    startBackgroundRefresh(store, 1000, 60_000)
    await tick(50)

    expect(fetchCalls).toBe(0)
  })

  it("polls when no credentials are present, picks up new file on next tick", async () => {
    const { startBackgroundRefresh, stopBackgroundRefresh } = await import("../proxy/tokenRefresh")
    let stored: typeof MOCK_CREDENTIALS | null = null
    const store: CredentialStore = {
      async read() { return stored ? JSON.parse(JSON.stringify(stored)) : null },
      async write(c) { stored = c as typeof MOCK_CREDENTIALS; return true },
    }
    let fetchCalls = 0
    mockFetch(() => {
      fetchCalls++
      return Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    })

    startBackgroundRefresh(store, 1000, 30) // 30ms poll interval
    await tick(50)
    expect(fetchCalls).toBe(0) // no credentials yet — refresh skipped

    // Operator "logs in" — credentials appear with an expired token
    stored = {
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() - 1000 },
    }
    await tick(60) // wait for next poll tick

    expect(fetchCalls).toBeGreaterThanOrEqual(1)
    stopBackgroundRefresh()
  })

  it("retries on refresh failure", async () => {
    const { startBackgroundRefresh } = await import("../proxy/tokenRefresh")
    let fetchCalls = 0
    mockFetch(() => {
      fetchCalls++
      return Promise.resolve(new Response("invalid_grant", { status: 400 }))
    })
    const { store } = makeStore({
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() - 1000 },
    })

    startBackgroundRefresh(store, 1000, 30) // 30ms retry interval
    await tick(120) // let it retry a few times

    expect(fetchCalls).toBeGreaterThanOrEqual(2)
  })

  it("is idempotent — second start() while running is a no-op", async () => {
    const { startBackgroundRefresh, isBackgroundRefreshActive } = await import("../proxy/tokenRefresh")
    let fetchCalls = 0
    mockFetch(() => {
      fetchCalls++
      return Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    })
    const { store } = makeStore({
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() - 1000 },
    })

    startBackgroundRefresh(store, 1000, 60_000)
    startBackgroundRefresh(store, 1000, 60_000) // second call — should be no-op
    expect(isBackgroundRefreshActive()).toBe(true)
    await tick(50)

    expect(fetchCalls).toBe(1) // only one refresh, not two
  })

  it("stop() prevents the next scheduled refresh from firing", async () => {
    const { startBackgroundRefresh, stopBackgroundRefresh, isBackgroundRefreshActive } = await import("../proxy/tokenRefresh")
    let fetchCalls = 0
    mockFetch(() => {
      fetchCalls++
      return Promise.resolve(makeSuccessResponse(MOCK_TOKEN_RESPONSE))
    })
    const { store } = makeStore({
      ...MOCK_CREDENTIALS,
      claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() + 1000 }, // 1s out, well past 100ms buffer
    })

    startBackgroundRefresh(store, 100, 60_000)
    stopBackgroundRefresh()
    expect(isBackgroundRefreshActive()).toBe(false)
    await tick(1500) // would have fired by now

    expect(fetchCalls).toBe(0)
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

  it("detects the 'Not logged in' message from local expiry check", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError(
      "Claude Code returned an error result: Not logged in \u00b7 Please run /login"
    )).toBe(true)
  })

  it("returns false for unrelated errors that lack a 401 marker", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError("authentication failed")).toBe(false)
    expect(isExpiredTokenError("rate limit exceeded")).toBe(false)
    expect(isExpiredTokenError("invalid credentials")).toBe(false)
    expect(isExpiredTokenError("token refresh failed")).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Broadened triggers — generic 401s and RFC-6750 wording.
  //
  // Reason: Anthropic's API can return a 401 for an expired access token
  // without echoing the CLI-specific "OAuth token has expired" string, so the
  // narrow legacy matcher missed scheduled-expiry failures and the proxy
  // never fired refresh-and-retry. Confirmed in production 2026-05-03 on two
  // NAS instances that sat idle past expiry: credentials.json mtime never
  // ticked, every request returned 401 to the client, no
  // "token_refresh.retrying" ever logged.
  // ---------------------------------------------------------------------------

  it("detects generic 401 + authentication wording", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError("API Error: 401 authentication_error")).toBe(true)
    expect(isExpiredTokenError("HTTP 401 Unauthorized")).toBe(true)
    expect(isExpiredTokenError("401 invalid request")).toBe(true)
  })

  it("detects RFC-6750 token error codes", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError('error="invalid_token"')).toBe(true)
    expect(isExpiredTokenError("token_expired")).toBe(true)
  })

  it("does not trigger on 401 without an auth keyword", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    // Hypothetical 401 without auth wording — leave as not-a-trigger to keep
    // the false-positive surface narrow.
    expect(isExpiredTokenError("API returned 401 over rate limit")).toBe(false)
  })

  it("does not trigger on non-401 errors that incidentally include auth words", async () => {
    const { isExpiredTokenError } = await import("../proxy/errors")
    expect(isExpiredTokenError("authentication failed")).toBe(false)
    expect(isExpiredTokenError("invalid argument")).toBe(false)
    expect(isExpiredTokenError("unauthorized scope")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Regression: issue #452 — credentials must be written compact (no whitespace)
// ---------------------------------------------------------------------------
//
// `JSON.stringify(credentials, null, 2)` would pretty-print, which Claude
// Code's credential parser cannot read. Result: silent logout after Meridian
// refreshed the token. This test pins the output format so a future commit
// can't accidentally re-introduce indentation.

describe("serializeCredentials", () => {
  const FIXTURE = {
    claudeAiOauth: {
      accessToken: "tok-abc",
      refreshToken: "ref-xyz",
      expiresAt: 1700000000000,
      scopes: ["openid", "profile"],
      subscriptionType: "max",
      rateLimitTier: "standard",
    },
  }

  it("emits compact JSON (no newlines)", () => {
    expect(serializeCredentials(FIXTURE)).not.toContain("\n")
  })

  it("emits compact JSON (no two-space indent)", () => {
    expect(serializeCredentials(FIXTURE)).not.toContain("  ")
  })

  it("emits valid JSON that round-trips through JSON.parse", () => {
    const out = serializeCredentials(FIXTURE)
    expect(JSON.parse(out)).toEqual(FIXTURE)
  })

  it("matches what JSON.stringify(x) would produce (drop-in equivalent)", () => {
    expect(serializeCredentials(FIXTURE)).toBe(JSON.stringify(FIXTURE))
  })

  it("preserves arbitrary extra fields (does not strip user data)", () => {
    const withExtras = { ...FIXTURE, customField: "value", nested: { a: 1 } }
    const parsed = JSON.parse(serializeCredentials(withExtras))
    expect(parsed.customField).toBe("value")
    expect(parsed.nested).toEqual({ a: 1 })
  })

  it("never emits the pretty-printed form (regression #452)", () => {
    const compact = serializeCredentials(FIXTURE)
    const pretty = JSON.stringify(FIXTURE, null, 2)
    expect(compact).not.toBe(pretty)
    // pretty-printed always contains a newline between fields; compact never does.
    expect(pretty).toContain("\n")
    expect(compact).not.toContain("\n")
  })
})
