/**
 * Continuous OAuth usage fetching from Anthropic's private OAuth endpoint.
 *
 * Anthropic exposes `GET https://api.anthropic.com/api/oauth/usage` for OAuth
 * (Claude Max) subscribers. Unlike the SDK's `rate_limit_event` (which only
 * populates `utilization` near `allowed_warning` / `rejected`), this endpoint
 * always returns continuous percentage values for every active rate-limit
 * window — exactly what claude.ai's own UI uses.
 *
 * Headers required:
 *   Authorization: Bearer <oauth-access-token>
 *   anthropic-beta: oauth-2025-04-20
 *
 * We reuse `tokenRefresh.ts`'s cross-platform credential store (macOS Keychain
 * or `~/.claude/.credentials.json`) to read the access token, and trigger a
 * background refresh on 401.
 *
 * Per-profile caching: each profile has its own 30s TTL cache so multi-account
 * setups can be queried independently without cross-contamination. Concurrent
 * callers for the same profile share a single in-flight request.
 */

import { claudeLog } from "../logger"
import { createPlatformCredentialStore, refreshOAuthToken, type CredentialStore } from "./tokenRefresh"

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
const OAUTH_BETA_HEADER = "oauth-2025-04-20"

/** Raw shape returned by Anthropic. Most fields are optional/nullable. */
interface RawOAuthWindow {
  utilization?: number | null
  resets_at?: string | null
}

interface RawOAuthExtraUsage {
  is_enabled?: boolean
  monthly_limit?: number
  used_credits?: number
  utilization?: number | null
  currency?: string
}

interface RawOAuthUsageResponse {
  five_hour?: RawOAuthWindow | null
  seven_day?: RawOAuthWindow | null
  seven_day_opus?: RawOAuthWindow | null
  seven_day_sonnet?: RawOAuthWindow | null
  seven_day_oauth_apps?: RawOAuthWindow | null
  seven_day_cowork?: RawOAuthWindow | null
  seven_day_omelette?: RawOAuthWindow | null
  iguana_necktie?: RawOAuthWindow | null
  omelette_promotional?: RawOAuthWindow | null
  extra_usage?: RawOAuthExtraUsage | null
}

export interface OAuthUsageWindow {
  type: string
  utilization: number | null
  resetsAt: number | null
}

export interface OAuthExtraUsageInfo {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
  currency: string
}

export interface OAuthUsageSnapshot {
  windows: OAuthUsageWindow[]
  extraUsage: OAuthExtraUsageInfo | null
  fetchedAt: number
}

const CACHE_TTL_MS_DEFAULT = 30_000

/** Per-profile cache. Key = profileId (or DEFAULT_KEY for the unscoped default). */
const cacheByProfile = new Map<string, OAuthUsageSnapshot>()
const inflightByProfile = new Map<string, Promise<OAuthUsageSnapshot | null>>()
const DEFAULT_KEY = "__default__"

const WINDOW_TYPES: Array<keyof RawOAuthUsageResponse> = [
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "seven_day_oauth_apps",
  "seven_day_cowork",
  "seven_day_omelette",
]

function parseIsoToMs(raw: string | null | undefined): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

function normalizeUtilization(raw: number | null | undefined): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null
  // OAuth returns 0..100. Normalize to 0..1 to match SDK rate_limit_event.
  return Math.max(0, raw / 100)
}

function buildSnapshot(raw: RawOAuthUsageResponse): OAuthUsageSnapshot {
  const windows: OAuthUsageWindow[] = []
  for (const key of WINDOW_TYPES) {
    const w = raw[key] as RawOAuthWindow | null | undefined
    if (!w) continue
    const utilization = normalizeUtilization(w.utilization)
    const resetsAt = parseIsoToMs(w.resets_at)
    if (utilization === null && resetsAt === null) continue
    windows.push({ type: key as string, utilization, resetsAt })
  }

  const extra = raw.extra_usage
  const extraUsage: OAuthExtraUsageInfo | null = extra
    ? {
        isEnabled: !!extra.is_enabled,
        monthlyLimit: extra.monthly_limit ?? 0,
        usedCredits: extra.used_credits ?? 0,
        utilization: normalizeUtilization(extra.utilization ?? null),
        currency: extra.currency ?? "USD",
      }
    : null

  return { windows, extraUsage, fetchedAt: Date.now() }
}

