/**
 * anthropic-beta header filtering for Max vs API profiles.
 *
 * Some betas (e.g. `extended-cache-ttl-*`) trigger Extra-Usage billing on
 * Claude Max subscriptions. The default `allow-safe` policy strips only those
 * for claude-max profiles while forwarding everything else so that prompt
 * caching, 1M context, fine-grained tool streaming, and interleaved thinking
 * continue to work as the SDK expects.
 *
 * Unconditional stripping (the previous behaviour) caused cache misses on
 * every turn, which tripled TTFB and inflated token consumption roughly 3x on
 * long conversations. See issue #278 for the original context.
 *
 * An operator can override the policy at runtime via the `MERIDIAN_BETA_POLICY`
 * env var to force `strip-all` (safest — old behaviour) or `allow-all`
 * (most permissive — matches api-profile behaviour) without a rebuild.
 *
 * This module is pure — no I/O, no imports from server.ts or session/.
 */

import type { ProfileType } from "./profiles"

/**
 * Beta prefixes that are known to trigger Extra-Usage billing on Max accounts.
 *
 * A beta is considered billable if its name starts with any of these strings.
 * Keep this list conservative — prefer allowing unknown betas through over
 * silently stripping something the SDK needs for normal operation.
 */
export const BILLABLE_BETA_PREFIXES_ON_MAX: readonly string[] = [
  "extended-cache-ttl-",
]

/**
 * Runtime policy for `anthropic-beta` header handling on claude-max profiles.
 *
 * - `allow-safe` (default): forward all betas except those matching
 *   {@link BILLABLE_BETA_PREFIXES_ON_MAX}. Restores prompt caching + 1M
 *   context while keeping the original billing-safety intent.
 * - `strip-all`: the pre-fix (1.28.0 – 1.29.x) behaviour. Drops every beta
 *   for claude-max profiles. Use this as a kill switch if the allow-safe
 *   policy ever causes quota surprises.
 * - `allow-all`: forward every beta unconditionally, same as api profiles.
 *   Use only if you've verified your Max tier treats all betas as free.
 */
export type BetaPolicy = "allow-safe" | "strip-all" | "allow-all"

export const DEFAULT_BETA_POLICY: BetaPolicy = "allow-safe"

export interface BetaFilterResult {
  /** Betas to forward upstream. `undefined` means no header should be sent. */
  forwarded: string[] | undefined
  /** Betas that were removed. Empty for api-type profiles. */
  stripped: string[]
}

/**
 * Read the beta policy from the `MERIDIAN_BETA_POLICY` env var.
 *
 * Falls back to {@link DEFAULT_BETA_POLICY} for missing or invalid values.
 * Invalid values are silently ignored rather than crashing the proxy.
 */
export function getBetaPolicyFromEnv(): BetaPolicy {
  const raw = process.env.MERIDIAN_BETA_POLICY
  if (raw === "allow-safe" || raw === "strip-all" || raw === "allow-all") {
    return raw
  }
  return DEFAULT_BETA_POLICY
}

/**
 * Filter an `anthropic-beta` header value for the given profile type.
 *
 * - For `api` profiles, all betas pass through unchanged regardless of policy.
 * - For `claude-max` profiles, behaviour depends on `policy`:
 *   - `allow-safe` (default): strip only billable betas
 *     (see {@link BILLABLE_BETA_PREFIXES_ON_MAX}).
 *   - `strip-all`: strip every beta.
 *   - `allow-all`: forward every beta unchanged.
 * - Whitespace and empty entries are trimmed.
 * - Returns `forwarded: undefined` when the result would be an empty list so
 *   callers can omit the header entirely.
 */
export function filterBetasForProfile(
  rawBetaHeader: string | undefined,
  profileType: ProfileType,
  policy: BetaPolicy = DEFAULT_BETA_POLICY,
): BetaFilterResult {
  if (!rawBetaHeader) {
    return { forwarded: undefined, stripped: [] }
  }

  const parsed = rawBetaHeader
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)

  if (parsed.length === 0) {
    return { forwarded: undefined, stripped: [] }
  }

  // api profiles always pass through unchanged — policy only applies to claude-max.
  if (profileType === "api") {
    return { forwarded: parsed, stripped: [] }
  }

  if (policy === "allow-all") {
    return { forwarded: parsed, stripped: [] }
  }

  if (policy === "strip-all") {
    return { forwarded: undefined, stripped: parsed }
  }

  // allow-safe: strip only known-billable betas.
  const forwarded: string[] = []
  const stripped: string[] = []
  for (const beta of parsed) {
    if (BILLABLE_BETA_PREFIXES_ON_MAX.some((prefix) => beta.startsWith(prefix))) {
      stripped.push(beta)
    } else {
      forwarded.push(beta)
    }
  }

  return {
    forwarded: forwarded.length > 0 ? forwarded : undefined,
    stripped,
  }
}
