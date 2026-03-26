import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadProxyConfigFile } from "../proxy/configLoader"

describe("configLoader", () => {
  const envKeys = ["CLAUDE_PROXY_CONFIG", "MERIDIAN_SHARED_KEY", "MERIDIAN_API_KEY"] as const
  const originalEnv = new Map<string, string | undefined>(envKeys.map((key) => [key, process.env[key]]))

  afterEach(() => {
    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("loads the default config file from the current working directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "meridian-config-cwd-"))

    try {
      writeFileSync(join(cwd, "meridian.config.json"), JSON.stringify({
        defaultProfile: "company",
        requiredApiKeys: ["alpha", "beta"],
      }))

      const config = loadProxyConfigFile({ cwd, homeDir: cwd })
      expect(config.defaultProfile).toBe("company")
      expect(config.requiredApiKeys).toEqual(["alpha", "beta"])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it("merges home config first and lets cwd config override it", () => {
    const cwd = mkdtempSync(join(tmpdir(), "meridian-config-merge-cwd-"))
    const homeDir = mkdtempSync(join(tmpdir(), "meridian-config-merge-home-"))

    try {
      mkdirSync(join(homeDir, ".config", "meridian"), { recursive: true })
      writeFileSync(join(homeDir, ".config", "meridian", "config.json"), JSON.stringify({
        defaultProfile: "personal",
        requiredApiKeys: ["alpha"],
      }))
      writeFileSync(join(cwd, "meridian.config.json"), JSON.stringify({
        defaultProfile: "company",
      }))

      const config = loadProxyConfigFile({ cwd, homeDir })
      expect(config.defaultProfile).toBe("company")
      expect(config.requiredApiKeys).toEqual(["alpha"])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("resolves env references and home paths in config values", () => {
    const cwd = mkdtempSync(join(tmpdir(), "meridian-config-env-cwd-"))
    const homeDir = mkdtempSync(join(tmpdir(), "meridian-config-env-home-"))

    try {
      process.env.MERIDIAN_SHARED_KEY = "shared-secret"
      process.env.MERIDIAN_API_KEY = "profile-secret"

      writeFileSync(join(cwd, "meridian.config.json"), JSON.stringify({
        requiredApiKeys: ["env:MERIDIAN_SHARED_KEY"],
        profiles: [{
          id: "company",
          type: "api",
          apiKey: "$env:MERIDIAN_API_KEY",
          claudeConfigDir: "~/.claude-company",
        }],
      }))

      const config = loadProxyConfigFile({ cwd, homeDir })
      expect(config.requiredApiKeys).toEqual(["shared-secret"])
      expect(config.profiles?.[0]?.apiKey).toBe("profile-secret")
      expect(config.profiles?.[0]?.claudeConfigDir).toBe(join(homeDir, ".claude-company"))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("throws when an explicit config path is missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "meridian-config-missing-cwd-"))

    try {
      expect(() => loadProxyConfigFile({ cwd, homeDir: cwd, configPath: "missing.json" })).toThrow("Config file not found")
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