async function readAccessToken(store: CredentialStore): Promise<string | null> {
  const creds = await store.read()
  return creds?.claudeAiOauth?.accessToken ?? null
}

async function callAnthropic(token: string, signal?: AbortSignal): Promise<RawOAuthUsageResponse | { __status: number }> {
  const res = await fetch(OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA_HEADER,
      Accept: "application/json",
    },
    signal: signal ?? AbortSignal.timeout(10_000),
  })
  if (!res.ok) return { __status: res.status }
  return (await res.json()) as RawOAuthUsageResponse
}

/**
 * Fetch latest OAuth usage for a specific profile (or the default OAuth
 * account if none specified). Returns null if no OAuth token is available
 * or the upstream call fails (after one refresh attempt).
 *
 * Per-profile in-process cache (30s TTL by default) prevents hammering
 * Anthropic's endpoint when many clients poll concurrently. Concurrent
 * callers for the same profile share a single in-flight request.
 *
 * @param ttlMs           Override the cache TTL (default 30s).
 * @param force           Bypass the cache and fetch fresh.
 * @param store           Override the credential store (for testing).
 * @param profileId       Logical profile identifier used as the cache key.
 *                        Pass null/undefined for the default OAuth account.
 * @param claudeConfigDir When provided, reads credentials from this dir's
 *                        keychain entry (macOS) or `.credentials.json`
 *                        (Linux) instead of the platform default.
 */
export async function fetchOAuthUsage(opts?: {
  ttlMs?: number
  force?: boolean
  store?: CredentialStore
  profileId?: string | null
  claudeConfigDir?: string
}): Promise<OAuthUsageSnapshot | null> {
  const ttl = opts?.ttlMs ?? CACHE_TTL_MS_DEFAULT
  const cacheKey = opts?.profileId ?? DEFAULT_KEY

  if (!opts?.force) {
    const cached = cacheByProfile.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached
  }
  const existing = inflightByProfile.get(cacheKey)
  if (existing) return existing

  const store = opts?.store ?? createPlatformCredentialStore({ claudeConfigDir: opts?.claudeConfigDir })

  const promise = (async () => {
    try {
      const token = await readAccessToken(store)
      if (!token) return null

      let result = await callAnthropic(token)
      if ("__status" in result && result.__status === 401) {
        claudeLog("oauth_usage.token_refresh_attempt", { profile: cacheKey })
        const refreshed = await refreshOAuthToken(store)
        if (!refreshed) {
          claudeLog("oauth_usage.refresh_failed", { profile: cacheKey })
          return null
        }
        const newToken = await readAccessToken(store)
        if (!newToken) return null
        result = await callAnthropic(newToken)
      }
      if ("__status" in result) {
        claudeLog("oauth_usage.upstream_error", { profile: cacheKey, status: result.__status })
        return null
      }

      const snapshot = buildSnapshot(result)
      cacheByProfile.set(cacheKey, snapshot)
      return snapshot
    } catch (err) {
      claudeLog("oauth_usage.fetch_failed", { profile: cacheKey, error: err instanceof Error ? err.message : String(err) })
      return null
    } finally {
      inflightByProfile.delete(cacheKey)
    }
  })()

  inflightByProfile.set(cacheKey, promise)
  return promise
}

/** Test-only / shutdown helper — clears all cached snapshots and pending fetches. */
export function resetOAuthUsageCache(): void {
  cacheByProfile.clear()
  inflightByProfile.clear()
}
