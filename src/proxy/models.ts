/**
 * Model mapping and Claude executable resolution.
 */

import { exec as execCallback } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { promisify } from "util"

const exec = promisify(execCallback)

export type ClaudeModel = "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]" | "haiku"
export interface ClaudeAuthStatus {
  loggedIn?: boolean
  subscriptionType?: string
  email?: string
}


const AUTH_STATUS_CACHE_TTL_MS = 60_000
/** Shorter TTL for failed auth checks — retry sooner to recover */
const AUTH_STATUS_FAILURE_TTL_MS = 5_000

let cachedAuthStatus: ClaudeAuthStatus | null = null
/** Last successfully retrieved auth status — survives transient failures
 *  so model selection doesn't degrade from sonnet[1m] to sonnet. */
let lastKnownGoodAuthStatus: ClaudeAuthStatus | null = null
let cachedAuthStatusAt = 0
let cachedAuthStatusIsFailure = false
let cachedAuthStatusPromise: Promise<ClaudeAuthStatus | null> | null = null

/**
 * Only Claude 4.6 models support the 1M extended context window.
 * Older models (4.5 and earlier) do not.
 */
function supports1mContext(model: string): boolean {
  // Explicit older versions (4-5, 4.5, etc.) do not support 1M
  if (model.includes("4-5") || model.includes("4.5")) return false
  // Everything else (bare names, 4-6, unknown) defaults to latest (1M capable)
  return true
}

export function mapModelToClaudeModel(model: string, subscriptionType?: string | null, agentMode?: string | null): ClaudeModel {
  if (model.includes("haiku")) return "haiku"

  const use1m = supports1mContext(model)
  // Subagents handle focused subtasks and don't benefit from 1M context.
  // Using the base model preserves rate limit budget for the primary agent.
  const isSubagent = agentMode === "subagent"

  // Opus [1m]: included with Max, Team, and Enterprise subscriptions per
  // Anthropic docs (https://code.claude.com/docs/en/model-config#extended-context).
  // Safe to default to [1m] for Max users — no Extra Usage charges.
  // NOTE: There is a known upstream bug (anthropics/claude-code#39841) where
  // Claude Code currently gates opus[1m] behind Extra Usage even on Max.
  // We follow the documented behavior; the bug is Anthropic's to fix.
  if (model.includes("opus")) {
    if (use1m && !isSubagent && !isExtendedContextKnownUnavailable()) return "opus[1m]"
    return "opus"
  }

  // Sonnet [1m]: requires Extra Usage on Max plans per Anthropic docs.
  // Unlike Opus, Sonnet 1M is NOT included with the Max subscription —
  // it is always billed as Extra Usage. Default to sonnet (200k) to
  // avoid unexpected charges. Users opt in via MERIDIAN_SONNET_MODEL=sonnet[1m].
  const sonnetOverride = process.env.MERIDIAN_SONNET_MODEL ?? process.env.CLAUDE_PROXY_SONNET_MODEL
  if (sonnetOverride === "sonnet[1m]") {
    if (!use1m || isSubagent || isExtendedContextKnownUnavailable()) return "sonnet"
    return "sonnet[1m]"
  }

  return "sonnet"
}

// ---------------------------------------------------------------------------
// Extended context availability — time-based cooldown
// ---------------------------------------------------------------------------

/** How long to skip [1m] models after confirming Extra Usage is not enabled. */
const EXTRA_USAGE_RETRY_MS = 60 * 60 * 1000 // 1 hour

let extraUsageUnavailableAt = 0

/**
 * Record that Extra Usage is not enabled on this subscription.
 * For the next hour, mapModelToClaudeModel will return the base model
 * directly — no failed [1m] attempt per request. After the cooldown
 * the next request probes [1m] once; if Extra Usage was enabled in the
 * meantime it succeeds and the flag is never set again.
 */
export function recordExtendedContextUnavailable(): void {
  extraUsageUnavailableAt = Date.now()
}

/**
 * Returns true while within the cooldown window after a confirmed
 * Extra Usage failure. After the window expires this returns false,
 * allowing one probe to check whether Extra Usage has been enabled.
 */
