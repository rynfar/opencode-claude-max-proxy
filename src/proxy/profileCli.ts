/**
 * CLI commands for profile management.
 *
 * Browser-login profiles are stored under ~/.config/meridian/profiles/{id}/
 * — each directory is a standalone CLAUDE_CONFIG_DIR with its own OAuth
 * tokens. OAuth-token profiles (added via `--oauth-token`) live entirely in
 * profiles.json — no per-profile config dir.
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { homedir } from "node:os"
import type { ProfileConfig } from "./profiles"
import { resolveClaudeExecutableSync } from "./models"
import { setSetting } from "./settings"

const PROFILES_DIR = join(homedir(), ".config", "meridian", "profiles")
const CONFIG_FILE = join(homedir(), ".config", "meridian", "profiles.json")

function ensureProfilesDir(): void {
  mkdirSync(PROFILES_DIR, { recursive: true })
}

function getProfileDir(id: string): string {
  return join(PROFILES_DIR, id)
}

function loadProfileConfig(): ProfileConfig[] {
  if (!existsSync(CONFIG_FILE)) return []
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
  } catch (err) {
    console.warn(`[meridian] Failed to read ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`)
    return []
  }
}

function saveProfileConfig(profiles: ProfileConfig[]): void {
  ensureProfilesDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(profiles, null, 2) + "\n", { mode: 0o600 })
}

function getAuthStatus(configDir: string): { loggedIn: boolean; email?: string; subscriptionType?: string } {
  // Route through the synchronous resolver instead of relying on `claude`
  // being on PATH (#478). The CLI command runs in whatever environment
  // the user invokes it — under systemd or bunx-without-global-claude,
  // PATH won't have a claude binary even when meridian's own bundled or
  // platform-package binary is right there in node_modules.
  const resolved = resolveClaudeExecutableSync()
  if (!resolved) {
    console.warn(`[meridian] Could not resolve a Claude executable for auth check (set MERIDIAN_CLAUDE_PATH or install @anthropic-ai/claude-code)`)
    return { loggedIn: false }
  }
  try {
    // execFileSync (vs execSync) avoids quoting issues with spaces in the
    // resolved path and bypasses the shell entirely — no PATH lookup.
    const result = execFileSync(resolved.path, ["auth", "status"], {
      timeout: 5000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    })
    return JSON.parse(result.toString())
  } catch (err) {
    console.warn(`[meridian] Auth check failed for ${configDir}: ${err instanceof Error ? err.message : err}`)
    return { loggedIn: false }
  }
}

export function profileAdd(id: string): void {
  if (!id || /[^a-zA-Z0-9_-]/.test(id)) {
    console.error("\x1b[31m✗ Invalid profile ID.\x1b[0m Use only letters, numbers, hyphens, underscores.")
    process.exit(1)
  }

  const profiles = loadProfileConfig()
  if (profiles.find(p => p.id === id)) {
    console.error(`\x1b[31m✗ Profile "${id}" already exists.\x1b[0m`)
    console.error(`  Run: meridian profile list`)
    process.exit(1)
  }

  // Offer to import existing ~/.claude credentials if this is the first profile
  // and the default config dir has valid, active auth
  const defaultClaudeDir = join(homedir(), ".claude")
  const alreadyImported = profiles.some(p => p.claudeConfigDir === defaultClaudeDir)
  if (!alreadyImported) {
    const defaultAuth = getAuthStatus(defaultClaudeDir)
    if (defaultAuth.loggedIn) {
      console.log(`\x1b[32m✓ Found existing Claude credentials (${defaultAuth.email}, ${defaultAuth.subscriptionType || "unknown"})\x1b[0m`)
      const answer = promptYesNo(`  Import as profile "${id}"?`)
      if (answer) {
        profiles.push({ id, claudeConfigDir: defaultClaudeDir })
        saveProfileConfig(profiles)
        console.log(`\x1b[32m✓ Profile "${id}" imported — using ${defaultAuth.email}\x1b[0m`)
        printEnvHint(profiles)
        return
      }
      console.log()
      console.log("  Skipped import — will create a fresh profile instead.")
      console.log()
    }
  }

  const configDir = getProfileDir(id)
  mkdirSync(configDir, { recursive: true })

  console.log(`\x1b[36mAdding profile: ${id}\x1b[0m`)
  console.log(`  Config dir: ${configDir}`)
  console.log()

  // Check if already logged in from a previous attempt
  const existingAuth = getAuthStatus(configDir)
  if (existingAuth.loggedIn) {
    console.log(`\x1b[32m✓ Already authenticated as ${existingAuth.email}\x1b[0m`)
    profiles.push({ id, claudeConfigDir: configDir })
    saveProfileConfig(profiles)
    printEnvHint(profiles)
    return
  }

  console.log("\x1b[33m⚠ Important: Before logging in, make sure you're signed into the")
  console.log(`  correct Claude account in your browser (the one for "${id}").\x1b[0m`)
  console.log()
  console.log("  If you're currently signed into a different account:")
  console.log("    1. Go to https://claude.ai and sign out")
  console.log("    2. Sign in with the account you want for this profile")
  console.log("    3. Come back here — the login will open your browser")
  console.log()
  console.log("  Press Ctrl+C to cancel, or wait for the browser to open...")
  console.log()

  // Run claude auth login with the profile's config dir. Route through
  // the sync resolver so we don't depend on `claude` being on PATH (#478).
  const resolvedAuth = resolveClaudeExecutableSync()
  if (!resolvedAuth) {
    console.error("\x1b[31m✗ Could not find a Claude executable to run auth login.\x1b[0m")
    console.error("  Install via: npm install -g @anthropic-ai/claude-code, or set MERIDIAN_CLAUDE_PATH=/path/to/claude")
    process.exit(1)
  }
  const result = spawnSync(resolvedAuth.path, ["auth", "login"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: "inherit",
  })

  if (result.status !== 0) {
    console.error("\x1b[31m✗ Login failed.\x1b[0m")
    process.exit(1)
  }

  // Verify auth succeeded
  const auth = getAuthStatus(configDir)
  if (!auth.loggedIn) {
    console.error("\x1b[31m✗ Login did not complete. Try again: meridian profile add " + id + "\x1b[0m")
    process.exit(1)
  }

  console.log()
  console.log(`\x1b[32m✓ Profile "${id}" created — logged in as ${auth.email} (${auth.subscriptionType || "unknown"})\x1b[0m`)

  profiles.push({ id, claudeConfigDir: configDir })
  saveProfileConfig(profiles)
  printEnvHint(profiles)
}

export async function profileAddOauthToken(id: string, tokenArg: string | undefined): Promise<void> {
  if (!id || /[^a-zA-Z0-9_-]/.test(id)) {
    console.error("\x1b[31m✗ Invalid profile ID.\x1b[0m Use only letters, numbers, hyphens, underscores.")
    process.exit(1)
  }

  const profiles = loadProfileConfig()
  if (profiles.find(p => p.id === id)) {
    console.error(`\x1b[31m✗ Profile "${id}" already exists.\x1b[0m`)
    console.error(`  Run: meridian profile list`)
    process.exit(1)
  }

  let token = tokenArg?.trim() ?? ""
  if (!token) {
    console.log(`\x1b[36mAdding profile: ${id} (OAuth token)\x1b[0m`)
    console.log(`  Generate a token with: \x1b[1mclaude setup-token\x1b[0m`)
    console.log()
    token = promptToken(`Paste OAuth token for "${id}" (input hidden):`)
  }

  if (!token) {
    console.error("\x1b[31m✗ Empty token. Aborted.\x1b[0m")
    process.exit(1)
  }

  profiles.push({ id, type: "oauth-token", oauthToken: token })
  saveProfileConfig(profiles)
  console.log(`\x1b[32m✓ Profile "${id}" added (OAuth token).\x1b[0m`)
  printEnvHint(profiles)
}

export function profileList(): void {
  const profiles = loadProfileConfig()
  if (profiles.length === 0) {
    console.log("No profiles configured.")
    console.log("  Add one: meridian profile add <name>")
    return
  }

  console.log("Profiles:\n")
  for (const p of profiles) {
    if (p.oauthToken || p.type === "oauth-token") {
      console.log(`  ${p.id.padEnd(20)} \x1b[32m✓ OAuth token\x1b[0m`)
      continue
    }
    const auth = getAuthStatus(p.claudeConfigDir ?? "")
    const status = auth.loggedIn
      ? `\x1b[32m✓ ${auth.email} (${auth.subscriptionType || "unknown"})\x1b[0m`
      : "\x1b[31m✗ not logged in\x1b[0m"
    console.log(`  ${p.id.padEnd(20)} ${status}`)
  }
  console.log()
  printEnvHint(profiles)
}

/**
 * Pure: resolve which on-disk directories should be removed when this profile
 * is deleted. Browser-login profiles drop their explicit `claudeConfigDir`
 * (provided it lives under `profilesDir`); oauth-token profiles drop the
 * pinned isolation dir at `profilesDir/<id>` (created by the SDK during use,
 * not stored on the profile itself).
 *
 * Caller is responsible for the actual `rmSync` — this returns paths only.
 */
