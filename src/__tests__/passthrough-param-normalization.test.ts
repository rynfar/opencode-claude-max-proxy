import { describe, expect, it } from "bun:test"
import { normalizeToolInput } from "../proxy/passthroughTools"

describe("normalizeToolInput", () => {
  it("returns input unchanged when all required fields are present", () => {
    const input = { filePath: "/src/app.ts", offset: 0 }
    const schema = {
      properties: { filePath: { type: "string" }, offset: { type: "number" } },
      required: ["filePath"],
    }
    expect(normalizeToolInput(input, schema)).toEqual(input)
  })

  it("converts snake_case to camelCase when required field is missing", () => {
    const input = { file_path: "/src/app.ts" }
    const schema = {
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    }
    expect(normalizeToolInput(input, schema)).toEqual({ filePath: "/src/app.ts" })
  })

  it("converts camelCase to snake_case when required field is missing", () => {
    const input = { filePath: "/src/app.ts" }
    const schema = {
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
    }
    expect(normalizeToolInput(input, schema)).toEqual({ file_path: "/src/app.ts" })
  })

  it("normalizes multiple parameters at once", () => {
    const input = { file_path: "/src/app.ts", old_string: "foo", new_string: "bar" }
    const schema = {
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["filePath", "oldString", "newString"],
    }
    expect(normalizeToolInput(input, schema)).toEqual({
      filePath: "/src/app.ts",
      oldString: "foo",
      newString: "bar",
    })
  })

  it("preserves fields that already match the schema", () => {
    const input = { filePath: "/src/app.ts", limit: 100 }
    const schema = {
      properties: { filePath: { type: "string" }, limit: { type: "number" } },
      required: ["filePath"],
    }
    expect(normalizeToolInput(input, schema)).toEqual(input)
  })

  it("does not overwrite existing fields during normalization", () => {
    // Both file_path and filePath present — leave as-is
    const input = { file_path: "/wrong", filePath: "/correct" }
    const schema = {
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    }
    // filePath is already defined, so no normalization needed
    expect(normalizeToolInput(input, schema)).toEqual(input)
  })

  it("returns undefined input unchanged", () => {
    expect(normalizeToolInput(undefined, { properties: { x: {} } })).toBeUndefined()
  })

  it("returns input unchanged when schema has no properties", () => {
    const input = { file_path: "/src/app.ts" }
    expect(normalizeToolInput(input, {})).toEqual(input)
    expect(normalizeToolInput(input, undefined)).toEqual(input)
  })

  it("returns input unchanged when schema has no required fields", () => {
    const input = { file_path: "/src/app.ts" }
    const schema = {
      properties: { filePath: { type: "string" } },
      // no required array — all optional
    }
    // All required fields are trivially present (there are none)
    expect(normalizeToolInput(input, schema)).toEqual(input)
  })

  it("handles multi-segment snake_case names", () => {
    const input = { replace_all: true }
    const schema = {
      properties: { replaceAll: { type: "boolean" } },
      required: ["replaceAll"],
    }
    expect(normalizeToolInput(input, schema)).toEqual({ replaceAll: true })
  })

  it("leaves unknown keys that have no schema match", () => {
    const input = { file_path: "/src/app.ts", unknown_key: "value" }
    const schema = {
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    }
    expect(normalizeToolInput(input, schema)).toEqual({
      filePath: "/src/app.ts",
      unknown_key: "value",
    })
  })
})
