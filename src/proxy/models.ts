/**
 * Model mapping and Claude executable resolution.
 */

import { exec as execCallback } from "child_process"
import { existsSync, statSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { promisify } from "util"

const exec = promisify(execCallback)

/**
 * Files smaller than this are treated as the placeholder stub that
 * `@anthropic-ai/claude-code/install.cjs` writes when the platform-specific
 * binary fails to install. The real Claude Code binary is ~200 MB; the stub
 * is ~500 bytes. Anything under 4 KB is the stub. Used in the bundled-binary
 * resolver step to avoid handing the proxy a non-functional placeholder when
 * upstream postinstall fails (see issue #445).
 */
const STUB_SIZE_THRESHOLD = 4096

export type ClaudeModel = "sonnet" | "sonnet[1m]" | "opus" | "opus[1m]" | "haiku"

/**
 * Current canonical pins for the `sonnet`/`opus`/`haiku` SDK aliases.
 *
 * mapModelToClaudeModel collapses every requested model to one of these
 * aliases; the Claude Agent SDK then resolves the alias to a concrete
 * version via ANTHROPIC_DEFAULT_{TYPE}_MODEL env vars. When those env
 * vars are unset the SDK falls back to its own bundled defaults, which
 * lag real Claude Max availability — users end up routed to stale
 * versions (this was the root cause of #419: opus-* requests silently
 * answering as sonnet-4).
 *
 * Meridian now pins these defaults itself at the SDK subprocess boundary
 * so fresh installs behave correctly out of the box. Users can still
 * override via MERIDIAN_DEFAULT_{TYPE}_MODEL (proxy-side) or
 * ANTHROPIC_DEFAULT_{TYPE}_MODEL (shell env, wins over Meridian's pin).
 */
export const CANONICAL_OPUS_MODEL = "claude-opus-4-7"
export const CANONICAL_SONNET_MODEL = "claude-sonnet-4-6"
export const CANONICAL_HAIKU_MODEL = "claude-haiku-4-5"

/**
 * Build the ANTHROPIC_DEFAULT_{TYPE}_MODEL env record to apply before the
 * inherited process env, so user-set shell values still win but unset
 * variables get Meridian's canonical pins.
 */
export function resolveSdkModelDefaults(): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.MERIDIAN_DEFAULT_OPUS_MODEL ?? CANONICAL_OPUS_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.MERIDIAN_DEFAULT_SONNET_MODEL ?? CANONICAL_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.MERIDIAN_DEFAULT_HAIKU_MODEL ?? CANONICAL_HAIKU_MODEL,
  }
}
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
/**
 * Resolver step contract — each tries one source, returns a path on success
 * or null on miss. Failures (thrown errors) are caught by the caller and
 * treated as misses so unresolved sources never block subsequent steps.
 */
type ResolverDeps = {
  existsSync: (p: string) => boolean
  statSync: (p: string) => { size: number }
  exec: (cmd: string) => Promise<{ stdout: string }>
  resolvePackage: (specifier: string) => string
  envGet: (name: string) => string | undefined
  platform: NodeJS.Platform
  arch: string
  isBun: boolean
}

const DEFAULT_DEPS: ResolverDeps = {
  existsSync,
  statSync: (p) => statSync(p),
  exec,
  resolvePackage: (specifier) => fileURLToPath(import.meta.resolve(specifier)),
  envGet: (name) => process.env[name],
  platform: process.platform,
  arch: process.arch,
  isBun: typeof process.versions.bun !== "undefined",
}

/**
 * Step 0: explicit env override. Non-empty MERIDIAN_CLAUDE_PATH wins
 * unconditionally, so users with broken installs / unusual setups can
 * always point at a known-good binary. Mirrors the escape-hatch
 * convention used by other proxy env vars.
 */
function tryEnvOverride(deps: ResolverDeps): string | null {
  const explicit = deps.envGet("MERIDIAN_CLAUDE_PATH")
  if (!explicit) return null
  return deps.existsSync(explicit) ? explicit : null
}

/**
 * Step 1: bundled `@anthropic-ai/claude-code/bin/claude.exe`.
 *
 * Skips the placeholder stub (≤4 KB) so we don't return a non-functional
 * file when the upstream postinstall failed (issue #445). The real
 * platform binary is ~200 MB; the stub is ~500 bytes.
 */
function tryBundledBinary(deps: ResolverDeps): string | null {
  try {
    const pkgPath = deps.resolvePackage("@anthropic-ai/claude-code/package.json")
    const bundled = join(dirname(pkgPath), "bin", "claude.exe")
    if (!deps.existsSync(bundled)) return null
    const size = deps.statSync(bundled).size
    if (size <= STUB_SIZE_THRESHOLD) return null
    return bundled
  } catch {
    return null
  }
}

