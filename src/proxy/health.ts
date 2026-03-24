import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import type { Hono } from "hono";
import type { ProxyEnv } from "./env";
import { throttleStats } from "./throttle";

const exec = promisify(execCallback);

export function registerHealthRoutes(app: Hono<ProxyEnv>): void {
  app.get("/health", async (c) => {
    const stats = throttleStats();
    try {
      const { stdout } = await exec("claude auth status", { timeout: 5000 });
      const auth = JSON.parse(stdout);
      if (!auth.loggedIn) {
        return c.json(
          {
            status: "unhealthy",
            error: "Not signed in to Claude Code. Run: claude login",
            auth: { loggedIn: false },
          },
          503,
        );
      }
      return c.json({
        status: "healthy",
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
        },
        mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
        sessions: stats,
      });
    } catch {
      return c.json({
        status: "degraded",
        error: "Could not verify Claude Code sign-in",
        mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
        sessions: stats,
      });
    }
  });
}
