/**
 * Token usage formatting and cache-hit-rate calculations.
 *
 * Pure functions shared between stderr request logging and telemetry storage.
 * Extracting these out of server.ts guarantees a single source of truth for
 * the cache-hit-rate formula — stderr logs and the telemetry dashboard now
 * agree.
 *
 * Previously `logUsage` computed `cache_read / input_tokens`, but the SDK
 * reports `input_tokens` as *only* the non-cached portion, so the ratio blew
 * past 100% (e.g. `cache=2600000%`) whenever a cache hit actually happened.
 * `computeCacheHitRate` already had the correct formula; this module moves
 * `logUsage` onto the same helper.
 *
 * This module is pure — no I/O, no imports from server.ts or session/.
 */

import type { TokenUsage } from "./session/lineage"

/**
 * Compute the fraction of input tokens served from cache for a single turn.
 *
 * The SDK's `input_tokens` field reports only the non-cached portion, so the
 * true total input size is `input_tokens + cache_read_input_tokens +
 * cache_creation_input_tokens`. Returns a value in [0, 1], or `undefined` if
 * there is no input to measure against.
 */
export function computeCacheHitRate(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined
  const read = usage.cache_read_input_tokens ?? 0
  const creation = usage.cache_creation_input_tokens ?? 0
  const uncached = usage.input_tokens ?? 0
  const total = uncached + read + creation
  if (total === 0) return undefined
  return read / total
}

/**
 * Format an integer token count for compact display.
 *
 *  - values ≤ 1000 → exact integer (e.g. `"847"`)
 *  - values > 1000 → rounded to nearest thousand with "k" suffix (e.g. `"71k"`)
 */
export function formatTokenCount(n: number): string {
  return n > 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/**
 * Build the single-line stderr summary for a request's token usage.
 *
 * Example outputs:
 *   "input=3 output=416 cache_read=71k cache_write=2k cache=97%"
 *   "input=10 output=8 cache_write=59k cache=0%"
 *   "input=1000 output=50"                 (no caching activity)
 *
 * The `cache=XX%` tag is emitted whenever `computeCacheHitRate` returns a
 * defined value. The tag is suppressed only when there is literally no input
 * data to compute a ratio from (neither uncached nor cached).
 */
export function formatUsageSummary(usage: TokenUsage): string {
  const parts = [
    `input=${formatTokenCount(usage.input_tokens ?? 0)}`,
    `output=${formatTokenCount(usage.output_tokens ?? 0)}`,
    ...(usage.cache_read_input_tokens ? [`cache_read=${formatTokenCount(usage.cache_read_input_tokens)}`] : []),
    ...(usage.cache_creation_input_tokens ? [`cache_write=${formatTokenCount(usage.cache_creation_input_tokens)}`] : []),
  ]
  const rate = computeCacheHitRate(usage)
  const cacheTag = rate !== undefined ? ` cache=${Math.round(rate * 100)}%` : ""
  return `${parts.join(" ")}${cacheTag}`
}
