/**
 * Unit tests for model mapping and utility functions.
 */
import { afterEach, describe, it, expect } from "bun:test"
import { mapModelToClaudeModel, isClosedControllerError, resetCachedClaudeAuthStatus } from "../proxy/models"

describe("mapModelToClaudeModel", () => {
  const originalSonnetModel = process.env.CLAUDE_PROXY_SONNET_MODEL

  afterEach(() => {
    if (originalSonnetModel === undefined) delete process.env.CLAUDE_PROXY_SONNET_MODEL
    else process.env.CLAUDE_PROXY_SONNET_MODEL = originalSonnetModel
    resetCachedClaudeAuthStatus()
  })
  it("maps opus models to opus[1m]", () => {
    expect(mapModelToClaudeModel("claude-opus-4-5")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("opus")).toBe("opus[1m]")
    expect(mapModelToClaudeModel("claude-opus-4-6")).toBe("opus[1m]")
  })

  it("maps haiku models to haiku", () => {
    expect(mapModelToClaudeModel("claude-haiku-4-5")).toBe("haiku")
    expect(mapModelToClaudeModel("haiku")).toBe("haiku")
  })

  it("maps sonnet models to sonnet[1m] for max subscriptions", () => {
    expect(mapModelToClaudeModel("claude-sonnet-4-5", "max")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet[1m]")
    expect(mapModelToClaudeModel("claude-sonnet-4-5-20250929", "max")).toBe("sonnet[1m]")
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

  it("respects explicit sonnet model override", () => {
    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet[1m]"
    expect(mapModelToClaudeModel("sonnet", "team")).toBe("sonnet[1m]")

    process.env.CLAUDE_PROXY_SONNET_MODEL = "sonnet"
    expect(mapModelToClaudeModel("sonnet", "max")).toBe("sonnet")
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
