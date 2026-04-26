/**
 * Test for degraded health when auth status returns null.
 *
 * Separated from proxy-async-ops.test.ts because it needs to mock
 * ../proxy/models before server.ts imports it — preventing races
 * with parallel test files that share the module singleton.
 */

import { describe, it, expect, mock } from "bun:test"

mock.module("../proxy/models", () => ({
  getClaudeAuthStatusAsync: async () => null,
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults: () => ({}),
  mapModelToClaudeModel: (model: string) => {
    if (model.toLowerCase().includes("opus")) return "opus"
    if (model.toLowerCase().includes("haiku")) return "haiku"
    return "sonnet"
  },
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
  resetCachedClaudeAuthStatus: () => {},
  resetCachedClaudePath: () => {},
  expireAuthStatusCache: () => {},
  resetExtendedContextUnavailable: () => {},
}))

const { createProxyServer } = await import("../proxy/server")

describe("proxy health degraded", () => {
  it("returns degraded health when auth status is null", async () => {
    const originalClaudeProxyPassthrough = process.env.CLAUDE_PROXY_PASSTHROUGH
    const originalMeridianPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.CLAUDE_PROXY_PASSTHROUGH = "0"
    process.env.MERIDIAN_PASSTHROUGH = "0"

    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const response = await app.fetch(new Request("http://localhost/health"))
      const body = await response.json() as Record<string, unknown>

      expect(response.status).toBe(200)
      expect(body.status).toBe("degraded")
      expect(body.error).toBe("Could not verify auth status")
      expect(body.mode).toBe("internal")
      expect(typeof body.version).toBe("string")
    } finally {
      if (originalClaudeProxyPassthrough === undefined) delete process.env.CLAUDE_PROXY_PASSTHROUGH
      else process.env.CLAUDE_PROXY_PASSTHROUGH = originalClaudeProxyPassthrough
      if (originalMeridianPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
      else process.env.MERIDIAN_PASSTHROUGH = originalMeridianPassthrough
    }
  })
})
