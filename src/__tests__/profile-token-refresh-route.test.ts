import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProxyServer } from "../proxy/server"
import { resetInflightRefresh, stopBackgroundRefresh } from "../proxy/tokenRefresh"

const TOKEN_RESPONSE = {
  access_token: "new-profile-access-token",
  refresh_token: "new-profile-refresh-token",
  expires_in: 3600,
}

function credentials(accessToken: string, refreshToken: string) {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt: Date.now() - 1000,
      subscriptionType: "max",
    },
  }
}

describe("profile-scoped token refresh route", () => {
  let originalFetch: typeof globalThis.fetch
  let tempDir: string

  beforeEach(() => {
    originalFetch = globalThis.fetch
    tempDir = mkdtempSync(join(tmpdir(), "meridian-profile-refresh-"))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetInflightRefresh()
    stopBackgroundRefresh()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("refreshes the requested profile credentials instead of the default store", async () => {
    const personalDir = join(tempDir, "personal")
    const workDir = join(tempDir, "work")
    mkdirSync(personalDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(personalDir, ".credentials.json"), JSON.stringify(credentials("personal-old", "personal-refresh")))
    writeFileSync(join(workDir, ".credentials.json"), JSON.stringify(credentials("work-old", "work-refresh")))

    const mockFetch: typeof fetch = Object.assign(
      async () => new Response(JSON.stringify(TOKEN_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      { preconnect: originalFetch.preconnect }
    )
    globalThis.fetch = mockFetch

    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [
        { id: "personal", claudeConfigDir: personalDir },
        { id: "work", claudeConfigDir: workDir },
      ],
      defaultProfile: "personal",
      silent: true,
    })

    const res = await app.fetch(new Request("http://localhost/auth/refresh", {
      method: "POST",
      headers: { "x-meridian-profile": "work" },
    }))
    const body = await res.json() as { success?: boolean; profile?: string }

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, profile: "work" })
    expect(JSON.parse(readFileSync(join(workDir, ".credentials.json"), "utf-8")).claudeAiOauth.accessToken).toBe("new-profile-access-token")
    expect(JSON.parse(readFileSync(join(personalDir, ".credentials.json"), "utf-8")).claudeAiOauth.accessToken).toBe("personal-old")
  })
})
