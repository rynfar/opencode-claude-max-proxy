import { describe, it, expect } from "bun:test"
import { validateTransform } from "../proxy/plugins/validation"

describe("validateTransform", () => {
  it("accepts a valid transform with name and onRequest", () => {
    const result = validateTransform({
      name: "test-plugin",
      onRequest: (ctx: any) => ctx,
    })
    expect(result.valid).toBe(true)
    expect(result.hooks).toEqual(["onRequest"])
  })

  it("accepts a transform with all v1 hooks", () => {
    const result = validateTransform({
      name: "full-plugin",
      onRequest: (ctx: any) => ctx,
      onResponse: (ctx: any) => ctx,
      onTelemetry: () => {},
    })
    expect(result.valid).toBe(true)
    expect(result.hooks).toEqual(["onRequest", "onResponse", "onTelemetry"])
  })

  it("accepts a transform with only name (no hooks)", () => {
    const result = validateTransform({ name: "noop" })
    expect(result.valid).toBe(true)
    expect(result.hooks).toEqual([])
  })

  it("rejects null/undefined", () => {
    expect(validateTransform(null).valid).toBe(false)
    expect(validateTransform(undefined).valid).toBe(false)
  })

  it("rejects non-object values", () => {
    expect(validateTransform("string").valid).toBe(false)
    expect(validateTransform(42).valid).toBe(false)
  })

  it("rejects object without name", () => {
    const result = validateTransform({ onRequest: () => {} })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects object with non-string name", () => {
    const result = validateTransform({ name: 123 })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("name")
  })

  it("rejects hooks that are not functions", () => {
    const result = validateTransform({ name: "bad", onRequest: "not a function" })
    expect(result.valid).toBe(false)
    expect(result.error).toContain("onRequest")
  })

  it("warns on unknown adapter names but still validates", () => {
    const result = validateTransform({
      name: "scoped",
      adapters: ["opencode", "unknown-agent"],
    })
    expect(result.valid).toBe(true)
    expect(result.warnings).toContain("unknown-agent")
  })
})
