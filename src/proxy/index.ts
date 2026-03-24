import type { Server } from "node:http";
import { createServer } from "node:http";
import type { ServerType } from "@hono/node-server";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "@/logger";
import { handleMessages } from "@/providers/claude";
import type { ProxyEnv } from "@/proxy/env";
import { withThrottle } from "@/proxy/throttle";
import { registerHealthRoutes } from "./health";
import { mountTelemetryRoutes } from "./telemetry/mount";

export interface ProxyConfig {
  port: number;
  host: string;
  debug: boolean;
  idleTimeoutSeconds: number;
  silent: boolean;
}

export interface ProxyInstance {
  server: Server;
  config: ProxyConfig;
  close(): Promise<void>;
}

export interface ProxyServer {
  app: Hono<ProxyEnv>;
  config: ProxyConfig;
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1",
  idleTimeoutSeconds: 120,
  silent: false,
};

export function createProxyServer(
  config: Partial<ProxyConfig> = {},
): ProxyServer {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config };
  const app = new Hono<ProxyEnv>();
  app.use(cors());

  app.get("/", (c) =>
    c.json({
      service: "opencode-claude-max-proxy",
      version: process.env.npm_package_version || "unknown",
    }),
  );

  app.post("/v1/messages", withThrottle(handleMessages));
  app.post("/messages", withThrottle(handleMessages));

  mountTelemetryRoutes(app);
  registerHealthRoutes(app);

  app.all("*", (c) => {
    const path = new URL(c.req.url).pathname;
    logger.warn("No route matched", { method: c.req.method, path });
    return c.json(
      {
        error: {
          type: "not_found",
          message: `No handler for ${c.req.method} ${path}`,
        },
      },
      404,
    );
  });

  return { app, config: finalConfig };
}

export async function startProxyServer(
  config: Partial<ProxyConfig> = {},
): Promise<ProxyInstance> {
  const { app, config: finalConfig } = createProxyServer(config);
  const server = createServer(getRequestListener(app.fetch));

  const idleMs = finalConfig.idleTimeoutSeconds * 1000;
  server.keepAliveTimeout = idleMs;
  server.headersTimeout = idleMs + 1000;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && !finalConfig.silent) {
      logger.error("Port already in use (another proxy on this address?)", {
        code: error.code,
        message: error.message,
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(finalConfig.port, finalConfig.host, () => {
      if (!finalConfig.silent) {
        logger.start(
          `Listening on http://${finalConfig.host}:${finalConfig.port}`,
        );
      }

      const instance: ProxyInstance = {
        server,
        config: finalConfig,
        close: () => stopProxyServer(server),
      };
      resolve(instance);
    });
  });
}

export function stopProxyServer(server: ServerType): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        logger.error("Error while stopping proxy", { message: err.message });
        reject(err);
      } else {
        logger.success("Proxy server stopped");
        resolve();
      }
    });
  });
}

export type { ProxyEnv, ProxyTelemetryVar } from "./env";
