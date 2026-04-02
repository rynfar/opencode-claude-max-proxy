/**
 * Unit tests for tokenRefresh — stamp file logic and OAuth refresh flow.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// We test the module's exported functions by mocking fs and fetch at the module level.
// Import after setting up spies so we can control behavior per test.

const STAMP = path.join(os.tmpdir(), "meridian-token-refresh")
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
  let statSyncSpy: ReturnType<typeof spyOn>
  let readFileSyncSpy: ReturnType<typeof spyOn>
  let writeFileSyncSpy: ReturnType<typeof spyOn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    statSyncSpy = spyOn(fs, "statSync")
    readFileSyncSpy = spyOn(fs, "readFileSync")
    writeFileSyncSpy = spyOn(fs, "writeFileSync")
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    statSyncSpy.mockRestore()
    readFileSyncSpy.mockRestore()
    writeFileSyncSpy.mockRestore()
    globalThis.fetch = originalFetch
  })

  describe("stampFileAgeMs", () => {
    it("returns Infinity when stamp file does not exist", async () => {
      statSyncSpy.mockImplementation((p: string) => {
        if (p === STAMP) throw new Error("ENOENT")
        return { mtimeMs: Date.now() } as fs.Stats
      })
      const { stampFileAgeMs } = await import("../proxy/tokenRefresh")
      expect(stampFileAgeMs()).toBe(Infinity)
    })

    it("returns age in ms when stamp file exists", async () => {
      const fiveHoursAgo = Date.now() - 5 * 60 * 60 * 1000
      statSyncSpy.mockImplementation((_p: string) => ({ mtimeMs: fiveHoursAgo } as fs.Stats))
      const { stampFileAgeMs } = await import("../proxy/tokenRefresh")
      const age = stampFileAgeMs()
      expect(age).toBeGreaterThan(4.9 * 60 * 60 * 1000)
      expect(age).toBeLessThan(5.1 * 60 * 60 * 1000)
    })
  })

  describe("refreshOAuthToken", () => {
    it("returns false when credentials file cannot be read", async () => {
      readFileSyncSpy.mockImplementation((p: unknown) => {
        if (p === CREDS) throw new Error("ENOENT")
        return ""
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

    it("returns false when credentials cannot be written", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      writeFileSyncSpy.mockImplementation((p: unknown) => {
        if (p === CREDS) throw new Error("EACCES")
      })
      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()
      expect(result).toBe(false)
    })

    it("writes updated credentials and stamp file on success", async () => {
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
      const writtenFiles: string[] = []
      writeFileSyncSpy.mockImplementation((p: unknown) => {
        writtenFiles.push(p as string)
      })

      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()

      expect(result).toBe(true)
      expect(writtenFiles).toContain(CREDS)
      expect(writtenFiles).toContain(STAMP)
    })

    it("does NOT write stamp file when refresh fails", async () => {
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      globalThis.fetch = mock(async () =>
        new Response("Bad Gateway", { status: 502 })
      )
      const writtenFiles: string[] = []
      writeFileSyncSpy.mockImplementation((p: unknown) => {
        writtenFiles.push(p as string)
      })

      const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
      const result = await refreshOAuthToken()

      expect(result).toBe(false)
      expect(writtenFiles).not.toContain(STAMP)
    })
  })

  describe("refreshTokenIfNeeded", () => {
    it("does not refresh when stamp is recent (< 6h)", async () => {
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000
      statSyncSpy.mockImplementation((_p: unknown) => ({ mtimeMs: twoHoursAgo } as fs.Stats))
      const fetchMock = mock(async () => new Response("{}", { status: 200 }))
      globalThis.fetch = fetchMock

      const { refreshTokenIfNeeded } = await import("../proxy/tokenRefresh")
      await refreshTokenIfNeeded()

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("refreshes when stamp is old (> 6h)", async () => {
      const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000
      statSyncSpy.mockImplementation((_p: unknown) => ({ mtimeMs: sevenHoursAgo } as fs.Stats))
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      const fetchMock = mock(async () =>
        new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      globalThis.fetch = fetchMock
      writeFileSyncSpy.mockImplementation((_p: unknown) => {})

      const { refreshTokenIfNeeded } = await import("../proxy/tokenRefresh")
      await refreshTokenIfNeeded()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("refreshes when stamp file is missing (Infinity age)", async () => {
      statSyncSpy.mockImplementation((_p: string) => { throw new Error("ENOENT") })
      readFileSyncSpy.mockImplementation((_p: unknown) => JSON.stringify(MOCK_CREDENTIALS))
      const fetchMock = mock(async () =>
        new Response(
          JSON.stringify({ access_token: "t", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      globalThis.fetch = fetchMock
      writeFileSyncSpy.mockImplementation((_p: unknown) => {})

      const { refreshTokenIfNeeded } = await import("../proxy/tokenRefresh")
      await refreshTokenIfNeeded()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
