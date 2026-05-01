/**
 * Pure helpers for rendering OAuth usage data on the profile page.
 *
 * Lives outside the inline-HTML template in profilePage.ts so the labeling
 * and formatting logic can be unit-tested. The same logic is mirrored in
 * the page's inline browser script — see profilePage.ts.
 *
 * Why duplicate at all? profilePage.ts is one big template literal that
 * runs in the browser, so we can't directly import these at runtime. We
 * inline the constants (via JSON.stringify) and re-implement the small
 * format functions in the template, with these TS versions guarding the
 * behavior via tests.
 */

/** Friendly labels for Anthropic's raw window keys. */
export const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d Opus",
  seven_day_sonnet: "7d Sonnet",
  seven_day_oauth_apps: "7d Apps",
  seven_day_cowork: "7d Cowork",
  seven_day_omelette: "7d Omelette",
}

/**
 * Map a raw window type (e.g. "five_hour", "seven_day_opus") to a short
 * human label. Falls back to a prettified version of the key for any
 * type we haven't named (Anthropic adds new windows occasionally).
 */
export function labelForWindow(type: string): string {
  if (WINDOW_LABELS[type]) return WINDOW_LABELS[type]!
  // Fallback: replace underscores with spaces and capitalize each word.
  return type
    .split("_")
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ")
}

/**
 * Bucket a 0..1 utilization value into a status used for color coding.
 * Mirrors pylon's three-tier scheme: comfortable / warning / hot.
 */
export type UsageStatus = "ok" | "warn" | "high"
export function classifyUtilization(utilization: number | null | undefined): UsageStatus {
  if (utilization == null || !Number.isFinite(utilization)) return "ok"
  if (utilization >= 0.85) return "high"
  if (utilization >= 0.6) return "warn"
  return "ok"
}

/**
 * Format the time-until-reset for a window.
 *
 * `resetsAt` is a Unix epoch in milliseconds (matching Meridian's own
 * /v1/usage/quota response shape) — null when the window has no known
 * reset time.
 *
 * `now` is injectable so tests don't depend on Date.now(); production
 * callers omit it and the function uses the current time.
 */
export function formatResetCountdown(resetsAt: number | null | undefined, now: number = Date.now()): string {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return ""
  const ms = resetsAt - now
  if (ms <= 0) return "resetting…"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  if (hours < 24) return remMin > 0 ? `in ${hours}h ${remMin}m` : `in ${hours}h`
  const days = Math.floor(hours / 24)
  const remHr = hours % 24
  return remHr > 0 ? `in ${days}d ${remHr}h` : `in ${days}d`
}

/**
 * Format an extra-usage block. Returns null when the profile has no
 * extra-usage info worth showing (disabled or missing data) — caller
 * should hide the section entirely in that case.
 */
export interface ExtraUsageDisplay {
  used: string
  limit: string
  utilizationPct: number
  status: UsageStatus
}
export function formatExtraUsage(eu: {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number | null
  currency: string
} | null | undefined): ExtraUsageDisplay | null {
  if (!eu || !eu.isEnabled) return null
  const monthlyLimit = Number.isFinite(eu.monthlyLimit) ? eu.monthlyLimit : 0
  if (monthlyLimit <= 0) return null
  const used = Number.isFinite(eu.usedCredits) ? eu.usedCredits : 0
  const utilization =
    eu.utilization != null && Number.isFinite(eu.utilization)
      ? Math.max(0, Math.min(1, eu.utilization))
      : monthlyLimit > 0
        ? Math.max(0, Math.min(1, used / monthlyLimit))
        : 0
  return {
    used: `${eu.currency || ""}${used.toFixed(2)}`.trim(),
    limit: `${eu.currency || ""}${monthlyLimit.toFixed(2)}`.trim(),
    utilizationPct: Math.round(utilization * 100),
    status: classifyUtilization(utilization),
  }
}
