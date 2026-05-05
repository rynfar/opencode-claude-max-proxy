/**
 * Regression test for issue #477.
 *
 * Before the fix, every route under `/settings/*` (including
 * `PATCH /settings/api/features/:adapter` which mutates per-adapter SDK
 * feature config — sharedMemory, additionalDirectories, maxBudgetUsd, etc.)
 * was registered without going through `requireAuth`. With
 * `MERIDIAN_API_KEY` set, every other prefix returned 401 to unauthenticated
 * callers; `/settings/*` quietly served full read/write access. SilverResort
 * reported it; this test pins the gate in place.
 *
 * The `audit` block walks every prefix the server registers and asserts an
 * unauthenticated caller is rejected (or the prefix is on a small explicit
 * public allowlist — `/`, `/health`). That makes the next "we forgot to
 * protect /<new-feature>" mistake fail CI instead of waking up as a security
 * report.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"

const SAVED_KEY = process.env.MERIDIAN_API_KEY
const TEST_KEY = "test-meridian-api-key"

beforeAll(() => {
  process.env.MERIDIAN_API_KEY = TEST_KEY
})

afterAll(() => {
  if (SAVED_KEY !== undefined) process.env.MERIDIAN_API_KEY = SAVED_KEY
  else delete process.env.MERIDIAN_API_KEY
})

// Imported after env is set so auth middleware reads our test key on its
// first invocation. requireAuth re-reads env per-call, but using `await
// import()` here keeps the timing explicit and matches the rest of the
// test suite's pattern for env-sensitive imports.
const { createProxyServer } = await import("../proxy/server")

describe("MERIDIAN_API_KEY — /settings/api/* (regression for #477)", () => {
  it("rejects GET /settings/api/features without auth", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features"))
    expect(res.status).toBe(401)
  })

  it("rejects PATCH /settings/api/features/:adapter without auth", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sharedMemory: true }),
    }))
    expect(res.status).toBe(401)
  })

  it("rejects DELETE /settings/api/features/:adapter without auth", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "DELETE",
    }))
    expect(res.status).toBe(401)
  })

  it("rejects GET /settings (HTML dashboard) without auth — same protection as /profiles, /plugins", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings"))
    expect(res.status).toBe(401)
  })

  it("accepts GET /settings/api/features with a matching x-api-key", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features", {
      headers: { "x-api-key": TEST_KEY },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // Body shape is FeatureConfig — a record of adapter → partial features.
    // We only assert it parses; exact contents depend on host config.
    expect(typeof body).toBe("object")
  })

  it("accepts GET /settings/api/features with a matching Bearer token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features", {
      headers: { "authorization": `Bearer ${TEST_KEY}` },
    }))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Audit: any sensitive route added in the future must go through requireAuth.
// ---------------------------------------------------------------------------
describe("auth audit: every registered prefix is protected when MERIDIAN_API_KEY is set", () => {
  // Routes that are *intentionally* public. Both serve read-only,
  // non-sensitive content (landing page; auth status). If you're adding to
  // this list, that's a security review. When in doubt, gate it.
  const PUBLIC_PREFIXES = new Set(["/", "/health"])

  it("rejects unauthenticated requests to every non-public route prefix", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // Hono exposes the registered routes via `app.routes`. Each entry has
    // { method, path, handler }. Middleware mounts (app.use) appear too but
    // with method "ALL"; we want the actual route handlers (GET/POST/etc.)
    // for paths to probe.
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
    const prefixes = new Set<string>()
    for (const r of routes) {
      if (r.method === "ALL") continue
      // Strip param placeholders so `/settings/api/features/:adapter`
      // becomes `/settings/api/features/x` — a fetchable path.
      const probePath = r.path.replace(/:\w+/g, "x")
      prefixes.add(probePath)
    }

    const failures: string[] = []
    for (const path of prefixes) {
      if (PUBLIC_PREFIXES.has(path)) continue
      const res = await app.fetch(new Request(`http://localhost${path}`))
      // Non-401 → not gated. 401 → correctly gated. Any other status (404,
      // 405) on a route the server registered would itself be surprising.
      if (res.status !== 401) {
        failures.push(`${path} returned ${res.status} (expected 401 — not protected by requireAuth)`)
      }
    }

    expect(failures).toEqual([])
  })
})
