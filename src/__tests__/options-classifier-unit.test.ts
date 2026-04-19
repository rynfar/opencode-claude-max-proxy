import { describe, expect, it } from "bun:test"

import {
  classifyOptionsDrift,
  snapshotOptions,
  type RuntimeOptionsSnapshot,
} from "../proxy/session/optionsClassifier"
import { stripCacheControl } from "../proxy/contentSanitizer"

const baseReopenCritical = {
  cwd: "/project",
  systemPrompt: "You are a helpful assistant.",
  allowedTools: ["mcp__pi__read", "mcp__pi__write"] as readonly string[],
  disallowedTools: [] as readonly string[],
  mcpServerNames: ["pi"] as readonly string[],
}

function makeSnapshot(overrides: Partial<RuntimeOptionsSnapshot["inPlace"]> = {}): RuntimeOptionsSnapshot {
  return snapshotOptions(baseReopenCritical, {
    model: "claude-sonnet-4-5",
    effort: "medium",
    thinking: { type: "adaptive" },
    ...overrides,
  })
}

describe("snapshotOptions", () => {
  it("produces a stable hash for identical inputs", () => {
    const a = snapshotOptions(baseReopenCritical, { model: "x" })
    const b = snapshotOptions({ ...baseReopenCritical }, { model: "x" })
    expect(a.reopenCriticalHash).toBe(b.reopenCriticalHash)
    expect(a.reopenCriticalHash).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("classifyOptionsDrift — reopen-critical drift", () => {
  it("flags hashMismatch when cwd changes", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: { ...baseReopenCritical, cwd: "/different" },
      inPlace: { model: "claude-sonnet-4-5", effort: "medium", thinking: { type: "adaptive" } },
    }, snapshot)
    expect(result.hashMismatch).toBe(true)
    expect(result.inPlaceUpdates).toEqual([])
  })

  it("flags hashMismatch when systemPrompt changes", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: { ...baseReopenCritical, systemPrompt: "Different prompt" },
      inPlace: { model: "claude-sonnet-4-5" },
    }, snapshot)
    expect(result.hashMismatch).toBe(true)
  })

  it("flags hashMismatch when the tool surface changes", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: { ...baseReopenCritical, allowedTools: ["mcp__pi__read"] },
      inPlace: { model: "claude-sonnet-4-5" },
    }, snapshot)
    expect(result.hashMismatch).toBe(true)
  })
})

describe("classifyOptionsDrift — in-place updates", () => {
  it("emits setModel when model changes and hash is stable", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: baseReopenCritical,
      inPlace: { model: "claude-opus-4-6", effort: "medium", thinking: { type: "adaptive" } },
    }, snapshot)
    expect(result.hashMismatch).toBe(false)
    expect(result.inPlaceUpdates).toEqual([{ kind: "setModel", model: "claude-opus-4-6" }])
  })

  it("emits applyFlagSettings with only the changed effort field", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: baseReopenCritical,
      inPlace: { model: "claude-sonnet-4-5", effort: "high", thinking: { type: "adaptive" } },
    }, snapshot)
    expect(result.hashMismatch).toBe(false)
    expect(result.inPlaceUpdates).toEqual([{ kind: "applyFlagSettings", settings: { effort: "high" } }])
  })

  it("emits both setModel and applyFlagSettings when both change", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: baseReopenCritical,
      inPlace: { model: "claude-opus-4-6", effort: "high", thinking: { type: "enabled", budgetTokens: 8000 } },
    }, snapshot)
    expect(result.hashMismatch).toBe(false)
    expect(result.inPlaceUpdates).toEqual([
      { kind: "setModel", model: "claude-opus-4-6" },
      { kind: "applyFlagSettings", settings: { effort: "high", thinking: { type: "enabled", budgetTokens: 8000 } } },
    ])
  })

  it("returns no updates when nothing changed", () => {
    const snapshot = makeSnapshot()
    const result = classifyOptionsDrift({
      reopenCritical: baseReopenCritical,
      inPlace: { model: "claude-sonnet-4-5", effort: "medium", thinking: { type: "adaptive" } },
    }, snapshot)
    expect(result.hashMismatch).toBe(false)
    expect(result.inPlaceUpdates).toEqual([])
  })

  it("treats deep-equal thinking objects as unchanged (no churn from new object identity)", () => {
    const snapshot = makeSnapshot({ thinking: { type: "enabled", budgetTokens: 4000 } })
    const result = classifyOptionsDrift({
      reopenCritical: baseReopenCritical,
      inPlace: { model: "claude-sonnet-4-5", effort: "medium", thinking: { type: "enabled", budgetTokens: 4000 } },
    }, snapshot)
    expect(result.inPlaceUpdates).toEqual([])
  })
})

describe("stripCacheControl", () => {
  it("strips cache_control from a top-level text block", () => {
    const input = [
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]
    expect(stripCacheControl(input)).toEqual([{ type: "text", text: "hello" }])
  })

  it("strips cache_control nested inside tool_result.content", () => {
    const input = [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "file contents", cache_control: { type: "ephemeral" } },
        ],
        cache_control: { type: "ephemeral" },
      },
    ]
    expect(stripCacheControl(input)).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: "file contents" }],
      },
    ])
  })

  it("passes strings and primitives through unchanged", () => {
    expect(stripCacheControl("plain text")).toBe("plain text")
    expect(stripCacheControl(42)).toBe(42)
    expect(stripCacheControl(null)).toBeNull()
  })

  it("preserves non-cache_control fields on blocks", () => {
    const input = [
      { type: "text", text: "x", cache_control: { type: "ephemeral" }, some_meta: "keep" },
    ]
    expect(stripCacheControl(input)).toEqual([{ type: "text", text: "x", some_meta: "keep" }])
  })

  it("handles arrays of mixed content", () => {
    const input = [
      { type: "text", text: "one", cache_control: { type: "ephemeral" } },
      { type: "image", source: { type: "base64", data: "..." } },
      { type: "tool_result", tool_use_id: "t1", content: "string result", cache_control: { type: "ephemeral" } },
    ]
    expect(stripCacheControl(input)).toEqual([
      { type: "text", text: "one" },
      { type: "image", source: { type: "base64", data: "..." } },
      { type: "tool_result", tool_use_id: "t1", content: "string result" },
    ])
  })

  it("is idempotent (strip-of-strip equals strip)", () => {
    const input = [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }]
    expect(stripCacheControl(stripCacheControl(input))).toEqual(stripCacheControl(input))
  })
})