export function isExtendedContextKnownUnavailable(): boolean {
  return extraUsageUnavailableAt > 0 &&
    Date.now() - extraUsageUnavailableAt < EXTRA_USAGE_RETRY_MS
}

/** Reset the Extended Context unavailability timer — for testing only. */
export function resetExtendedContextUnavailable(): void {
  extraUsageUnavailableAt = 0
}

/**
 * Strip the [1m] suffix from a model, returning the base variant.
 * Used for fallback when the 1M context window is rate-limited.
 */
export function stripExtendedContext(model: ClaudeModel): ClaudeModel {
  if (model === "opus[1m]") return "opus"
  if (model === "sonnet[1m]") return "sonnet"
  return model
}

/**
 * Check whether a model is using extended (1M) context.
 */
export function hasExtendedContext(model: ClaudeModel): boolean {
  return model.endsWith("[1m]")
}

/** Per-profile auth status cache for multi-account support */
interface AuthCache {
  status: ClaudeAuthStatus | null
  lastKnownGood: ClaudeAuthStatus | null
  at: number
  isFailure: boolean
  promise: Promise<ClaudeAuthStatus | null> | null
  lastSuccessAt: number
}
const profileAuthCaches = new Map<string, AuthCache>()

/** Get the last successful auth check timestamp for a profile.
 * @param profileId - Profile ID to look up (uses default cache when omitted) */
export function getAuthCacheInfo(profileId?: string): { lastCheckedAt: number; lastSuccessAt: number; isFailure: boolean } {
  if (!profileId) {
    return { lastCheckedAt: cachedAuthStatusAt, lastSuccessAt: cachedAuthStatusIsFailure ? 0 : cachedAuthStatusAt, isFailure: cachedAuthStatusIsFailure }
  }
  const cache = profileAuthCaches.get(profileId)
  if (!cache) return { lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }
  return { lastCheckedAt: cache.at, lastSuccessAt: cache.lastSuccessAt, isFailure: cache.isFailure }
}

function getAuthCache(key: string): AuthCache {
  let cache = profileAuthCaches.get(key)
  if (!cache) {
    cache = { status: null, lastKnownGood: null, at: 0, isFailure: false, promise: null, lastSuccessAt: 0 }
    profileAuthCaches.set(key, cache)
  }
  return cache
}

/**
 * @param profileId - Profile ID for per-profile cache keying (e.g. "work", "personal").
 *   When undefined, uses the default (global) auth context.
 * @param envOverrides - Optional env vars for per-profile auth (e.g. CLAUDE_CONFIG_DIR).
 */
export async function getClaudeAuthStatusAsync(profileId?: string, envOverrides?: Record<string, string>): Promise<ClaudeAuthStatus | null> {
  // Use per-profile cache when a profile ID is provided, else fall back to
  // the legacy global cache for backward compatibility with existing tests.
  const isDefault = !profileId
  const cache = isDefault ? null : getAuthCache(profileId!)

  // Read from the appropriate cache
  const c_status = cache ? cache.status : cachedAuthStatus
  const c_lastKnownGood = cache ? cache.lastKnownGood : lastKnownGoodAuthStatus
  const c_at = cache ? cache.at : cachedAuthStatusAt
  const c_isFailure = cache ? cache.isFailure : cachedAuthStatusIsFailure
  let c_promise = cache ? cache.promise : cachedAuthStatusPromise

  const ttl = c_isFailure ? AUTH_STATUS_FAILURE_TTL_MS : AUTH_STATUS_CACHE_TTL_MS
  if (c_at > 0 && Date.now() - c_at < ttl) {
    return c_status ?? c_lastKnownGood
  }
  if (c_promise) return c_promise

  c_promise = (async () => {
    try {
      const { stdout } = await exec("claude auth status", {
        timeout: 5000,
        ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
      })
      const parsed = JSON.parse(stdout) as ClaudeAuthStatus
      if (cache) {
        cache.status = parsed; cache.lastKnownGood = parsed
        cache.at = Date.now(); cache.isFailure = false; cache.lastSuccessAt = Date.now()
      } else {
        cachedAuthStatus = parsed; lastKnownGoodAuthStatus = parsed
        cachedAuthStatusAt = Date.now(); cachedAuthStatusIsFailure = false
      }
      return parsed
    } catch {
      if (cache) {
        cache.isFailure = true; cache.at = Date.now(); cache.status = null
        return cache.lastKnownGood
      } else {
        cachedAuthStatusIsFailure = true; cachedAuthStatusAt = Date.now()
        cachedAuthStatus = null
        return lastKnownGoodAuthStatus
      }
    }
  })()

  if (cache) cache.promise = c_promise
  else cachedAuthStatusPromise = c_promise

  try {
    return await c_promise
  } finally {
    if (cache) cache.promise = null
    else cachedAuthStatusPromise = null
  }
}

