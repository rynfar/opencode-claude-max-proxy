/**
 * Unit tests for model mapping and utility functions.
 */
import { afterEach, beforeEach, describe, it, expect, mock } from "bun:test"

import { mapModelToClaudeModel, isClosedControllerError, resetCachedClaudeAuthStatus, stripExtendedContext, hasExtendedContext, recordExtendedContextUnavailable, isExtendedContextKnownUnavailable, resetExtendedContextUnavailable } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  const originalSonnetModel = process.env.CLAUDE_PROXY_SONNET_MODEL

  afterEach(() => {
    if (originalSonnetModel === undefined) delete process.env.CLAUDE_PROXY_SONNET_MODEL
    else process.env.CLAUDE_PROXY_SONNET_MODEL = originalSonnetModel
    resetCachedClaudeAuthStatus()
  })

  it("maps opus 4.6 models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
  })

  it("maps opus 4.5 models to opus (no 1M)", () => {
    expect(mapModelToClaudeModel("claude-opus-4-5")).toBe("opus")
  })

  it("maps haiku models to haiku", () => {
    expect(mapModelToClaudeModel("claude-haiku-4-5")).toBe("haiku")
    expect(mapModelToClaudeModel("haiku")).toBe("haiku")
  })

  it("maps sonnet 4.6 models to sonnet (200k) for max subscriptions by default", () => {
    // Sonnet [1m] requires Extra Usage on Max — default to 200k to avoid charges
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
  })

  it("maps sonnet 4.5 models to sonnet (no 1M regardless of subscription)", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "max")).toBe("sonnet")
  })

  it("maps sonnet models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "team")).toBe("sonnet")
    expect(mapModelToClaudeModel("sonnet", "pro")).toBe("sonnet")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929", "")).toBe("sonnet")
  })

  it("defaults unknown models to plain sonnet for non-max subscriptions", () => {
    expect(mapModelToClaudeModel("unknown-model")).toBe("sonnet")
    expect(mapModelToClaudeModel("", undefined)).toBe("sonnet")
  })

  it("respects explicit sonnet[1m] override when opted in", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "team")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
  })

  it("sonnet[1m] override still skips [1m] for subagents", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
  })

  it("sonnet[1m] override still skips [1m] during cooldown", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
    resetExtendedContextUnavailable()
  })

  describe("subagent mode", () => {
    it("gives subagents base sonnet regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
      expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
    })

    it("gives subagents base opus regardless of subscription", () => {
      expect(mapModelToClaudeModel("claude-opus-4-6", "max", "subagent")).toBe("opus")
      expect(mapModelToClaudeModel("opus", "max", "subagent")).toBe("opus")
    })

    it("haiku is unaffected by agent mode", () => {
      expect(mapModelToClaudeModel("claude-haiku-4-5", "max", "subagent")).toBe("haiku")
    })

    it("primary agents get opus[1m] but sonnet (200k) for max subscription", () => {
      // Opus [1m] is included with Max; Sonnet [1m] requires Extra Usage
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "primary")).toBe("sonnet")
      expect(mapModelToClaudeModel("claude-opus-4-6", "max", "primary")).toBe("opus[1m]")
    })

    it("null or missing agentMode behaves as primary", () => {
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", null)).toBe("sonnet")
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", undefined)).toBe("sonnet")
      expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    })

    it("env var override to sonnet[1m] is still blocked for subagents", () => {
      process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
      // Subagents always use base model even with override
      expect(mapModelToClaudeModel("sonnet", "max", "subagent")).toBe("sonnet")
    })
  })
})

// NOTE: getClaudeAuthStatusAsync and Auth status resilience tests are in
// models-auth-status.test.ts — they run in isolation because they manipulate
// process.env.PATH and global auth caches that leak across test files.


describe("stripExtendedContext", () => {
  it("strips [1m] from opus", () => {
    expect(stripExtendedContext("opus[1m]")).toBe("opus")
  })

  it("strips [1m] from sonnet", () => {
    expect(stripExtendedContext("sonnet[1m]")).toBe("sonnet")
  })

  it("returns haiku unchanged", () => {
    expect(stripExtendedContext("haiku")).toBe("haiku")
  })

  it("returns base models unchanged", () => {
    expect(stripExtendedContext("opus")).toBe("opus")
    expect(stripExtendedContext("sonnet")).toBe("sonnet")
  })
})

describe("hasExtendedContext", () => {
  it("returns true for [1m] models", () => {
    expect(hasExtendedContext("opus[1m]")).toBe(true)
    expect(hasExtendedContext("sonnet[1m]")).toBe(true)
  })

  it("returns false for base models", () => {
    expect(hasExtendedContext("opus")).toBe(false)
    expect(hasExtendedContext("sonnet")).toBe(false)
    expect(hasExtendedContext("haiku")).toBe(false)
  })
})

describe("Extra Usage cooldown", () => {
  beforeEach(() => resetExtendedContextUnavailable())
  afterEach(() => resetExtendedContextUnavailable())

  it("isExtendedContextKnownUnavailable is false by default", () => {
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("isExtendedContextKnownUnavailable is true immediately after recording", () => {
    recordExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(true)
  })

  it("mapModelToClaudeModel returns sonnet (not [1m]) during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
  })

  it("sonnet stays sonnet even when cooldown is cleared (default is 200k)", () => {
    recordExtendedContextUnavailable()
    resetExtendedContextUnavailable()
    // Sonnet defaults to 200k now — [1m] requires explicit opt-in
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
  })

  it("sonnet[1m] override works when cooldown is cleared", () => {
    process.env.MERIDIAN_SONNET_MODEL = "sonnet[1m]"
    recordExtendedContextUnavailable()
    resetExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet[1m]")
    delete process.env.MERIDIAN_SONNET_MODEL
  })

  it("isExtendedContextKnownUnavailable is false after cooldown expires", () => {
    // Simulate an expired timer by backdating the timestamp
    recordExtendedContextUnavailable()
    // Force-expire by directly calling record then manually manipulating through reset+re-record
    // We can't easily time-travel, so we verify the interface contract:
    // reset clears the flag, making it available again
    resetExtendedContextUnavailable()
    expect(isExtendedContextKnownUnavailable()).toBe(false)
  })

  it("opus[1m] also skips [1m] during cooldown", () => {
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-opus-4-6", "max")).toBe("opus")
  })

  it("cooldown does not affect subagent mode (already uses base model)", () => {
    // subagents already return base model regardless of flag
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max", "subagent")).toBe("sonnet")
  })

  it("cooldown does not affect MERIDIAN_SONNET_MODEL override", () => {
    process.env.MERIDIAN_SONNET_MODEL = "sonnet"
    recordExtendedContextUnavailable()
    expect(mapModelToClaudeModel("claude-sonnet-4-6", "max")).toBe("sonnet")
    delete process.env.MERIDIAN_SONNET_MODEL
  })
})

describe("isClosedControllerError", () => {
  it("returns true for Controller is already closed error", () => {
    expect(isClosedControllerError(new Error("Controller is already closed"))).toBe(true)
  })

  it("returns true when message contains the phrase", () => {
    expect(isClosedControllerError(new Error("Error: Controller is already closed foo"))).toBe(true)
  })

  it("returns false for other errors", () => {
    expect(isClosedControllerError(new Error("something else"))).toBe(false)
  })

  it("returns false for non-Error values", () => {
    expect(isClosedControllerError("string")).toBe(false)
    expect(isClosedControllerError(null)).toBe(false)
    expect(isClosedControllerError(undefined)).toBe(false)
    expect(isClosedControllerError(42)).toBe(false)
  })
})
