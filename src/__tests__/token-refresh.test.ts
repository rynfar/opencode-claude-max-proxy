/**
 * Unit tests for tokenRefresh — OAuth refresh flow.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const CREDS = path.join(os.homedir(), ".claude", ".credentials.json")

const MOCK_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "old-access-token",
    refreshToken: "the-refresh-token",
    expiresAt: Date.now() - 1000,
    scopes: ["openid", "profile"],
    subscriptionType: "max",
    rateLimitTier: "standard",
  },
}

describe("tokenRefresh", () => {
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let writeFileSyncSpy: ReturnType<typeof spyOn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    readFileSyncSpy = spyOn(fs, "readFileSync")
    writeFileSyncSpy = spyOn(fs, "writeFileSync")
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    readFileSyncSpy.mockRestore()
    writeFileSyncSpy.mockRestore()
    globalThis.fetch = originalFetch
  })

  describe("refreshOAuthToken", () => {
    it("returns false when credentials file cannot be read", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => {
        throw new Error("ENOENT")
      })
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("returns false when credentials have no refreshToken", async () => {
      const noRefresh = {
        claudeAiOauth: { ...MOCK_CREDENTIALS.claudeAiOauth, refreshToken: "" },
      }
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(noRefresh))
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("returns false when fetch throws", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () => { throw new Error("network error") })
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("returns false on non-ok HTTP response", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response("Unauthorized", { status: 401 })
      )
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("returns false when response JSON is invalid", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response("not json", { status: 200 })
      )
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("returns false when credentials cannot be written", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            access_token: "new-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      writeFileSyncSpy.mockImplementation((_p: unknown) => {
        throw new Error("EACCES")
      })
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("returns true and writes credentials on success", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      const writtenData: string[] = []
      writeFileSyncSpy.mockImplementation((_p: unknown, data: unknown) => {
        writtenData.push(data as string)
      })

      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()

      expect(result).toBe(true)
      expect(writtenData.length).toBe(1)
      const written = JSON.parse(writtenData[0])
      expect(written.claudeAiOauth.accessToken).toBe("new-access-token")
      expect(written.claudeAiOauth.refreshToken).toBe("new-refresh-token")
    })

    it("preserves old refreshToken if new one is not in response", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response(
          JSON.stringify({
            access_token: "new-access-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      writeFileSyncSpy.mockImplementation((_p: unknown) => {})

      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()

      expect(result).toBe(true)
    })
  })
})