export function dirsToRemoveOnProfileRemove(profile: ProfileConfig, profilesDir: string): string[] {
  const dirs: string[] = []
  if (profile.claudeConfigDir && profile.claudeConfigDir.startsWith(profilesDir)) {
    dirs.push(profile.claudeConfigDir)
  }
  if (profile.oauthToken || profile.type === "oauth-token") {
    const isolationDir = join(profilesDir, profile.id)
    if (!dirs.includes(isolationDir)) dirs.push(isolationDir)
  }
  return dirs
}

export function profileRemove(id: string): void {
  const profiles = loadProfileConfig()
  const idx = profiles.findIndex(p => p.id === id)
  if (idx === -1) {
    console.error(`\x1b[31m✗ Profile "${id}" not found.\x1b[0m`)
    process.exit(1)
  }

  const removed = profiles[idx]!
  const dirsToRemove = dirsToRemoveOnProfileRemove(removed, PROFILES_DIR)
  profiles.splice(idx, 1)
  saveProfileConfig(profiles)

  for (const dir of dirsToRemove) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  console.log(`\x1b[32m✓ Profile "${id}" removed.\x1b[0m`)
  if (profiles.length > 0) {
    printEnvHint(profiles)
  }
}

export async function profileSwitch(id: string): Promise<void> {
  const port = process.env.MERIDIAN_PORT ?? process.env.CLAUDE_PROXY_PORT ?? "3456"
  const host = process.env.MERIDIAN_HOST ?? process.env.CLAUDE_PROXY_HOST ?? "127.0.0.1"

  try {
    const res = await fetch(`http://${host}:${port}/profiles/active`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: id }),
      signal: AbortSignal.timeout(5000),
    })
    const body = await res.json() as { success?: boolean; error?: string }
    if (body.success) {
      // Also persist locally so it survives proxy restarts
      setSetting("activeProfile", id)
      console.log(`\x1b[32m✓ Switched to profile: ${id}\x1b[0m`)
    } else {
      console.error(`\x1b[31m✗ ${body.error}\x1b[0m`)
      process.exit(1)
    }
  } catch {
    console.error("\x1b[31m✗ Could not connect to Meridian. Is it running?\x1b[0m")
    process.exit(1)
  }
}

