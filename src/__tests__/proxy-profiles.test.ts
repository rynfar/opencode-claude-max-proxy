import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

let capturedQueryOptions: any[] = []

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    capturedQueryOptions.push(params.options)
    const profileDir = params.options?.env?.CLAUDE_CONFIG_DIR
    const sessionSuffix = typeof profileDir === "string"
      ? profileDir.split("/").at(-1)
      : params.options?.env?.ANTHROPIC_API_KEY
        ? "api"
        : "default"

    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: `msg-${sessionSuffix}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `ok-${sessionSuffix}` }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: `sdk-session-${sessionSuffix}`,
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "/usr/bin/claude",
  isClosedControllerError: () => false,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
  hasExtendedContext: () => false,
  stripExtendedContext: (model: string) => model,
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function createTestApp(config: Record<string, any> = {}) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", ...config })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  }))
}

const BASIC_REQUEST = {
  model: "claude-sonnet-4-5",
  max_tokens: 128,
  stream: false,
  messages: [{ role: "user", content: "hello" }],
}

describe("Profile routing", () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    capturedQueryOptions = []
    clearSessionCache()
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) {
      savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("passes CLAUDE_CONFIG_DIR for a claude-max profile", async () => {
    const app = createTestApp({
      profiles: [{ id: "company", claudeConfigDir: "/tmp/company-profile" }],
      defaultProfile: "company",
    })

    await (await post(app, BASIC_REQUEST)).json()

    expect(capturedQueryOptions[0]?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/company-profile")
  })

  it("overlays API profile auth env after inherited Anthropic vars are stripped", async () => {
    process.env.ANTHROPIC_API_KEY = "dummy-key"
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"
    process.env.ANTHROPIC_AUTH_TOKEN = "dummy-token"

    const app = createTestApp({
      profiles: [{
        id: "api-direct",
        type: "api",
        apiKey: "real-key",
        baseUrl: "https://api.example.test",
        authToken: "real-token",
      }],
      defaultProfile: "api-direct",
    })

    await (await post(app, BASIC_REQUEST)).json()

    expect(capturedQueryOptions[0]?.env?.ANTHROPIC_API_KEY).toBe("real-key")
    expect(capturedQueryOptions[0]?.env?.ANTHROPIC_BASE_URL).toBe("https://api.example.test")
    expect(capturedQueryOptions[0]?.env?.ANTHROPIC_AUTH_TOKEN).toBe("real-token")
  })

  it("keeps session resume isolated by requested profile", async () => {
    const app = createTestApp({
      profiles: [
        { id: "personal", claudeConfigDir: "/tmp/personal-profile" },
        { id: "company", claudeConfigDir: "/tmp/company-profile" },
      ],
      defaultProfile: "personal",
    })

    await (await post(app, BASIC_REQUEST, {
      "x-opencode-session": "shared-session",
      "x-meridian-profile": "personal",
    })).json()

    await (await post(app, BASIC_REQUEST, {
      "x-opencode-session": "shared-session",
      "x-meridian-profile": "company",
    })).json()

    await (await post(app, {
      ...BASIC_REQUEST,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "ok-personal-profile" }] },
        { role: "user", content: "remember me" },
      ],
    }, {
      "x-opencode-session": "shared-session",
      "x-meridian-profile": "personal",
    })).json()

    expect(capturedQueryOptions[0]?.resume).toBeUndefined()
    expect(capturedQueryOptions[1]?.resume).toBeUndefined()
    expect(capturedQueryOptions[2]?.resume).toBe("sdk-session-personal-profile")
  })
})
