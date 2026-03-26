import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { createProxyServer, startProxyServer } = await import("../proxy/server")
const { resetCachedClaudeAuthStatus } = await import("../proxy/models")
const { runCli } = await import("../../bin/cli")

describe("proxy async ops", () => {
  it("starts server with async executable resolution", async () => {
    const proxyA = await startProxyServer({ port: 0, host: "127.0.0.1" })
    const proxyB = await startProxyServer({ port: 0, host: "127.0.0.1" })

    await proxyA.close()
    await proxyB.close()

    expect(typeof proxyA.server.keepAliveTimeout).toBe("number")
    expect(typeof proxyB.server.keepAliveTimeout).toBe("number")
  })

  it("serves async health endpoint with unchanged response schema", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const response = await app.fetch(new Request("http://localhost/health"))
    const body = await response.json() as any

    expect(typeof body.status).toBe("string")
    expect(typeof body.mode).toBe("string")
    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status)

    if (body.status === "healthy") {
      expect(typeof body.auth.loggedIn).toBe("boolean")
      expect(body.auth.loggedIn).toBe(true)
      expect(Object.keys(body).sort()).toEqual(["auth", "mode", "status"])
    }

    if (body.status === "unhealthy") {
      expect(typeof body.error).toBe("string")
      expect(body.auth.loggedIn).toBe(false)
      expect(Object.keys(body).sort()).toEqual(["auth", "error", "status"])
    }

    if (body.status === "degraded") {
      expect(typeof body.error).toBe("string")
      expect(Object.keys(body).sort()).toEqual(["error", "mode", "status"])
    }

    expect(response.status).toBe(body.status === "unhealthy" ? 503 : 200)
  })

  it("returns degraded health when auth status command times out", async () => {
    resetCachedClaudeAuthStatus()
    const originalPath = process.env.PATH
    process.env.PATH = ""

    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      const response = await app.fetch(new Request("http://localhost/health"))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toEqual({
        status: "degraded",
        error: "Could not verify auth status",
        mode: "internal",
      })
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("keeps CLI missing-binary warning behavior", async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: any[]) => {
      errors.push(args.join(" "))
    }

    let startCalled = 0
    try {
      await runCli(
        async () => {
          startCalled += 1
          const { EventEmitter } = await import("events")
          return { server: new EventEmitter(), config: {}, close: async () => {} } as any
        },
        (() => {
          throw new Error("spawn ENOENT")
        }) as any
      )
    } finally {
      console.error = originalError
    }

    expect(startCalled).toBe(1)
    expect(errors.some((line) => line.includes("Could not verify Claude auth status"))).toBe(true)
  })

  it("loads config from a JSON file before starting the CLI proxy", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "meridian-cli-config-"))
    const originalConfigPath = process.env.CLAUDE_PROXY_CONFIG
    const configPath = join(tmpDir, "meridian.config.json")
    writeFileSync(configPath, JSON.stringify({
      port: 8123,
      host: "0.0.0.0",
      defaultProfile: "company",
      requiredApiKeys: ["alpha", "beta"],
    }))

    let capturedConfig: any
    try {
      process.env.CLAUDE_PROXY_CONFIG = configPath

      await runCli(
        async (config) => {
          capturedConfig = config
          const { EventEmitter } = await import("events")
          return { server: new EventEmitter(), config: {}, close: async () => {} } as any
        },
        ((async () => ({ stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) })) as any),
      )
    } finally {
      if (originalConfigPath === undefined) delete process.env.CLAUDE_PROXY_CONFIG
      else process.env.CLAUDE_PROXY_CONFIG = originalConfigPath
      rmSync(tmpDir, { recursive: true, force: true })
    }

    expect(capturedConfig.port).toBe(8123)
    expect(capturedConfig.host).toBe("0.0.0.0")
    expect(capturedConfig.defaultProfile).toBe("company")
    expect(capturedConfig.requiredApiKeys).toEqual(["alpha", "beta"])
  })
})
