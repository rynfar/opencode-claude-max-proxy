/**
 * Integration tests for multi-profile feature.
 *
 * Tests the profile switch API, session isolation across profiles,
 * and settings persistence contract.
 */
import { describe, test, expect, beforeEach } from "bun:test"
import { mock } from "bun:test"

// Mock the SDK before importing server
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (opts: Record<string, unknown>) => {
    return (async function* () {
      yield {
        type: "assistant",
        message: { type: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
        session_id: `session-${Date.now()}`,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

// Mock models to avoid real auth checks
mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults: () => ({}),
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { storeSession, lookupSession, clearSessionCache } = await import("../proxy/session/cache")

beforeEach(() => {
  resetActiveProfile()
  clearSessionCache()
})

function createTestApp(profiles?: Array<{ id: string; claudeConfigDir?: string }>) {
  const { app } = createProxyServer({
    port: 0,
    host: "127.0.0.1",
    profiles: profiles as any,
  })
  return app
}

function req(url: string, init?: RequestInit): Request {
  return new Request(`http://localhost${url}`, init)
}

describe("Profile switch API", () => {
  const profiles = [
    { id: "personal", claudeConfigDir: "/home/.claude" },
    { id: "work", claudeConfigDir: "/home/.claude-work" },
  ]

  test("POST /profiles/active switches profile", async () => {
    const app = createTestApp(profiles)

    const res = await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; activeProfile: string }
    expect(body.success).toBe(true)
    expect(body.activeProfile).toBe("work")
  })

  test("POST /profiles/active rejects unknown profile", async () => {
    const app = createTestApp(profiles)

    const res = await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "nonexistent" }),
    }))
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain("nonexistent")
  })

  test("GET /profiles/list returns all profiles with active status", async () => {
    const app = createTestApp(profiles)

    const res = await app.fetch(req("/profiles/list"))
    expect(res.status).toBe(200)
    const body = await res.json() as { profiles: Array<{ id: string; isActive: boolean }>; activeProfile: string }
    expect(body.profiles).toHaveLength(2)
    expect(body.activeProfile).toBe("personal") // first profile is default
    expect(body.profiles[0]!.isActive).toBe(true)
    expect(body.profiles[1]!.isActive).toBe(false)
  })

  test("GET /profiles/list reflects switched profile", async () => {
    const app = createTestApp(profiles)

    // Switch to work
    await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))

    const res = await app.fetch(req("/profiles/list"))
    const body = await res.json() as { profiles: Array<{ id: string; isActive: boolean }>; activeProfile: string }
    expect(body.activeProfile).toBe("work")
    expect(body.profiles.find(p => p.id === "work")!.isActive).toBe(true)
    expect(body.profiles.find(p => p.id === "personal")!.isActive).toBe(false)
  })

  test("no profiles configured returns empty list", async () => {
    const app = createTestApp([])

    const res = await app.fetch(req("/profiles/list"))
    const body = await res.json() as { profiles: Array<unknown> }
    expect(body.profiles).toHaveLength(0)
  })

  test("POST /profiles/active with no profiles returns 400", async () => {
    const app = createTestApp([])

    const res = await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "anything" }),
    }))
    expect(res.status).toBe(400)
  })
})

describe("Session cache eviction on profile switch", () => {
  const profiles = [
    { id: "personal", claudeConfigDir: "/home/.claude" },
    { id: "work", claudeConfigDir: "/home/.claude-work" },
  ]

  test("switching profile clears session cache", async () => {
    const app = createTestApp(profiles)

    // Store a session in the cache
    const msgs = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]
    storeSession("test-session-123", msgs, "claude-abc")

    // Verify session exists
    const before = lookupSession("test-session-123", msgs)
    expect(before.type).not.toBe("new")

    // Switch profile via API
    const res = await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))
    expect(res.status).toBe(200)

    // Session should be gone — new lookup returns diverged (sessionId known but no cache entry)
    const after = lookupSession("test-session-123", msgs)
    expect(after.type).toBe("diverged")
  })

  test("switching to same profile still clears cache", async () => {
    const app = createTestApp(profiles)

    const msgs = [{ role: "user", content: "x" }]
    storeSession("session-same", msgs, "claude-same")

    // Switch to first profile (already active)
    await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "personal" }),
    }))

    const after = lookupSession("session-same", msgs)
    expect(after.type).toBe("diverged")
  })
})

describe("Profile-scoped request routing", () => {
  const profiles = [
    { id: "personal", claudeConfigDir: "/home/.claude" },
    { id: "work", claudeConfigDir: "/home/.claude-work" },
  ]

  test("x-meridian-profile header overrides active profile", async () => {
    const app = createTestApp(profiles)

    // Switch to personal
    await app.fetch(req("/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "personal" }),
    }))

    // Send request with work header override — should not error
    const res = await app.fetch(req("/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "dummy",
        "x-meridian-profile": "work",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "test" }],
        max_tokens: 10,
        stream: false,
      }),
    }))
    expect(res.status).toBe(200)
  })
})
