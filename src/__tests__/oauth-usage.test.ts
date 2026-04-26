/**
 * Unit tests for oauthUsage — verifies normalization of Anthropic's private
 * OAuth usage endpoint shape into our internal OAuthUsageSnapshot.
 *
 * Network is mocked via globalThis.fetch override; credential store is
 * dependency-injected via the `store` option.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { fetchOAuthUsage, resetOAuthUsageCache } from "../proxy/oauthUsage"
import type { CredentialStore } from "../proxy/tokenRefresh"

const SAMPLE_RESPONSE = {
  five_hour: { utilization: 36.0, resets_at: "2026-04-26T22:30:00.221857+00:00" },
  seven_day: { utilization: 5.0, resets_at: "2026-05-03T17:00:00.221872+00:00" },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0.0, resets_at: null },
  seven_day_cowork: null,
  seven_day_omelette: { utilization: 1.0, resets_at: "2026-05-03T17:00:00.221883+00:00" },
  iguana_necktie: null,
  omelette_promotional: null,
  extra_usage: {
    is_enabled: true,
    monthly_limit: 0,
    used_credits: 23630.0,
    utilization: null,
    currency: "USD",
  },
}

const ORIG_FETCH = globalThis.fetch

let mockFetchImpl: ((url: string) => Promise<Response>) | null = null

function makeStore(token: string | null): CredentialStore {
  return {
    async read() {
      if (!token) return null
      return { claudeAiOauth: { accessToken: token, refreshToken: "rt", expiresAt: Date.now() + 60_000 } } as any
    },
    async write() { return true },
  }
}

function installMockFetch() {
  globalThis.fetch = (async (input: any, _init?: any) => {
    const url = typeof input === "string" ? input : input.url
    if (mockFetchImpl) return mockFetchImpl(url)
    return new Response("", { status: 500 })
  }) as any
}

function restoreFetch() {
  globalThis.fetch = ORIG_FETCH
  mockFetchImpl = null
}

describe("oauthUsage", () => {
  beforeEach(() => {
    resetOAuthUsageCache()
    installMockFetch()
  })

  afterEach(() => {
    restoreFetch()
    resetOAuthUsageCache()
  })

  test("returns null when no token is available", async () => {
    mockFetchImpl = async () => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore(null) })
    expect(result).toBeNull()
  })

  test("parses sample response into normalized shape", async () => {
    mockFetchImpl = async () => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore("token") })
    expect(result).not.toBeNull()
    expect(result!.windows.length).toBeGreaterThanOrEqual(2)

    const fiveHour = result!.windows.find(w => w.type === "five_hour")
    expect(fiveHour).toBeDefined()
    expect(fiveHour!.utilization).toBeCloseTo(0.36, 5)
    expect(fiveHour!.resetsAt).toBe(Date.parse(SAMPLE_RESPONSE.five_hour.resets_at))

    const sevenDay = result!.windows.find(w => w.type === "seven_day")
    expect(sevenDay).toBeDefined()
    expect(sevenDay!.utilization).toBeCloseTo(0.05, 5)
  })

  test("normalizes utilization from 0..100 to 0..1", async () => {
    mockFetchImpl = async () => new Response(JSON.stringify({
      five_hour: { utilization: 87.5, resets_at: "2026-04-26T22:30:00Z" },
    }), { status: 200 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t") })
    const w = result!.windows[0]
    expect(w).toBeDefined()
    expect(w!.utilization).toBeCloseTo(0.875, 5)
  })

  test("skips windows with no utilization and no resets_at", async () => {
    mockFetchImpl = async () => new Response(JSON.stringify({
      five_hour: { utilization: 36, resets_at: "2026-04-26T22:30:00Z" },
      seven_day: null,
      seven_day_opus: { utilization: null, resets_at: null },
    }), { status: 200 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t") })
    expect(result!.windows.length).toBe(1)
    const w = result!.windows[0]
    expect(w).toBeDefined()
    expect(w!.type).toBe("five_hour")
  })

  test("captures extra_usage block", async () => {
    mockFetchImpl = async () => new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t") })
    expect(result!.extraUsage).not.toBeNull()
    expect(result!.extraUsage!.isEnabled).toBe(true)
    expect(result!.extraUsage!.usedCredits).toBe(23630)
    expect(result!.extraUsage!.utilization).toBeNull()
    expect(result!.extraUsage!.currency).toBe("USD")
  })

  test("returns null on upstream error (non-401)", async () => {
    mockFetchImpl = async () => new Response("server boom", { status: 500 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t") })
    expect(result).toBeNull()
  })

  test("caches result within TTL", async () => {
    let calls = 0
    mockFetchImpl = async () => {
      calls++
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    }
    const store = makeStore("t")
    const r1 = await fetchOAuthUsage({ force: true, store })
    const r2 = await fetchOAuthUsage({ store })
    expect(r1).not.toBeNull()
    expect(r2).toBe(r1)
    expect(calls).toBe(1)
  })

  test("force=true bypasses cache", async () => {
    let calls = 0
    mockFetchImpl = async () => {
      calls++
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    }
    const store = makeStore("t")
    await fetchOAuthUsage({ force: true, store })
    await fetchOAuthUsage({ force: true, store })
    expect(calls).toBe(2)
  })

  test("per-profile cache: distinct profileIds get separate cache entries", async () => {
    let calls = 0
    mockFetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({
        five_hour: { utilization: 10 + calls, resets_at: "2026-04-26T22:30:00Z" },
      }), { status: 200 })
    }
    const a = await fetchOAuthUsage({ force: true, store: makeStore("tA"), profileId: "personal" })
    const b = await fetchOAuthUsage({ force: true, store: makeStore("tB"), profileId: "work" })
    expect(calls).toBe(2)
    expect(a!.windows[0]!.utilization).not.toBe(b!.windows[0]!.utilization)

    // Subsequent reads hit the per-profile cache, not the network.
    const aAgain = await fetchOAuthUsage({ profileId: "personal" })
    const bAgain = await fetchOAuthUsage({ profileId: "work" })
    expect(calls).toBe(2)
    expect(aAgain).toBe(a)
    expect(bAgain).toBe(b)
  })

  test("per-profile cache: same profileId across calls shares cache", async () => {
    let calls = 0
    mockFetchImpl = async () => {
      calls++
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    }
    const r1 = await fetchOAuthUsage({ force: true, store: makeStore("t"), profileId: "personal" })
    const r2 = await fetchOAuthUsage({ profileId: "personal" })
    expect(calls).toBe(1)
    expect(r2).toBe(r1)
  })

  test("profileId null behaves as the default account, distinct from named profiles", async () => {
    let calls = 0
    mockFetchImpl = async () => {
      calls++
      return new Response(JSON.stringify(SAMPLE_RESPONSE), { status: 200 })
    }
    await fetchOAuthUsage({ force: true, store: makeStore("d") })  // no profileId → default key
    await fetchOAuthUsage({ force: true, store: makeStore("p"), profileId: "personal" })
    expect(calls).toBe(2)
  })

  test("ISO date with timezone parses correctly to UTC ms", async () => {
    const iso = "2026-04-26T22:30:00.221857+00:00"
    mockFetchImpl = async () => new Response(JSON.stringify({
      five_hour: { utilization: 36, resets_at: iso },
    }), { status: 200 })
    const result = await fetchOAuthUsage({ force: true, store: makeStore("t") })
    const w = result!.windows[0]
    expect(w).toBeDefined()
    expect(w!.resetsAt).toBe(Date.parse(iso))
  })
})