// --- Claude Executable Resolution ---

let cachedClaudePath: string | null = null
let cachedClaudePathPromise: Promise<string> | null = null

/**
 * Resolve the Claude executable path asynchronously (non-blocking).
 *
 * Uses a three-tier cache:
 * 1. cachedClaudePath — resolved path, returned immediately on subsequent calls
 * 2. cachedClaudePathPromise — deduplicates concurrent calls during resolution
 * 3. Falls through to resolution logic (SDK cli.js → system `which claude`)
 *
 * The promise is cleared in `finally` to allow retry on failure while
 * cachedClaudePath prevents re-resolution on success.
 */
export async function resolveClaudeExecutableAsync(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath
  if (cachedClaudePathPromise) return cachedClaudePathPromise

  cachedClaudePathPromise = (async () => {
    // The SDK runs cli.js via bun or node depending on the current runtime:
    //   getDefaultExecutable() → "bun" if process.versions.bun, else "node"
    //
    // When run via node (bun not installed/not the runtime), cli.js + the
    // --permission-mode bypassPermissions flag exits with code 1. This is
    // the root cause of issue #203.
    //
    // Resolution order:
    //   1. If running under bun: cli.js works correctly — use it
    //   2. System claude binary: standalone, no runtime dependency, always safe
    //   3. Last resort: cli.js via node (may fail for some permission modes)
    const runningUnderBun = typeof process.versions.bun !== "undefined"

    // 1. SDK bundled cli.js — only when bun is the runtime
    if (runningUnderBun) {
      try {
        const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
        const sdkCliJs = join(dirname(sdkPath), "cli.js")
        if (existsSync(sdkCliJs)) {
          cachedClaudePath = sdkCliJs
          return sdkCliJs
        }
      } catch {}
    }

    // 2. System-installed claude binary (standalone — no runtime dependency)
    try {
      const { stdout } = await exec("which claude")
      const claudePath = stdout.trim()
      if (claudePath && existsSync(claudePath)) {
        cachedClaudePath = claudePath
        return claudePath
      }
    } catch {}

    // 3. Last resort: SDK cli.js via node (limited — bypassPermissions may fail)
    if (!runningUnderBun) {
      try {
        const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
        const sdkCliJs = join(dirname(sdkPath), "cli.js")
        if (existsSync(sdkCliJs)) {
          cachedClaudePath = sdkCliJs
          return sdkCliJs
        }
      } catch {}
    }

    throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
  })()

  try {
    return await cachedClaudePathPromise
  } finally {
    cachedClaudePathPromise = null
  }
}

/** Reset cached path — for testing only */
export function resetCachedClaudePath(): void {
  cachedClaudePath = null
  cachedClaudePathPromise = null
}

/** Reset cached auth status — for testing only */
export function resetCachedClaudeAuthStatus(): void {
  cachedAuthStatus = null
  lastKnownGoodAuthStatus = null
  cachedAuthStatusAt = 0
  cachedAuthStatusIsFailure = false
  cachedAuthStatusPromise = null
  profileAuthCaches.clear()
}

/** Expire the auth status cache without clearing lastKnownGoodAuthStatus — for testing only.
 *  This simulates the TTL expiring so the next call re-executes `claude auth status`,
 *  while preserving the "last known good" fallback state. */
export function expireAuthStatusCache(): void {
  cachedAuthStatusAt = 0
  cachedAuthStatusPromise = null
  for (const cache of profileAuthCaches.values()) {
    cache.at = 0
    cache.promise = null
  }
}

/**
 * Check if an error is a "Controller is already closed" error.
 * This happens when the client disconnects mid-stream.
 */
export function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("Controller is already closed")
}
