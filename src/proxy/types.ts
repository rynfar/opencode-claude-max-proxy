import type { Server } from "node:http"
import type { ProfileConfig } from "./profiles"

export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  idleTimeoutSeconds: number
  silent: boolean
  /** Named auth profiles for multi-account support */
  profiles?: ProfileConfig[]
  /** Default profile ID when no header is sent */
  defaultProfile?: string
  /** Package version, exposed via /health endpoint */
  version?: string
  /** Plugin auto-discovery directory. Defaults to ~/.config/meridian/plugins/. */
  pluginDir?: string
  /** Plugin config file path. Defaults to ~/.config/meridian/plugins.json. */
  pluginConfigPath?: string
  /**
   * Install process-level uncaughtException/unhandledRejection handlers that
   * log and swallow socket-level errors (EPIPE, ECONNRESET, etc.) instead of
   * crashing the host process. Defaults to false to preserve any handlers a
   * library consumer has already installed; the bundled CLI passes `true`.
   */
  installProcessErrorHandlers?: boolean
}

export interface ProxyInstance {
  /** The underlying http.Server */
  server: Server
  /** The resolved proxy configuration */
  config: ProxyConfig
  /** Gracefully shut down the proxy server and clean up resources */
  close(): Promise<void>
}

/** Return type of createProxyServer — avoids leaking Hono internals to consumers */
export interface ProxyServer {
  /** The HTTP app — pass `app.fetch` to your server of choice */
  app: { fetch: (request: Request, ...rest: any[]) => Response | Promise<Response> }
  /** The resolved proxy configuration */
  config: ProxyConfig
  /** Load plugins from disk and wire them into the request pipeline */
  initPlugins?(): Promise<void>
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: (process.env.MERIDIAN_DEBUG ?? process.env.CLAUDE_PROXY_DEBUG) === "1",
  idleTimeoutSeconds: 120,
  silent: false,
  profiles: undefined,
  defaultProfile: undefined,
  version: undefined,
}
