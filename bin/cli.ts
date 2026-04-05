#!/usr/bin/env node

import { createRequire } from "module"
import { startProxyServer } from "../src/proxy/server"
import { exec as execCallback } from "child_process"
import { promisify } from "util"

const require = createRequire(import.meta.url)
const { version } = require("../package.json")

const args = process.argv.slice(2)

if (args.includes("--version") || args.includes("-v")) {
  console.log(version)
  process.exit(0)
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`meridian v${version}

Local Anthropic API powered by your Claude Max subscription.

Usage: meridian [command] [options]

Commands:
  (default)        Start the proxy server
  setup            Configure the OpenCode plugin (run once after install)
  profile          Manage Claude account profiles (add, list, switch, remove)
  refresh-token    Refresh the Claude Code OAuth token

Options:
  -v, --version   Show version
  -h, --help      Show this help

Environment variables:
  MERIDIAN_PORT                     Port to listen on (default: 3456)
  MERIDIAN_HOST                     Host to bind to (default: 127.0.0.1)
  MERIDIAN_PASSTHROUGH              Enable passthrough mode (tools forwarded to client)
  MERIDIAN_IDLE_TIMEOUT_SECONDS     Idle timeout in seconds (default: 120)

See https://github.com/rynfar/meridian for full documentation.`)
  process.exit(0)
}

if (args[0] === "profile") {
  const { profileAdd, profileList, profileRemove, profileSwitch, profileLogin, profileHelp } = await import("../src/proxy/profileCli")
  const subcommand = args[1]
  const profileId = args[2]

  if (subcommand === "add" && profileId) profileAdd(profileId)
  else if (subcommand === "list" || subcommand === "ls") profileList()
  else if (subcommand === "remove" && profileId) profileRemove(profileId)
  else if (subcommand === "switch" && profileId) await profileSwitch(profileId)
  else if (subcommand === "login" && profileId) profileLogin(profileId)
  else profileHelp()
  process.exit(0)
}

if (args[0] === "setup") {
  const { findPluginPath, runSetup } = await import("../src/proxy/setup")
  const pluginPath = findPluginPath(import.meta.url)
  const result = runSetup(pluginPath)

  if (result.alreadyConfigured) {
    console.log(`\x1b[32m✓ Meridian plugin already configured\x1b[0m`)
    console.log(`  ${result.configPath}`)
  } else {
    if (result.removedStale.length > 0) {
      console.log(`  Removed ${result.removedStale.length} stale plugin entr${result.removedStale.length === 1 ? "y" : "ies"}`)
    }
    console.log(`\x1b[32m✓ Meridian plugin configured\x1b[0m`)
    console.log(`  Config: ${result.configPath}`)
    console.log(`  Plugin: ${result.pluginPath}`)
    if (!result.created) {
      console.log(`\nRestart OpenCode for the plugin to take effect.`)
    }
  }
  process.exit(0)
}

if (args[0] === "refresh-token") {
  const { refreshOAuthToken } = await import("../src/proxy/tokenRefresh")
  const success = await refreshOAuthToken()
  if (success) {
    console.log("Token refreshed successfully")
    process.exit(0)
  } else {
    console.error("Token refresh failed. If the problem persists, run: claude login")
    process.exit(1)
  }
}

const exec = promisify(execCallback)

// Prevent SDK subprocess crashes from killing the proxy
process.on("uncaughtException", (err) => {
  console.error(`[PROXY] Uncaught exception (recovered): ${err.message}`)
})
process.on("unhandledRejection", (reason) => {
  console.error(`[PROXY] Unhandled rejection (recovered): ${reason instanceof Error ? reason.message : reason}`)
})

const port = parseInt(process.env.MERIDIAN_PORT ?? process.env.CLAUDE_PROXY_PORT ?? "3456", 10)
const host = process.env.MERIDIAN_HOST ?? process.env.CLAUDE_PROXY_HOST ?? "127.0.0.1"
const idleTimeoutSeconds = parseInt(process.env.MERIDIAN_IDLE_TIMEOUT_SECONDS ?? process.env.CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS ?? "120", 10)

// Load profile configuration:
//   1. MERIDIAN_PROFILES env var (JSON array) — takes precedence
//   2. ~/.config/meridian/profiles.json — written by `meridian profile add`
// fs/path/os imports removed — profile discovery now handled by the server

// Profile config: only set from MERIDIAN_PROFILES env var.
// When undefined, the server auto-discovers from ~/.config/meridian/profiles.json
// on each request (so `meridian profile add` works without restart).
import type { ProfileConfig } from "../src/proxy/profiles"
let profiles: ProfileConfig[] | undefined
let defaultProfile: string | undefined
try {
  const raw = process.env.MERIDIAN_PROFILES
  if (raw) {
    profiles = JSON.parse(raw)
    defaultProfile = process.env.MERIDIAN_DEFAULT_PROFILE || undefined
  }
  // No else — let the server auto-discover from disk
} catch (e) {
  console.error(`[meridian] Failed to parse MERIDIAN_PROFILES: ${e instanceof Error ? e.message : e}`)
}

export async function runCli(
  start = startProxyServer,
  runExec: typeof exec = exec
) {
  // Plugin check — warn if OpenCode config exists but meridian plugin is missing
  try {
    const { findOpencodeConfigPath, checkPluginConfigured, findPluginPath } = await import("../src/proxy/setup")
    const configPath = findOpencodeConfigPath()
    const { existsSync } = await import("fs")
    if (existsSync(configPath) && !checkPluginConfigured(configPath)) {
      const pluginPath = findPluginPath(import.meta.url)
      console.error("\x1b[33m⚠ Meridian plugin not found in OpenCode config.\x1b[0m")
      console.error("  Session tracking and subagent model selection won\'t work.")
      console.error(`  Fix: meridian setup`)
      console.error("")
    }
  } catch { /* non-fatal */ }

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

  // Enable disk auto-discovery when no MERIDIAN_PROFILES env var is set.
  // This lets `meridian profile add` work without restarting the server.
  if (!profiles) {
    const { enableDiskProfileDiscovery } = await import("../src/proxy/profiles")
    enableDiskProfileDiscovery()
  }

  const proxy = await start({ port, host, idleTimeoutSeconds, profiles, defaultProfile })

  // Handle EADDRINUSE — preserve CLI behavior of exiting on port conflict
  proxy.server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      process.exit(1)
    }
  })
}

if (import.meta.main) {
  await runCli()
}
