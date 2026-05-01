/**
 * Unit tests for profile-page usage helpers — pure functions, no mocks.
 */
import { describe, it, expect } from "bun:test"
import {
  WINDOW_LABELS,
  labelForWindow,
  classifyUtilization,
  formatResetCountdown,
  formatExtraUsage,
} from "../telemetry/profileUsage"

describe("labelForWindow", () => {
  it("maps every documented Anthropic window type", () => {
    expect(labelForWindow("five_hour")).toBe("5h")
    expect(labelForWindow("seven_day")).toBe("7d")
    expect(labelForWindow("seven_day_opus")).toBe("7d Opus")
    expect(labelForWindow("seven_day_sonnet")).toBe("7d Sonnet")
    expect(labelForWindow("seven_day_oauth_apps")).toBe("7d Apps")
    expect(labelForWindow("seven_day_cowork")).toBe("7d Cowork")
    expect(labelForWindow("seven_day_omelette")).toBe("7d Omelette")
  })

  it("falls back gracefully for unknown window types", () => {
    expect(labelForWindow("twelve_minute_extra")).toBe("Twelve Minute Extra")
    expect(labelForWindow("brand_new_bucket")).toBe("Brand New Bucket")
  })

  it("handles single-word and edge-case keys without crashing", () => {
    expect(labelForWindow("hourly")).toBe("Hourly")
    expect(labelForWindow("")).toBe("")
  })

  it("WINDOW_LABELS export is non-empty so the page can inline it", () => {
    expect(Object.keys(WINDOW_LABELS).length).toBeGreaterThan(0)
  })
})

describe("classifyUtilization", () => {
  it("returns 'ok' for low utilization", () => {
    expect(classifyUtilization(0)).toBe("ok")
    expect(classifyUtilization(0.3)).toBe("ok")
    expect(classifyUtilization(0.59)).toBe("ok")
  })

  it("returns 'warn' between 60% and 85%", () => {
    expect(classifyUtilization(0.6)).toBe("warn")
    expect(classifyUtilization(0.7)).toBe("warn")
    expect(classifyUtilization(0.84)).toBe("warn")
  })

  it("returns 'high' at 85% or above", () => {
    expect(classifyUtilization(0.85)).toBe("high")
    expect(classifyUtilization(0.99)).toBe("high")
    expect(classifyUtilization(1)).toBe("high")
  })

  it("treats null/undefined/NaN as 'ok' (no data → neutral color)", () => {
    expect(classifyUtilization(null)).toBe("ok")
    expect(classifyUtilization(undefined)).toBe("ok")
    expect(classifyUtilization(Number.NaN)).toBe("ok")
  })
})

describe("formatResetCountdown", () => {
  const now = 1_700_000_000_000

  it("returns empty string when no reset is provided", () => {
    expect(formatResetCountdown(null, now)).toBe("")
    expect(formatResetCountdown(undefined, now)).toBe("")
  })

  it("returns 'resetting…' when reset has already passed", () => {
    expect(formatResetCountdown(now - 1000, now)).toBe("resetting…")
    expect(formatResetCountdown(now, now)).toBe("resetting…")
  })

  it("formats minute-resolution windows under an hour", () => {
    expect(formatResetCountdown(now + 5 * 60_000, now)).toBe("in 5m")
    expect(formatResetCountdown(now + 59 * 60_000, now)).toBe("in 59m")
  })

  it("rounds sub-minute resets up to 1m so we never show '0m'", () => {
    expect(formatResetCountdown(now + 30_000, now)).toBe("in 1m")
  })

  it("formats hour-resolution windows under a day", () => {
    expect(formatResetCountdown(now + 2 * 3_600_000, now)).toBe("in 2h")
    expect(formatResetCountdown(now + 2 * 3_600_000 + 14 * 60_000, now)).toBe("in 2h 14m")
    expect(formatResetCountdown(now + 23 * 3_600_000 + 59 * 60_000, now)).toBe("in 23h 59m")
  })

  it("formats day-resolution windows over a day", () => {
    expect(formatResetCountdown(now + 24 * 3_600_000, now)).toBe("in 1d")
    expect(formatResetCountdown(now + (24 + 5) * 3_600_000, now)).toBe("in 1d 5h")
    expect(formatResetCountdown(now + 7 * 24 * 3_600_000, now)).toBe("in 7d")
  })

  it("works without an injected now (defaults to Date.now)", () => {
    const out = formatResetCountdown(Date.now() + 90 * 60_000)
    expect(out.startsWith("in ")).toBe(true)
  })
})

describe("formatExtraUsage", () => {
  it("returns null when extraUsage is missing", () => {
    expect(formatExtraUsage(null)).toBeNull()
    expect(formatExtraUsage(undefined)).toBeNull()
  })

  it("returns null when not enabled", () => {
    expect(
      formatExtraUsage({
        isEnabled: false,
        monthlyLimit: 50,
        usedCredits: 10,
        utilization: 0.2,
        currency: "$",
      }),
    ).toBeNull()
  })

  it("returns null when monthly limit is zero or missing", () => {
    expect(
      formatExtraUsage({
        isEnabled: true,
        monthlyLimit: 0,
        usedCredits: 0,
        utilization: 0,
        currency: "$",
      }),
    ).toBeNull()
  })

  it("formats currency-prefixed used / limit correctly", () => {
    const out = formatExtraUsage({
      isEnabled: true,
      monthlyLimit: 100,
      usedCredits: 42.5,
      utilization: 0.425,
      currency: "$",
    })
    expect(out).not.toBeNull()
    expect(out!.used).toBe("$42.50")
    expect(out!.limit).toBe("$100.00")
    expect(out!.utilizationPct).toBe(43)
    expect(out!.status).toBe("ok")
  })

  it("handles missing currency string", () => {
    const out = formatExtraUsage({
      isEnabled: true,
      monthlyLimit: 50,
      usedCredits: 25,
      utilization: 0.5,
      currency: "",
    })
    expect(out!.used).toBe("25.00")
    expect(out!.limit).toBe("50.00")
  })

  it("computes utilization from used/limit when explicit utilization is missing", () => {
    const out = formatExtraUsage({
      isEnabled: true,
      monthlyLimit: 100,
      usedCredits: 90,
      utilization: null,
      currency: "$",
    })
    expect(out!.utilizationPct).toBe(90)
    expect(out!.status).toBe("high")
  })

  it("clamps utilization to [0, 1] before classifying", () => {
    const overshoot = formatExtraUsage({
      isEnabled: true,
      monthlyLimit: 100,
      usedCredits: 150,
      utilization: 1.5,
      currency: "$",
    })
    expect(overshoot!.utilizationPct).toBe(100)
    expect(overshoot!.status).toBe("high")
  })
})
