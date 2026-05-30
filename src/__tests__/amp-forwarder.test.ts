/**
 * Tests for the Amp HTTP forward proxy.
 *
 * These tests start a real upstream server on a random port,
 * point the forwarder at it via AMP_UPSTREAM_URL, and verify
 * the forwarder preserves method, path, body, headers, status, and
 * response body.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { ampForwardRequest } from "../proxy/passthrough/ampForwarder"

let upstreamServer: ReturnType<typeof Bun.serve> | undefined
let upstreamRequests: Array<{ method: string; path: string; headers: Record<string, string>; body: string }> = []
let upstreamResponse: { status: number; headers: Record<string, string>; body: string } = {
  status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}',
}

beforeEach(() => {
  upstreamRequests = []
  upstreamResponse = { status: 200, headers: { "content-type": "application/json" }, body: '{"ok":true}' }
  upstreamServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => { headers[k] = v })
      const body = req.body ? await req.text() : ""
      upstreamRequests.push({ method: req.method, path: url.pathname + url.search, headers, body })
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: upstreamResponse.headers,
      })
    },
  })
  process.env.AMP_UPSTREAM_URL = `http://127.0.0.1:${upstreamServer.port}`
})

afterEach(() => {
  upstreamServer?.stop()
  delete process.env.AMP_UPSTREAM_URL
})

function makeCtx(opts: { method: string; path: string; body?: string; headers?: Record<string, string> }) {
  const url = `http://meridian.local${opts.path}`
  const reqInit: RequestInit = {
    method: opts.method,
    headers: opts.headers ?? {},
  }
  if (opts.body !== undefined) reqInit.body = opts.body
  const request = new Request(url, reqInit)
  return {
    req: {
      raw: request,
      method: opts.method,
      path: opts.path,
      url,
      header: (name?: string) => {
        if (name === undefined) return opts.headers ?? {}
        return (opts.headers ?? {})[name.toLowerCase()] ?? (opts.headers ?? {})[name]
      },
    },
  } as any
}

describe("ampForwardRequest — REST", () => {
  it("forwards GET with path and query preserved", async () => {
    const ctx = makeCtx({ method: "GET", path: "/api/thread-actors?limit=10" })
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0]!.method).toBe("GET")
    expect(upstreamRequests[0]!.path).toBe("/api/thread-actors?limit=10")
  })

  it("forwards POST with body preserved", async () => {
    const ctx = makeCtx({
      method: "POST",
      path: "/api/thread-actors",
      body: '{"hello":"world"}',
      headers: { "content-type": "application/json" },
    })
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(upstreamRequests[0]!.body).toBe('{"hello":"world"}')
    expect(upstreamRequests[0]!.headers["content-type"]).toBe("application/json")
  })

  it("forwards Authorization and x-amp-* headers", async () => {
    const ctx = makeCtx({
      method: "GET",
      path: "/api/thread-actors",
      headers: {
        "authorization": "Bearer amp-key-123",
        "x-amp-thread-id": "T-abc",
        "x-amp-client-type": "cli",
      },
    })
    await ampForwardRequest(ctx)
    expect(upstreamRequests[0]!.headers["authorization"]).toBe("Bearer amp-key-123")
    expect(upstreamRequests[0]!.headers["x-amp-thread-id"]).toBe("T-abc")
    expect(upstreamRequests[0]!.headers["x-amp-client-type"]).toBe("cli")
  })

  it("strips hop-by-hop headers", async () => {
    const ctx = makeCtx({
      method: "GET",
      path: "/api/thread-actors",
      headers: {
        "connection": "keep-alive",
        "keep-alive": "timeout=5",
        "transfer-encoding": "chunked",
        "upgrade": "h2c",
        "te": "trailers",
        "trailer": "Expires",
        "proxy-authorization": "Basic xxx",
        "proxy-authenticate": "xxx",
      },
    })
    await ampForwardRequest(ctx)
    const fwd = upstreamRequests[0]!.headers
    // NOTE: `connection` is intentionally omitted — Bun's fetch() re-adds
    // `connection: keep-alive` regardless of what headers we pass. We verify
    // the remaining hop-by-hop headers are stripped by our filter.
    expect(fwd["keep-alive"]).toBeUndefined()
    expect(fwd["transfer-encoding"]).toBeUndefined()
    expect(fwd["upgrade"]).toBeUndefined()
    expect(fwd["te"]).toBeUndefined()
    expect(fwd["trailer"]).toBeUndefined()
    expect(fwd["proxy-authorization"]).toBeUndefined()
    expect(fwd["proxy-authenticate"]).toBeUndefined()
  })

  it("returns upstream status code", async () => {
    upstreamResponse = { status: 404, headers: { "content-type": "text/plain" }, body: "missing" }
    const ctx = makeCtx({ method: "GET", path: "/api/missing" })
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("missing")
  })

  it("returns upstream response headers", async () => {
    upstreamResponse = {
      status: 200,
      headers: { "content-type": "application/json", "x-amp-server": "v2" },
      body: "{}",
    }
    const ctx = makeCtx({ method: "GET", path: "/api/thread-actors" })
    const res = await ampForwardRequest(ctx)
    expect(res.headers.get("x-amp-server")).toBe("v2")
    expect(res.headers.get("content-type")).toBe("application/json")
  })

  it("returns 503 when MERIDIAN_AMP_FORWARD_DISABLED=true", async () => {
    process.env.MERIDIAN_AMP_FORWARD_DISABLED = "true"
    try {
      const ctx = makeCtx({ method: "GET", path: "/api/thread-actors" })
      const res = await ampForwardRequest(ctx)
      expect(res.status).toBe(503)
      expect(upstreamRequests).toHaveLength(0)
    } finally {
      delete process.env.MERIDIAN_AMP_FORWARD_DISABLED
    }
  })

  it("uses default upstream https://ampcode.com when env not set", async () => {
    delete process.env.AMP_UPSTREAM_URL
    const { getAmpUpstreamUrl } = require("../proxy/passthrough/ampForwarder")
    expect(getAmpUpstreamUrl()).toBe("https://ampcode.com")
    process.env.AMP_UPSTREAM_URL = `http://127.0.0.1:${upstreamServer!.port}`
  })
})

describe("ampForwardRequest — streaming (SSE)", () => {
  it("streams response body without buffering", async () => {
    upstreamServer?.stop()
    const chunks = ["data: a\n\n", "data: b\n\n", "data: c\n\n"]
    upstreamServer = Bun.serve({
      port: 0,
      async fetch(_req) {
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder()
            for (const chunk of chunks) {
              controller.enqueue(enc.encode(chunk))
              await new Promise(r => setTimeout(r, 5))
            }
            controller.close()
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      },
    })
    process.env.AMP_UPSTREAM_URL = `http://127.0.0.1:${upstreamServer.port}`

    const ctx = makeCtx({ method: "GET", path: "/api/thread-actors-stream" })
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/event-stream")

    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let received = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += dec.decode(value)
    }
    expect(received).toBe(chunks.join(""))
  })
})

describe("ampForwardRequest — content-encoding handling", () => {
  it("strips upstream Content-Encoding header so clients don't double-decode", async () => {
    // Upstream returns actually-gzipped bytes. Bun fetch decodes them
    // transparently inside the forwarder, but the Content-Encoding header
    // remains. Forwarding that header verbatim would make the client try to
    // gunzip an already-decoded body — the original `amp threads list` ZlibError.
    upstreamServer?.stop()
    const plainBody = '{"threads":[]}'
    const gzipped = Bun.gzipSync(new TextEncoder().encode(plainBody))
    upstreamServer = Bun.serve({
      port: 0,
      async fetch(_req) {
        return new Response(gzipped, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(gzipped.byteLength),
          },
        })
      },
    })
    process.env.AMP_UPSTREAM_URL = `http://127.0.0.1:${upstreamServer.port}`

    const ctx = makeCtx({ method: "GET", path: "/api/internal?listThreads" })
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(res.headers.get("content-length")).toBeNull()
    expect(res.headers.get("content-type")).toBe("application/json")
    const body = await res.text()
    expect(body).toBe(plainBody)
  })
})