export function profileLogin(id: string): void {
  const profiles = loadProfileConfig()
  const profile = profiles.find(p => p.id === id)
  if (!profile) {
    console.error(`\x1b[31m✗ Profile "${id}" not found.\x1b[0m Run: meridian profile add ${id}`)
    process.exit(1)
  }

  if (profile.oauthToken || profile.type === "oauth-token") {
    console.error(`\x1b[31m✗ Profile "${id}" uses an OAuth token; \`claude auth login\` does not apply.\x1b[0m`)
    console.error(`  To replace the token: meridian profile remove ${id} && meridian profile add ${id} --oauth-token`)
    process.exit(1)
  }

  console.log(`\x1b[36mRe-authenticating profile: ${id}\x1b[0m`)
  console.log()
  console.log("\x1b[33m⚠ Make sure you're signed into the correct Claude account in your browser.\x1b[0m")
  console.log()

  // Route through the sync resolver — see profileAdd above (#478).
  const resolvedLogin = resolveClaudeExecutableSync()
  if (!resolvedLogin) {
    console.error("\x1b[31m✗ Could not find a Claude executable to run auth login.\x1b[0m")
    console.error("  Install via: npm install -g @anthropic-ai/claude-code, or set MERIDIAN_CLAUDE_PATH=/path/to/claude")
    process.exit(1)
  }
  const result = spawnSync(resolvedLogin.path, ["auth", "login"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: profile.claudeConfigDir },
    stdio: "inherit",
  })

  if (result.status !== 0) {
    console.error("\x1b[31m✗ Login failed.\x1b[0m")
    process.exit(1)
  }

  const auth = getAuthStatus(profile.claudeConfigDir ?? "")
  if (auth.loggedIn) {
    console.log(`\x1b[32m✓ Profile "${id}" authenticated as ${auth.email}\x1b[0m`)
  }
}

