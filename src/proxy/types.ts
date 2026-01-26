export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  idleTimeout: number
  sseHeartbeatMs: number
  maxTurns: number
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "delegate" | "dontAsk"
  allowDangerouslySkipPermissions: boolean
}

const intEnv = (name: string, fallback: number) => {
  const raw = process.env[name]
  const parsed = raw ? Number.parseInt(raw, 10) : fallback
  return Number.isFinite(parsed) ? parsed : fallback
}

const boolEnv = (name: string, fallback: boolean) => {
  const raw = process.env[name]
  if (!raw) return fallback
  return raw === "1" || raw.toLowerCase() === "true"
}

const permissionModeEnv = (): ProxyConfig["permissionMode"] => {
  const raw = process.env.CLAUDE_PROXY_PERMISSION_MODE
  if (
    raw === "default" ||
    raw === "acceptEdits" ||
    raw === "bypassPermissions" ||
    raw === "plan" ||
    raw === "delegate" ||
    raw === "dontAsk"
  ) {
    return raw
  }
  return "bypassPermissions"
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  permissionMode: permissionModeEnv(),
  port: 3456,
  host: "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1",
  idleTimeout: intEnv("CLAUDE_PROXY_IDLE_TIMEOUT", 0),
  sseHeartbeatMs: intEnv("CLAUDE_PROXY_SSE_HEARTBEAT_MS", 5000),
  maxTurns: intEnv("CLAUDE_PROXY_MAX_TURNS", 50),
  allowDangerouslySkipPermissions: boolEnv(
    "CLAUDE_PROXY_ALLOW_DANGEROUSLY_SKIP_PERMISSIONS",
    permissionModeEnv() === "bypassPermissions"
  )
}
