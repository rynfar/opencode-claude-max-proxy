import { describe, expect, it, mock } from "bun:test";

mock.module("@/logger", () => ({
  logger: {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
    start: () => {},
    success: () => {},
  },
}));

mock.module("@/providers/claude/mcp-tools", () => ({
  createOpencodeMcpServer: () => ({
    type: "sdk",
    name: "opencode",
    instance: {},
  }),
}));

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => {
    return (async function* () {
      yield {
        type: "assistant",
        message: {
          id: "msg_test",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: "sess-1",
      };
    })();
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
}));

const { createProxyServer, startProxyServer } = await import("../src/proxy");

describe("proxy async ops", () => {
  it("creates proxy server with Hono app", () => {
    const { app } = createProxyServer();
    expect(app).toBeDefined();
    expect(app.fetch).toBeDefined();
  });

  it("starts and stops server on ephemeral port", async () => {
    const instance = await startProxyServer({
      port: 0,
      host: "127.0.0.1",
      idleTimeoutSeconds: 120,
      silent: true,
    });
    expect(instance).toBeDefined();
    expect(instance.server).toBeDefined();
    expect(typeof instance.server.keepAliveTimeout).toBe("number");
    await instance.close();
  });

  it("serves health endpoint", async () => {
    const { app } = createProxyServer();
    const response = await app.fetch(new Request("http://localhost/health"));
    const body = (await response.json()) as Record<string, unknown>;

    expect(typeof body.status).toBe("string");
    if (typeof body.status !== "string") {
      throw new Error("expected health status string");
    }
    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status);

    if (body.status === "healthy") {
      expect((body.auth as Record<string, unknown>).loggedIn).toBe(true);
    }

    if (body.status === "unhealthy") {
      expect(typeof body.error).toBe("string");
      expect(response.status).toBe(503);
    }

    if (body.status === "degraded") {
      expect(typeof body.error).toBe("string");
    }
  });

  it("returns degraded health when auth status command fails", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const { app } = createProxyServer();
      const response = await app.fetch(new Request("http://localhost/health"));
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.status).toBe("degraded");
      expect(body.error).toBe("Could not verify Claude Code sign-in");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