/** Synchronous Y/n prompt. Returns true for yes (default). */
function promptYesNo(question: string): boolean {
  // Write the prompt to stderr (inherited → visible in terminal).
  // Spawn a tiny node process to read one line from stdin and echo it to
  // stdout (piped) so we can capture the answer without a readline dep here.
  process.stderr.write(`${question} [Y/n] `)
  const result = spawnSync("node", ["-e", [
    `const rl = require("readline").createInterface({ input: process.stdin });`,
    `rl.once("line", (a) => { process.stdout.write(a); rl.close(); });`,
    `rl.once("close", () => process.exit(0));`,
  ].join("\n")], { stdio: ["inherit", "pipe", "inherit"] })
  const answer = (result.stdout?.toString().trim() ?? "").toLowerCase()
  return answer !== "n" && answer !== "no"
}

/** Synchronous secret prompt. Reads one line from stdin without echoing typed
 *  characters (TTY). Falls back to a piped read when stdin is not a TTY so
 *  `echo $TOKEN | meridian profile add ci --oauth-token` keeps working. */
function promptToken(question: string): string {
  process.stderr.write(`${question}\n> `)
  const script = [
    `const stdin = process.stdin;`,
    `if (!stdin.isTTY) {`,
    `  let buf = "";`,
    `  stdin.setEncoding("utf8");`,
    `  stdin.on("data", (c) => { buf += c; });`,
    `  stdin.on("end", () => { process.stdout.write(buf.split(/\\r?\\n/)[0] || ""); process.exit(0); });`,
    `} else {`,
    `  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");`,
    `  let input = "";`,
    `  stdin.on("data", (key) => {`,
    `    if (key === "\\u0003") { process.stderr.write("\\n"); process.exit(1); }`,
    `    else if (key === "\\r" || key === "\\n") {`,
    `      stdin.setRawMode(false); process.stderr.write("\\n");`,
    `      process.stdout.write(input); process.exit(0);`,
    `    }`,
    `    else if (key === "\\u007f" || key === "\\b") {`,
    `      if (input.length > 0) input = input.slice(0, -1);`,
    `    }`,
    `    else { input += key; }`,
    `  });`,
    `}`,
  ].join("\n")
  const result = spawnSync("node", ["-e", script], { stdio: ["inherit", "pipe", "inherit"] })
  if (result.status !== 0) {
    process.stderr.write("\n")
    process.exit(1)
  }
  return (result.stdout?.toString() ?? "").trim()
}

function printEnvHint(_profiles: ProfileConfig[]): void {
  console.log(`\x1b[90mConfig: ${CONFIG_FILE}\x1b[0m`)
  console.log("\x1b[90mProfiles are picked up automatically — no restart needed.\x1b[0m")
}

export function profileHelp(): void {
  console.log(`meridian profile — manage Claude account profiles

Commands:
  meridian profile add <name>                       Add a profile via browser login
  meridian profile add <name> --oauth-token [TOKEN] Add a profile from a \`claude setup-token\` value
                                                    (if TOKEN is omitted, you will be prompted; input is hidden)
  meridian profile list                             List profiles and auth status
  meridian profile remove <name>                    Remove a profile
  meridian profile switch <name>                    Switch the active profile (requires running proxy)
  meridian profile login <name>                     Re-authenticate an existing profile (claude-max only)

Examples:
  meridian profile add personal                     # Add personal account (browser login)
  meridian profile add work                         # Add work account
  meridian profile add ci --oauth-token             # Add headless CI profile (prompted, no echo)
  meridian profile add ci --oauth-token sk-ant-oat01-...
                                                    # Add headless CI profile (token from CLI argument)
  meridian profile switch work                      # Switch to work account
  meridian profile list                             # Show all profiles`)
}