/**
 * Step 2: platform-specific peer package
 * (`@anthropic-ai/claude-code-<platform>-<arch>`). This is where the
 * actual binary lives in the SDK ≥ 0.2.x split layout — the wrapper at
 * `claude-code/bin/claude.exe` is just a hardlink/copy from here.
 *
 * Bypasses the bundled-binary path entirely, so it works when the
 * upstream postinstall failed to do the link (#445) AND when the
 * bundled wrapper exists but fails to spawn on the host (#417 — Windows
 * `spawn UNKNOWN` reported by BenIsLegit, where the wrapper failed but
 * the platform-package binary worked).
 */
function tryPlatformPackage(deps: ResolverDeps): string | null {
  const binName = deps.platform === "win32" ? "claude.exe" : "claude"
  const candidates = [`@anthropic-ai/claude-code-${deps.platform}-${deps.arch}`]
  // Linux musl variant — claude-code ships a separate package for Alpine
  // and other musl-based distros.
  if (deps.platform === "linux") {
    candidates.push(`@anthropic-ai/claude-code-${deps.platform}-${deps.arch}-musl`)
  }
  for (const pkg of candidates) {
    try {
      const pkgJson = deps.resolvePackage(`${pkg}/package.json`)
      const candidate = join(dirname(pkgJson), binName)
      if (deps.existsSync(candidate)) return candidate
    } catch {
      // Package not installed for this arch — try the next candidate.
    }
  }
  return null
}

/**
 * Step 3: PATH lookup via `where claude` on Windows or `which claude` on POSIX.
 *
 * Windows nuances handled here:
 *   - `where` returns multiple newline-separated paths when multiple
 *     binaries match — pick the first one that exists.
 *   - On systems with Git for Windows installed, plain `which claude`
 *     would invoke `which.exe` from `usr/bin/` which emits mingw-style
 *     paths like `/c/nvm4w/nodejs/claude` that `existsSync` rejects.
 *     Using `where` (the cmd.exe builtin / PowerShell-equivalent)
 *     avoids that whole class of bugs.
 *
 * Filtering: any path that starts with `/` on Windows is a mingw-style
 * path (real Windows paths start with a drive letter); skip them rather
 * than feed unusable strings to `existsSync`.
 */
async function tryPathLookup(deps: ResolverDeps): Promise<string | null> {
  const cmd = deps.platform === "win32" ? "where claude" : "which claude"
  try {
    const { stdout } = await deps.exec(cmd)
    const candidates = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    for (const candidate of candidates) {
      if (deps.platform === "win32" && candidate.startsWith("/")) continue
      if (deps.existsSync(candidate)) return candidate
    }
  } catch {
    // No `claude` on PATH (or `where`/`which` not available).
  }
  return null
}

/**
 * Step 4: legacy SDK bundled cli.js (SDK < 0.2.98 only — removed in
 * 0.2.98+). Best-effort fallback for stale bun installs; no-op for
 * fresh ones.
 */
function tryLegacySdkCliJs(deps: ResolverDeps): string | null {
  if (!deps.isBun) return null
  try {
    const sdkPath = deps.resolvePackage("@anthropic-ai/claude-agent-sdk")
    const cliJs = join(dirname(sdkPath), "cli.js")
    return deps.existsSync(cliJs) ? cliJs : null
  } catch {
    return null
  }
}

/**
 * Pure resolver — runs each step and returns the first hit, or null when
 * all steps miss. Exported for unit tests; production callers use
 * resolveClaudeExecutableAsync, which adds caching on top.
 */
export async function resolveClaudeExecutable(deps: ResolverDeps = DEFAULT_DEPS): Promise<string | null> {
  return (
    tryEnvOverride(deps) ??
    tryBundledBinary(deps) ??
    tryPlatformPackage(deps) ??
    (await tryPathLookup(deps)) ??
    tryLegacySdkCliJs(deps)
  )
}

export async function resolveClaudeExecutableAsync(): Promise<string> {
  if (cachedClaudePath) return cachedClaudePath
  if (cachedClaudePathPromise) return cachedClaudePathPromise

  cachedClaudePathPromise = (async () => {
    const resolved = await resolveClaudeExecutable()
    if (resolved) {
      cachedClaudePath = resolved
      return resolved
    }
    throw new Error(
      "Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code, " +
      "or set MERIDIAN_CLAUDE_PATH=/path/to/claude to point at an existing binary.",
    )
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
