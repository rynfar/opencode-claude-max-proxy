/**
 * Regression tests for scripts/fix-bun-exports.mjs.
 *
 * The script patches two Bun bundler bugs in the produced `dist/`:
 *   - Duplicate `export {}` blocks (subsequent block's symbols ⊆ first)
 *   - `__INVALID__REF__` import/export artifacts
 *
 * These tests use synthetic fixtures matching the patterns Bun's --splitting
 * mode actually emits, so a future change to the script can't silently break
 * the cleanup. We assert both at the source-string level (via patchSource)
 * and at the runtime level (via dynamic import after fixBunExports writes).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { patchSource, fixBunExports, extractExportSymbols } from "../../scripts/fix-bun-exports.mjs"

describe("patchSource (pure)", () => {
  it("removes __INVALID__REF__ named imports", () => {
    const input = `import { __INVALID__REF__ } from "./server.js";\nimport { realThing } from "./bar.js";\n`
    const out = patchSource(input)
    expect(out).not.toContain("__INVALID__REF__")
    expect(out).toContain('import { realThing } from "./bar.js"')
  })

  it("strips __INVALID__REF__ from the canonical export block", () => {
    const input = `export {\n  doStuff,\n  realThing,\n  __INVALID__REF__\n};\n`
    const out = patchSource(input)
    expect(out).not.toContain("__INVALID__REF__")
    expect(out).toContain("doStuff")
    expect(out).toContain("realThing")
  })

  it("rebuilds the cleaned canonical block with proper formatting (no glued braces)", () => {
    const input = `export {\n  doStuff,\n  realThing,\n  __INVALID__REF__\n};\n`
    const out = patchSource(input)
    // Must not have `realThing}` glued together.
    expect(out).not.toMatch(/realThing\}/)
    expect(out).toMatch(/realThing\n\};/)
  })

  it("removes a subsequent export block whose symbols are a subset of the first", () => {
    const input =
      `export {\n  doStuff,\n  realThing\n};\n\nexport {\n  doStuff\n};\n`
    const out = patchSource(input)
    // Only one export block should remain.
    const matches = out.match(/^export \{/gm) || []
    expect(matches.length).toBe(1)
    expect(out).toContain("realThing")
  })

  it("rewrites a subsequent block to keep only novel symbols when there is partial overlap", () => {
    const input =
      `export {\n  doStuff\n};\n\nexport {\n  doStuff,\n  realThing\n};\n`
    const out = patchSource(input)
    const matches = out.match(/^export \{/gm) || []
    expect(matches.length).toBe(2)
    expect(out).toContain("export { realThing };")
    expect(out).not.toMatch(/export \{[^}]*doStuff[^}]*realThing/)
  })

  it("deduplicates a partial-overlap block matching bun's tokenRefresh pattern", () => {
    const input =
      `export {\n  stopBg,\n  startBg,\n  ensureFresh\n};\n\n` +
      `export { logCtx, claudeLog, ensureFresh, startBg, stopBg };\n`
    const out = patchSource(input)
    const matches = out.match(/^export \{/gm) || []
    expect(matches.length).toBe(2)
    expect(out).toContain("export { logCtx, claudeLog };")
    expect(out).not.toMatch(/export \{[^}]*stopBg[^}]*claudeLog/)
  })

  it("collapses 3+ consecutive blank lines to 2", () => {
    const out = patchSource("a\n\n\n\nb\n")
    expect(out).toBe("a\n\nb\n")
  })

  it("returns input unchanged when there is nothing to fix", () => {
    const input = `import { realThing } from "./bar.js";\nexport { realThing };\n`
    expect(patchSource(input)).toBe(input)
  })

  it("handles empty input gracefully", () => {
    expect(patchSource("")).toBe("")
  })
})

describe("extractExportSymbols", () => {
  it("extracts symbol names from a multi-line export block", () => {
    const block = `export {\n  a,\n  b,\n  c\n}`
    expect(extractExportSymbols(block)).toEqual(["a", "b", "c"])
  })

  it("extracts symbol names from a single-line export block", () => {
    expect(extractExportSymbols(`export { a, b, c };`)).toEqual(["a", "b", "c"])
  })

  it("filters out __INVALID__REF__", () => {
    expect(extractExportSymbols(`export { a, __INVALID__REF__, b };`)).toEqual(["a", "b"])
  })

  it("returns empty array for empty block", () => {
    expect(extractExportSymbols(`export {};`)).toEqual([])
  })
})

describe("fixBunExports (integration)", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `fix-bun-exports-test-${Date.now()}-${Math.random().toString(36).slice(2)}`) + "/"
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it("fixes a file that fails to import due to a duplicate export, making it loadable", async () => {
    // Faithful reproduction of Bun's broken --splitting output: a leading
    // canonical export block plus a redundant trailing block.
    writeFileSync(
      join(tmpDir, "bar.js"),
      `export const realThing = () => 42;\n`,
    )
    writeFileSync(
      join(tmpDir, "case-with-bug.js"),
      `import { __INVALID__REF__ } from "./bar.js";\n` +
      `import { realThing } from "./bar.js";\n` +
      `\n` +
      `function doStuff() { return realThing(); }\n` +
      `\n` +
      `export {\n  doStuff,\n  realThing,\n  __INVALID__REF__\n};\n` +
      `\n` +
      `export {\n  doStuff\n};\n`,
    )

    // Sanity: BEFORE the fix, the file fails to import.
    let before: string | null = null
    try {
      await import(join(tmpDir, "case-with-bug.js"))
    } catch (e) {
      before = e instanceof Error ? e.message : String(e)
    }
    // Both Node ("Duplicate export") and Bun ("Cannot export a duplicate
     // name") report the same underlying problem with different wording.
    expect(before?.toLowerCase()).toContain("duplicate")

    const totalFixed = await fixBunExports(tmpDir)
    expect(totalFixed).toBe(1)

    // AFTER the fix, dynamic-import the patched file (cache-busted with a
    // query string so a previous test run can't return the broken cache).
    const mod = await import(join(tmpDir, "case-with-bug.js") + `?t=${Date.now()}`)
    expect(typeof mod.doStuff).toBe("function")
    expect(typeof mod.realThing).toBe("function")
    expect(mod.doStuff()).toBe(42)
  })

  it("returns 0 and writes nothing when files have no issues", async () => {
    writeFileSync(
      join(tmpDir, "clean.js"),
      `export const x = 1;\nexport const y = 2;\n`,
    )
    const totalFixed = await fixBunExports(tmpDir)
    expect(totalFixed).toBe(0)
  })

  it("fixes multiple files in one pass", async () => {
    writeFileSync(
      join(tmpDir, "a.js"),
      `export {\n  foo\n};\n\nexport {\n  foo\n};\n`,
    )
    writeFileSync(
      join(tmpDir, "b.js"),
      `import { __INVALID__REF__ } from "./z.js";\nexport const ok = 1;\n`,
    )
    const totalFixed = await fixBunExports(tmpDir)
    expect(totalFixed).toBe(2)
  })
})
