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

export const PREMIUM_SUBSCRIPTION_TYPES = new Set([
  "max", "maxplan", "max5", "max20", "enterprise", "team"
])

export function isPremiumSubscription(subscriptionType?: string | null): boolean {
  return subscriptionType ? PREMIUM_SUBSCRIPTION_TYPES.has(subscriptionType) : false
}

export interface TokenBudget {
  inputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  outputTokens: number
  usedTokens: number
  maxTokens: number
  totalProcessedTokens: number
  toolUses: number
  durationMs: number
}

export const DEFAULT_TOKEN_BUDGET = (): TokenBudget => ({
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  outputTokens: 0,
  usedTokens: 0,
  maxTokens: 0,
  totalProcessedTokens: 0,
  toolUses: 0,
  durationMs: 0,
})

export const defaultTokenBudget = DEFAULT_TOKEN_BUDGET

const SDK_PROBE_CACHE_TTL_MS = 5 * 60 * 1000
let sdkProbeCache: { subscriptionType: string | null; authMethod: "subscription" | "api_key" | null; cachedAt: number } | null = null

export function findAuthMethod(status: any): "subscription" | "api_key" | null {
  if (!status) return null
  if (status.authMethod === "api_key" || status.apiKeyAuth) return "api_key"
  if (status.subscriptionType || status.plan || status.tier) return "subscription"
  if (status.authMethod === "subscription" || status.anthropicAuth) return "subscription"
  return null
}

export function findSubscriptionType(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null
  if (obj.subscriptionType && typeof obj.subscriptionType === "string") return obj.subscriptionType
  if (obj.subscription_type && typeof obj.subscription_type === "string") return obj.subscription_type
  if (obj.plan && typeof obj.plan === "string") return obj.plan
  if (obj.tier && typeof obj.tier === "string") return obj.tier
  for (const key of Object.keys(obj)) {
    if (key !== "toJSON" && typeof obj[key] === "object") {
      const found = findSubscriptionType(obj[key])
      if (found) return found
    }
  }
  return null
}

export async function probeClaudeCapabilities(claudeExecutable: string): Promise<{
  subscriptionType: string | null
  authMethod: "subscription" | "api_key" | null
}> {
  if (sdkProbeCache && Date.now() - sdkProbeCache.cachedAt < SDK_PROBE_CACHE_TTL_MS) {
    return { subscriptionType: sdkProbeCache.subscriptionType, authMethod: sdkProbeCache.authMethod }
  }

  const { query } = await import("@anthropic-ai/claude-agent-sdk")

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)

  try {
    const q = query({
      prompt: "",
      options: {
        maxTurns: 0,
        pathToClaudeCodeExecutable: claudeExecutable,
        abortController: controller,
      },
    })

    const initResult = await q.initializationResult()
    clearTimeout(timeout)

    const subscriptionType = findSubscriptionType(initResult)
    const authMethod = findAuthMethod(initResult) ?? "subscription"

    sdkProbeCache = { subscriptionType, authMethod, cachedAt: Date.now() }

    await q.interrupt()
    return { subscriptionType, authMethod }
  } catch {
    clearTimeout(timeout)
    return { subscriptionType: null, authMethod: null }
  }
}

export function resetSdkProbeCache(): void {
  sdkProbeCache = null
}


const AUTH_STATUS_CACHE_TTL_MS = 60_000
/** Shorter TTL for failed auth checks — retry sooner to recover */
const AUTH_STATUS_FAILURE_TTL_MS = 5_000

// TODO: choose cooldown duration — see trade-offs in commit message
const EXTENDED_CONTEXT_COOLDOWN_MS = 5 * 60 * 1000

/** Timestamps of the last rate-limit hit per [1m] model variant. */
const extendedContextRateLimitedAt: Partial<Record<ClaudeModel, number>> = {}

/**
 * Record that an extended-context model was rate-limited.
 * Called by server.ts when the [1m] → base fallback is triggered.
 * Causes mapModelToClaudeModel to skip the [1m] variant for the cooldown window.
 */
export function recordExtendedContextRateLimit(model: ClaudeModel): void {
  extendedContextRateLimitedAt[model] = Date.now()
}

/** Returns true if the [1m] variant is within its cooldown window. */
function isExtendedContextOnCooldown(model: ClaudeModel): boolean {
  const t = extendedContextRateLimitedAt[model]
  return t !== undefined && Date.now() - t < EXTENDED_CONTEXT_COOLDOWN_MS
}

/** Reset circuit-breaker state — for testing only. */
export function resetExtendedContextCooldown(): void {
  for (const key of Object.keys(extendedContextRateLimitedAt)) {
    delete extendedContextRateLimitedAt[key as ClaudeModel]
  }
}

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
  const isPremium = isPremiumSubscription(subscriptionType)
  // Subagents don't need 1M context — use base model to save rate limit budget
  const isSubagent = agentMode === "subagent"

  if (model.includes("opus")) {
    if (use1m && !isSubagent && !isExtendedContextOnCooldown("opus[1m]")) return "opus[1m]"
    return "opus"
  }

  const sonnetOverride = process.env.MERIDIAN_SONNET_MODEL ?? process.env.CLAUDE_PROXY_SONNET_MODEL
  if (sonnetOverride === "sonnet" || sonnetOverride === "sonnet[1m]") return sonnetOverride

  if (!use1m) return "sonnet"
  if (!isPremium) return "sonnet"
  if (isSubagent) return "sonnet"
  if (isExtendedContextOnCooldown("sonnet[1m]")) return "sonnet"
  return "sonnet[1m]"
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
    // 1. Try the SDK's bundled cli.js (same dir as this module's SDK)
    try {
      const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
      const sdkCliJs = join(dirname(sdkPath), "cli.js")
      if (existsSync(sdkCliJs)) {
        cachedClaudePath = sdkCliJs
        return sdkCliJs
      }
    } catch {}

    // 2. Try the system-installed claude binary
    try {
      const { stdout } = await exec("which claude")
      const claudePath = stdout.trim()
      if (claudePath && existsSync(claudePath)) {
        cachedClaudePath = claudePath
        return claudePath
      }
    } catch {}

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
