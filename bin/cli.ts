#!/usr/bin/env node

import { startProxyServer } from "../src/proxy/server"
import { loadProxyConfigFile } from "../src/proxy/configLoader"
import { exec as execCallback } from "child_process"
import { promisify } from "util"
import type { ProxyConfig } from "../src/proxy/types"

const exec = promisify(execCallback)

// Prevent SDK subprocess crashes from killing the proxy
process.on("uncaughtException", (err) => {
  console.error(`[PROXY] Uncaught exception (recovered): ${err.message}`)
})
process.on("unhandledRejection", (reason) => {
  console.error(`[PROXY] Unhandled rejection (recovered): ${reason instanceof Error ? reason.message : reason}`)
})

function getEnvConfigOverrides(env: NodeJS.ProcessEnv = process.env): Partial<ProxyConfig> {
  const overrides: Partial<ProxyConfig> = {}

  if (env.CLAUDE_PROXY_PORT) overrides.port = parseInt(env.CLAUDE_PROXY_PORT, 10)
  if (env.CLAUDE_PROXY_HOST) overrides.host = env.CLAUDE_PROXY_HOST
  if (env.CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS) {
    overrides.idleTimeoutSeconds = parseInt(env.CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS, 10)
  }
  if (env.CLAUDE_PROXY_DEBUG) overrides.debug = env.CLAUDE_PROXY_DEBUG === "1"
  if (env.CLAUDE_PROXY_API_KEYS) {
    overrides.requiredApiKeys = env.CLAUDE_PROXY_API_KEYS.split(",").map((key) => key.trim()).filter(Boolean)
  }

  return overrides
}

export async function runCli(
  start = startProxyServer,
  runExec: typeof exec = exec
) {
  // Pre-flight auth check
  try {
    const { stdout } = await runExec("claude auth status", { timeout: 5000 })
    const auth = JSON.parse(stdout)
    if (!auth.loggedIn) {
      console.error("\x1b[31m✗ Not logged in to Claude.\x1b[0m Run: claude login")
      process.exit(1)
    }
    if (auth.subscriptionType !== "max") {
      console.error(`\x1b[33m⚠ Claude subscription: ${auth.subscriptionType || "unknown"} (Max recommended)\x1b[0m`)
    }
  } catch {
    console.error("\x1b[33m⚠ Could not verify Claude auth status. If requests fail, run: claude login\x1b[0m")
  }

  const fileConfig = loadProxyConfigFile()
  const envOverrides = getEnvConfigOverrides()
  const proxy = await start({ ...fileConfig, ...envOverrides })

  // Handle EADDRINUSE — preserve CLI behavior of exiting on port conflict
  proxy.server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.exit(1)
    }
  })
}

if (import.meta.main) {
  try {
    await runCli()
  } catch (error) {
    console.error(`[PROXY] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
