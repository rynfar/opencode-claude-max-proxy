/**
 * Unit tests for profiles.ts — pure function tests (no mocks needed).
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  resolveProfile,
  listProfiles,
  getEffectiveProfiles,
  setActiveProfile,
  getActiveProfileId,
  resetActiveProfile,
  restoreActiveProfile,
  type ProfileConfig,
} from "../proxy/profiles"

// Reset active profile between tests to avoid state leakage
beforeEach(() => {
  resetActiveProfile()
})

describe("resolveProfile", () => {
  const profiles: ProfileConfig[] = [
    { id: "personal", type: "claude-max", claudeConfigDir: "/home/.config/meridian/profiles/personal" },
    { id: "work", type: "claude-max", claudeConfigDir: "/home/.config/meridian/profiles/work" },
    { id: "api-test", type: "api", apiKey: "sk-test-123", baseUrl: "https://api.example.com" },
  ]

  test("returns default profile with empty env when no profiles configured", () => {
    const result = resolveProfile(undefined, undefined)
    expect(result.id).toBe("default")
    expect(result.type).toBe("claude-max")
    expect(result.env).toEqual({})
  })

  test("returns default profile with empty env for empty array", () => {
    const result = resolveProfile([], undefined)
    expect(result.id).toBe("default")
    expect(result.env).toEqual({})
  })

  test("resolves first profile when no preference given", () => {
    const result = resolveProfile(profiles, undefined)
    expect(result.id).toBe("personal")
    expect(result.type).toBe("claude-max")
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/.config/meridian/profiles/personal" })
  })

  test("resolves requested profile by header", () => {
    const result = resolveProfile(profiles, undefined, "work")
    expect(result.id).toBe("work")
    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/.config/meridian/profiles/work" })
  })

  test("resolves api profile with API key and base URL", () => {
    const result = resolveProfile(profiles, undefined, "api-test")
    expect(result.id).toBe("api-test")
    expect(result.type).toBe("api")
    expect(result.env).toEqual({
      ANTHROPIC_API_KEY: "sk-test-123",
      ANTHROPIC_BASE_URL: "https://api.example.com",
    })
  })

  test("respects default profile config", () => {
    const result = resolveProfile(profiles, "work")
    expect(result.id).toBe("work")
  })

  test("header overrides default and active", () => {
    setActiveProfile("work")
    const result = resolveProfile(profiles, "personal", "api-test")
    expect(result.id).toBe("api-test")
  })

  test("active overrides default", () => {
    setActiveProfile("api-test")
    const result = resolveProfile(profiles, "personal")
    expect(result.id).toBe("api-test")
  })

  test("falls back to first profile for unknown ID with warning", () => {
    const result = resolveProfile(profiles, undefined, "nonexistent")
    expect(result.id).toBe("personal")
  })

  test("claude-max profile without claudeConfigDir returns empty env", () => {
    const result = resolveProfile([{ id: "bare", type: "claude-max" }], undefined)
    expect(result.id).toBe("bare")
    expect(result.env).toEqual({})
  })

  test("api profile without apiKey returns empty env", () => {
    const result = resolveProfile([{ id: "bare-api", type: "api" }], undefined)
    expect(result.id).toBe("bare-api")
    expect(result.type).toBe("api")
    expect(result.env).toEqual({})
  })

  test("resolves oauth-token profile via explicit type", () => {
    const result = resolveProfile(
      [{ id: "ci", type: "oauth-token", oauthToken: "sk-ant-oat01-foo" }],
      undefined,
    )
    expect(result.id).toBe("ci")
    expect(result.type).toBe("oauth-token")
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-foo")
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(
      join(homedir(), ".config", "meridian", "profiles", "ci"),
    )
  })

  test("infers oauth-token type from oauthToken field alone", () => {
    const result = resolveProfile([{ id: "ci", oauthToken: "sk-ant-oat01-bar" }], undefined)
    expect(result.id).toBe("ci")
    expect(result.type).toBe("oauth-token")
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-bar")
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(
      join(homedir(), ".config", "meridian", "profiles", "ci"),
    )
  })

  test("oauthToken overrides claudeConfigDir with isolated profile dir", () => {
    const result = resolveProfile(
      [{ id: "ci", oauthToken: "sk-ant-oat01-baz", claudeConfigDir: "/ignored" }],
      undefined,
    )
    expect(result.type).toBe("oauth-token")
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-baz")
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(
      join(homedir(), ".config", "meridian", "profiles", "ci"),
    )
    expect(result.env.CLAUDE_CONFIG_DIR).not.toBe("/ignored")
  })

  test("oauth-token type without oauthToken returns empty env", () => {
    const result = resolveProfile([{ id: "bare-oauth", type: "oauth-token" }], undefined)
    expect(result.id).toBe("bare-oauth")
    expect(result.type).toBe("oauth-token")
    expect(result.env).toEqual({})
  })

  test("oauth-token isolation dir uses profile id, not 'default'", () => {
    const result = resolveProfile(
      [{ id: "my-special-ci", oauthToken: "sk-ant-oat01-aaa" }],
      undefined,
    )
    expect(result.env.CLAUDE_CONFIG_DIR).toContain("/my-special-ci")
  })

  test("header selects oauth-token profile when active points elsewhere", () => {
    const mixed: ProfileConfig[] = [
      { id: "personal", claudeConfigDir: "/c1" },
      { id: "ci", oauthToken: "sk-ant-oat01-qux" },
    ]
    setActiveProfile("personal")
    const result = resolveProfile(mixed, undefined, "ci")
    expect(result.id).toBe("ci")
    expect(result.type).toBe("oauth-token")
    expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-qux")
    expect(result.env.CLAUDE_CONFIG_DIR).toBe(
      join(homedir(), ".config", "meridian", "profiles", "ci"),
    )
  })
})

describe("listProfiles", () => {
  const profiles: ProfileConfig[] = [
    { id: "personal", type: "claude-max" },
    { id: "work", type: "api" },
  ]

  test("returns empty array when no profiles", () => {
    expect(listProfiles(undefined, undefined)).toEqual([])
    expect(listProfiles([], undefined)).toEqual([])
  })

  test("lists all profiles with types and active status", () => {
    const result = listProfiles(profiles, undefined)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ id: "personal", type: "claude-max", isActive: true })
    expect(result[1]).toEqual({ id: "work", type: "api", isActive: false })
  })

  test("marks default profile as active", () => {
    const result = listProfiles(profiles, "work")
    const active = result.find(p => p.isActive)
    expect(active?.id).toBe("work")
  })

  test("marks active profile as active (overrides default)", () => {
    setActiveProfile("work")
    const result = listProfiles(profiles, "personal")
    const active = result.find(p => p.isActive)
    expect(active?.id).toBe("work")
  })

  test("defaults type to claude-max when unset", () => {
    const result = listProfiles([{ id: "bare" }], undefined)
    expect(result[0]!.type).toBe("claude-max")
  })

  test("preserves oauth-token type when explicitly set", () => {
    const result = listProfiles(
      [{ id: "ci", type: "oauth-token", oauthToken: "sk-ant-oat01-foo" }],
      undefined,
    )
    expect(result[0]).toEqual({ id: "ci", type: "oauth-token", isActive: true })
  })
})

describe("getEffectiveProfiles", () => {
  test("returns empty array when no config and disk discovery disabled", () => {
    // diskDiscoveryEnabled is false by default in test environment
    expect(getEffectiveProfiles(undefined)).toEqual([])
  })

  test("returns config profiles as-is when disk discovery disabled", () => {
    const profiles: ProfileConfig[] = [{ id: "test" }]
    expect(getEffectiveProfiles(profiles)).toEqual(profiles)
  })

  test("returns empty array for empty config when disk discovery disabled", () => {
    expect(getEffectiveProfiles([])).toEqual([])
  })
})

describe("active profile state", () => {
  test("getActiveProfileId returns undefined initially", () => {
    expect(getActiveProfileId()).toBeUndefined()
  })

  test("setActiveProfile / getActiveProfileId roundtrip", () => {
    setActiveProfile("my-profile")
    expect(getActiveProfileId()).toBe("my-profile")
    setActiveProfile("other-profile")
    expect(getActiveProfileId()).toBe("other-profile")
  })

  test("restoreActiveProfile does not override existing active", () => {
    setActiveProfile("already-set")
    restoreActiveProfile()
    expect(getActiveProfileId()).toBe("already-set")
  })
})

describe("profile-scoped session isolation", () => {
  const profiles: ProfileConfig[] = [
    { id: "personal", claudeConfigDir: "/home/.claude" },
    { id: "work", claudeConfigDir: "/home/.claude-work" },
  ]

  test("different profiles resolve different env for same config", () => {
    const personal = resolveProfile(profiles, undefined, "personal")
    const work = resolveProfile(profiles, undefined, "work")
    expect(personal.env.CLAUDE_CONFIG_DIR).toBe("/home/.claude")
    expect(work.env.CLAUDE_CONFIG_DIR).toBe("/home/.claude-work")
    expect(personal.env.CLAUDE_CONFIG_DIR).not.toBe(work.env.CLAUDE_CONFIG_DIR)
  })

  test("switching active profile changes resolution", () => {
    setActiveProfile("personal")
    const r1 = resolveProfile(profiles, undefined)
    expect(r1.id).toBe("personal")

    setActiveProfile("work")
    const r2 = resolveProfile(profiles, undefined)
    expect(r2.id).toBe("work")
  })

  test("request header overrides active profile", () => {
    setActiveProfile("work")
    const result = resolveProfile(profiles, undefined, "personal")
    expect(result.id).toBe("personal")
    expect(result.env.CLAUDE_CONFIG_DIR).toBe("/home/.claude")
  })
})
