import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { loadPlugins, parsePluginConfig } from "../proxy/plugins/loader"

describe("parsePluginConfig", () => {
  it("returns empty array for missing file", () => {
    const result = parsePluginConfig("/nonexistent/plugins.json")
    expect(result).toEqual([])
  })

  it("returns empty array for invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const configPath = join(dir, "plugins.json")
    writeFileSync(configPath, "not json")
    const result = parsePluginConfig(configPath)
    expect(result).toEqual([])
    rmSync(dir, { recursive: true })
  })

  it("parses valid plugins.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-test-"))
    const configPath = join(dir, "plugins.json")
    writeFileSync(configPath, JSON.stringify({
      plugins: [
        { path: "a.ts", enabled: true },
        { path: "b.ts", enabled: false },
      ]
    }))
    const result = parsePluginConfig(configPath)
    expect(result).toEqual([
      { path: "a.ts", enabled: true },
      { path: "b.ts", enabled: false },
    ])
    rmSync(dir, { recursive: true })
  })
})

describe("loadPlugins", () => {
  let pluginDir: string

  beforeEach(() => {
    pluginDir = mkdtempSync(join(tmpdir(), "meridian-plugins-"))
  })

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true })
  })

  it("returns empty array when plugin directory does not exist", async () => {
    const result = await loadPlugins("/nonexistent/plugins")
    expect(result).toEqual([])
  })

  it("loads a valid plugin from directory", async () => {
    writeFileSync(join(pluginDir, "test-plugin.ts"), `
      export default {
        name: "test-plugin",
        version: "1.0.0",
        onRequest: (ctx) => ctx,
      }
    `)
    const result = await loadPlugins(pluginDir)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("test-plugin")
    expect(result[0].status).toBe("active")
    expect(result[0].hooks).toContain("onRequest")
  })

  it("skips non-ts/js files", async () => {
    writeFileSync(join(pluginDir, "readme.md"), "# Not a plugin")
    writeFileSync(join(pluginDir, "valid.ts"), `
      export default { name: "valid", onRequest: (ctx) => ctx }
    `)
    const result = await loadPlugins(pluginDir)
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("valid")
  })

  it("marks invalid plugins as error", async () => {
    writeFileSync(join(pluginDir, "bad.ts"), `
      export default { notAName: true }
    `)
    const result = await loadPlugins(pluginDir)
    expect(result.length).toBe(1)
    expect(result[0].status).toBe("error")
    expect(result[0].error).toContain("name")
  })

  it("skips duplicate plugin names", async () => {
    writeFileSync(join(pluginDir, "a.ts"), `
      export default { name: "dupe", onRequest: (ctx) => ctx }
    `)
    writeFileSync(join(pluginDir, "b.ts"), `
      export default { name: "dupe", onRequest: (ctx) => ({ ...ctx, model: "changed" }) }
    `)
    const result = await loadPlugins(pluginDir)
    const active = result.filter(p => p.status === "active")
    const skipped = result.filter(p => p.status === "error")
    expect(active.length).toBe(1)
    expect(skipped.length).toBe(1)
    expect(skipped[0].error).toContain("duplicate")
  })

  it("respects plugins.json enabled flag", async () => {
    writeFileSync(join(pluginDir, "disabled.ts"), `
      export default { name: "disabled-plugin", onRequest: (ctx) => ctx }
    `)
    const configPath = join(pluginDir, "plugins.json")
    writeFileSync(configPath, JSON.stringify({
      plugins: [{ path: "disabled.ts", enabled: false }]
    }))
    const result = await loadPlugins(pluginDir, configPath)
    expect(result.length).toBe(1)
    expect(result[0].status).toBe("disabled")
  })

  it("respects plugins.json ordering", async () => {
    writeFileSync(join(pluginDir, "a.ts"), `
      export default { name: "alpha", onRequest: (ctx) => ctx }
    `)
    writeFileSync(join(pluginDir, "b.ts"), `
      export default { name: "beta", onRequest: (ctx) => ctx }
    `)
    const configPath = join(pluginDir, "plugins.json")
    writeFileSync(configPath, JSON.stringify({
      plugins: [
        { path: "b.ts", enabled: true },
        { path: "a.ts", enabled: true },
      ]
    }))
    const result = await loadPlugins(pluginDir, configPath)
    const active = result.filter(p => p.status === "active")
    expect(active[0].name).toBe("beta")
    expect(active[1].name).toBe("alpha")
  })
})
