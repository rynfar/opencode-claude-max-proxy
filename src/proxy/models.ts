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

  if (model.includes("opus")) {
    if (use1m && !isSubagent && !isExtendedContextKnownUnavailable()) return "opus[1m]"
    return "opus"
  }

  const sonnetOverride = process.env.MERIDIAN_SONNET_MODEL ?? process.env.CLAUDE_PROXY_SONNET_MODEL
  if (sonnetOverride === "sonnet" || sonnetOverride === "sonnet[1m]") return sonnetOverride

  if (!use1m) return "sonnet"
  if (isSubagent) return "sonnet"
  // Skip [1m] during the cooldown window after a confirmed Extra Usage failure.
  // After the window expires, this falls through to return [1m] once — probing
  // whether Extra Usage has been enabled since last time.
  if (isExtendedContextKnownUnavailable()) return "sonnet"
  return subscriptionType === "max" ? "sonnet[1m]" : "sonnet"
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

export async function getClaudeAuthStatusAsync(): Promise<ClaudeAuthStatus | null> {
  // Return cached result if within TTL — use shorter TTL for failures to recover faster
  const ttl = cachedAuthStatusIsFailure ? AUTH_STATUS_FAILURE_TTL_MS : AUTH_STATUS_CACHE_TTL_MS
  if (cachedAuthStatusAt > 0 && Date.now() - cachedAuthStatusAt < ttl) {
    // On failure, return last known good status (preserves subscription type for model selection)
    return cachedAuthStatus ?? lastKnownGoodAuthStatus
  }
  if (cachedAuthStatusPromise) return cachedAuthStatusPromise

  cachedAuthStatusPromise = (async () => {
    try {
      const { stdout } = await exec("claude auth status", { timeout: 5000 })
      const parsed = JSON.parse(stdout) as ClaudeAuthStatus
      cachedAuthStatus = parsed
      lastKnownGoodAuthStatus = parsed
      cachedAuthStatusAt = Date.now()
      cachedAuthStatusIsFailure = false
      return parsed
    } catch {
      // Short-lived negative cache: retry in 5s instead of 60s.
      // Return last known good status so model selection doesn't degrade
      // (e.g. sonnet[1m] → sonnet) during transient auth command failures.
      cachedAuthStatusIsFailure = true
      cachedAuthStatusAt = Date.now()
      cachedAuthStatus = null
      return lastKnownGoodAuthStatus
    }
  })()

  try {
    return await cachedAuthStatusPromise
  } finally {
    cachedAuthStatusPromise = null
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
}

/** Expire the auth status cache without clearing lastKnownGoodAuthStatus — for testing only.
 *  This simulates the TTL expiring so the next call re-executes `claude auth status`,
 *  while preserving the "last known good" fallback state. */
export function expireAuthStatusCache(): void {
  cachedAuthStatusAt = 0
  cachedAuthStatusPromise = null
}

/**
 * Check if an error is a "Controller is already closed" error.
 * This happens when the client disconnects mid-stream.
 */
export function isClosedControllerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes("Controller is already closed")
}
