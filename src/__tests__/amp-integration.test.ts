/**
 * HTTP-layer integration test for the Amp adapter.
 *
 * Verifies:
 *  - POST /api/provider/anthropic/v1/messages dispatches through the Amp adapter
 *    (not OpenCode) when no other detection signals are present.
 *  - GET /api/thread-actors is forwarded to AMP_UPSTREAM_URL.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { detectAdapter } from "../proxy/adapters/detect"
import { assistantMessage } from "./helpers"

let mockMessages: any[] = []
let capturedQueryParams: any = null

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryParams = params
    return (async function* () {
      for (const msg of mockMessages) yield msg
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "amp", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}, path: string = "/v1/messages") {
  return app.fetch(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

async function get(app: any, path: string, headers: Record<string, string> = {}) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method: "GET",
    headers,
  }))
}

describe("Amp adapter: detection", () => {
  it("detects /api/provider/anthropic/v1/messages as amp", () => {
    const ctx: any = {
      req: {
        path: "/api/provider/anthropic/v1/messages",
        header: (name?: string) => {
          if (name === undefined) return {}
          return undefined
        },
      },
    }
    expect(detectAdapter(ctx).name).toBe("amp")
  })

  it("detects /api/provider/anthropic with trailing path as amp", () => {
    const ctx: any = {
      req: {
        path: "/api/provider/anthropic/v1/chat/completions",
        header: (name?: string) => {
          if (name === undefined) return {}
          return undefined
        },
      },
    }
    expect(detectAdapter(ctx).name).toBe("amp")
  })

  it("detects x-amp-client-type header as amp", () => {
    const ctx: any = {
      req: {
        path: "/api/thread-actors",
        header: (name?: string) => {
          if (name === undefined) return { "x-amp-client-type": "cli" }
          if (name.toLowerCase() === "x-amp-client-type") return "cli"
          return undefined
        },
      },
    }
    expect(detectAdapter(ctx).name).toBe("amp")
  })

  it("detects any x-amp-* header as amp", () => {
    const ctx: any = {
      req: {
        path: "/api/internal/config",
        header: (name?: string) => {
          if (name === undefined) return { "x-amp-version": "1.0" }
          if (name.toLowerCase() === "x-amp-version") return "1.0"
          return undefined
        },
      },
    }
    expect(detectAdapter(ctx).name).toBe("amp")
  })
})

describe("Amp adapter: HTTP routing", () => {
  let savedPassthrough: string | undefined

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "Done" }])]
    capturedQueryParams = null
    clearSessionCache()
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "0"
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
  })

  it("routes POST /api/provider/anthropic/v1/messages through amp adapter", async () => {
    const app = createTestApp()
    const body = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }
    const res = await post(app, body, {}, "/api/provider/anthropic/v1/messages")
    expect(res.status).toBe(200)
    expect(capturedQueryParams).toBeDefined()
    // Verify amp adapter was used by checking MCP server configuration
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(Object.keys(mcpServers)).toContain("amp")
  })

  it("uses amp MCP server when request has x-amp-thread-id header", async () => {
    const app = createTestApp()
    const body = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    }
    const res = await post(app, body, { "x-amp-thread-id": "thread-123" })
    expect(res.status).toBe(200)
    const mcpServers = capturedQueryParams.options.mcpServers
    expect(Object.keys(mcpServers)).toContain("amp")
  })
})

describe("Amp forwarder: integration", () => {
  let upstream: ReturnType<typeof Bun.serve> | undefined
  let received: { method: string; path: string; body: string } | undefined

  beforeEach(() => {
    received = undefined
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const body = req.body ? await req.text() : ""
        received = { method: req.method, path: url.pathname + url.search, body }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
    })
    process.env.AMP_UPSTREAM_URL = `http://127.0.0.1:${upstream.port}`
  })

  afterEach(() => {
    upstream?.stop()
    delete process.env.AMP_UPSTREAM_URL
  })

  it("forwarder reaches the configured upstream", async () => {
    const { ampForwardRequest } = await import("../proxy/passthrough/ampForwarder")
    const request = new Request("http://meridian.local/api/thread-actors?limit=5", { method: "GET" })
    const ctx: any = {
      req: {
        raw: request,
        method: "GET",
        path: "/api/thread-actors",
        url: request.url,
        header: () => ({}),
      },
    }
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(received?.path).toBe("/api/thread-actors?limit=5")
  })

  it("forwarder preserves query parameters", async () => {
    const { ampForwardRequest } = await import("../proxy/passthrough/ampForwarder")
    const request = new Request("http://meridian.local/api/attachments?file_id=abc&include=metadata", { method: "GET" })
    const ctx: any = {
      req: {
        raw: request,
        method: "GET",
        path: "/api/attachments",
        url: request.url,
        header: () => ({}),
      },
    }
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(received?.path).toBe("/api/attachments?file_id=abc&include=metadata")
  })

  it("forwarder forwards POST requests with body", async () => {
    const { ampForwardRequest } = await import("../proxy/passthrough/ampForwarder")
    const bodyText = JSON.stringify({ data: "test" })
    const request = new Request("http://meridian.local/api/telemetry", {
      method: "POST",
      body: bodyText,
      headers: { "content-type": "application/json" },
    })
    const ctx: any = {
      req: {
        raw: request,
        method: "POST",
        path: "/api/telemetry",
        url: request.url,
        header: () => ({}),
      },
    }
    const res = await ampForwardRequest(ctx)
    expect(res.status).toBe(200)
    expect(received?.method).toBe("POST")
  })
})
