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

import { execFileSync, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveClaudeExecutableSync } from "./models"
import type { ProfileConfig } from "./profiles"
import { setSetting } from "./settings"
import { createPlatformCredentialStore } from "./tokenRefresh"

const PROFILES_DIR = join(homedir(), ".config", "meridian", "profiles")
const CONFIG_FILE = join(homedir(), ".config", "meridian", "profiles.json")
const OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
const OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]

function ensureProfilesDir(): void {
  mkdirSync(PROFILES_DIR, { recursive: true })
}

function getProfileDir(id: string): string {
  return join(PROFILES_DIR, id)
}

interface AuthLoginOptions {
  headless?: boolean
}

interface ManualOAuthSession {
  authorizeUrl: string
  codeVerifier: string
  state: string
}

interface ParsedAuthorizationCode {
  code: string
  state?: string
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
  scope?: string
}

export function buildAuthLoginEnv(
  configDir: string | undefined,
  _options: AuthLoginOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  return env
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

export function createManualOAuthSession(): ManualOAuthSession {
  const codeVerifier = base64Url(randomBytes(32))
  const state = base64Url(randomBytes(32))
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
  const url = new URL(OAUTH_AUTHORIZE_URL)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", OAUTH_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI)
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "))
  url.searchParams.set("code_challenge", codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", state)
  return { authorizeUrl: url.toString(), codeVerifier, state }
}

export function parseAuthorizationCodeInput(input: string): ParsedAuthorizationCode | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const url = new URL(trimmed)
    const code = url.searchParams.get("code") ?? new URLSearchParams(url.hash.replace(/^#/, "")).get("code")
    const state = url.searchParams.get("state") ?? new URLSearchParams(url.hash.replace(/^#/, "")).get("state") ?? undefined
    return code ? { code, state } : null
  } catch {}

  const [codePart, hashState] = trimmed.split("#", 2)
  if (!codePart) return null
  const ampersandParams = codePart.includes("&") ? new URLSearchParams(codePart.slice(codePart.indexOf("&") + 1)) : null
  const code = codePart.split("&", 1)[0]?.trim()
  const state = ampersandParams?.get("state") ?? hashState?.trim() ?? undefined
  return code ? { code, state } : null
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
  writeFileSync(CONFIG_FILE, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 })
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

async function completeManualOAuthLogin(configDir: string): Promise<boolean> {
  const session = createManualOAuthSession()
  console.log("\x1b[33m⚠ Headless OAuth login: open this URL in a browser:\x1b[0m")
  console.log()
  console.log(session.authorizeUrl)
  console.log()
  console.log("After sign-in, paste the code shown by Claude below.")
  const input = promptLine("Paste code:")
  const parsed = parseAuthorizationCodeInput(input)
  if (!parsed) {
    console.error("\x1b[31m✗ No authorization code received.\x1b[0m")
    return false
  }
  if (parsed.state && parsed.state !== session.state) {
    console.error("\x1b[31m✗ OAuth state mismatch. Please retry the login.\x1b[0m")
    return false
  }

  let response: Response
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: OAUTH_CLIENT_ID,
        code: parsed.code,
        redirect_uri: OAUTH_REDIRECT_URI,
        code_verifier: session.codeVerifier,
        state: parsed.state ?? session.state,
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    console.error(`\x1b[31m✗ OAuth token exchange failed: ${err instanceof Error ? err.message : err}\x1b[0m`)
    return false
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error(`\x1b[31m✗ OAuth token exchange failed (${response.status}).\x1b[0m`)
    if (body) console.error(`  ${body.slice(0, 300)}`)
    return false
  }

  let tokenData: OAuthTokenResponse
  try {
    tokenData = await response.json() as OAuthTokenResponse
  } catch (err) {
    console.error(`\x1b[31m✗ OAuth token response was invalid: ${err instanceof Error ? err.message : err}\x1b[0m`)
    return false
  }

  if (!tokenData.access_token || !tokenData.refresh_token) {
    console.error("\x1b[31m✗ OAuth token response did not include the required tokens.\x1b[0m")
    return false
  }

  const expiresAt = tokenData.expires_at ?? Date.now() + (tokenData.expires_in ?? 8 * 60 * 60) * 1000
  const store = createPlatformCredentialStore({ claudeConfigDir: configDir })
  return store.write({
    claudeAiOauth: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt,
      scopes: tokenData.scope?.split(" ").filter(Boolean) ?? OAUTH_SCOPES,
    },
  })
}

export async function profileAdd(id: string, options: AuthLoginOptions = {}): Promise<void> {
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

  if (!options.headless) {
    console.log("\x1b[33m⚠ Important: Before logging in, make sure you're signed into the")
    console.log(`  correct Claude account in your browser (the one for "${id}").\x1b[0m`)
    console.log()
    console.log("  If you're currently signed into a different account:")
    console.log("    1. Go to https://claude.ai and sign out")
    console.log("    2. Sign in with the account you want for this profile")
    console.log("    3. Come back here — the login will open your browser")
    console.log()
    console.log("  Press Ctrl+C to cancel, or wait for the browser to open...")
  }
  console.log()

  if (options.headless) {
    const success = await completeManualOAuthLogin(configDir)
    if (!success) {
      console.error("\x1b[31m✗ Login failed.\x1b[0m")
      process.exit(1)
    }
  } else {
    // Run claude auth login with the profile's config dir. Route through
    // the sync resolver so we don't depend on `claude` being on PATH (#478).
    const resolvedAuth = resolveClaudeExecutableSync()
    if (!resolvedAuth) {
      console.error("\x1b[31m✗ Could not find a Claude executable to run auth login.\x1b[0m")
      console.error("  Install via: npm install -g @anthropic-ai/claude-code, or set MERIDIAN_CLAUDE_PATH=/path/to/claude")
      process.exit(1)
    }
    const result = spawnSync(resolvedAuth.path, ["auth", "login"], {
      env: buildAuthLoginEnv(configDir, options),
      stdio: "inherit",
    })

    if (result.status !== 0) {
      console.error("\x1b[31m✗ Login failed.\x1b[0m")
      process.exit(1)
    }
  }

  // Verify auth succeeded
  const auth = getAuthStatus(configDir)
  if (!auth.loggedIn) {
    console.error(`\x1b[31m✗ Login did not complete. Try again: meridian profile add ${id}\x1b[0m`)
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
  if (profile.claudeConfigDir?.startsWith(profilesDir)) {
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

  const removed = profiles[idx]
  if (!removed) {
    console.error(`\x1b[31m✗ Profile "${id}" not found.\x1b[0m`)
    process.exit(1)
  }
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

export async function profileLogin(id: string, options: AuthLoginOptions = {}): Promise<void> {
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
  if (!options.headless) {
    console.log("\x1b[33m⚠ Make sure you're signed into the correct Claude account in your browser.\x1b[0m")
  }
  console.log()

  if (options.headless) {
    const success = await completeManualOAuthLogin(profile.claudeConfigDir ?? getProfileDir(id))
    if (!success) {
      console.error("\x1b[31m✗ Login failed.\x1b[0m")
      process.exit(1)
    }
  } else {
    // Route through the sync resolver — see profileAdd above (#478).
    const resolvedLogin = resolveClaudeExecutableSync()
    if (!resolvedLogin) {
      console.error("\x1b[31m✗ Could not find a Claude executable to run auth login.\x1b[0m")
      console.error("  Install via: npm install -g @anthropic-ai/claude-code, or set MERIDIAN_CLAUDE_PATH=/path/to/claude")
      process.exit(1)
    }
    const result = spawnSync(resolvedLogin.path, ["auth", "login"], {
      env: buildAuthLoginEnv(profile.claudeConfigDir, options),
      stdio: "inherit",
    })

    if (result.status !== 0) {
      console.error("\x1b[31m✗ Login failed.\x1b[0m")
      process.exit(1)
    }
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

function promptLine(question: string): string {
  process.stderr.write(`${question} `)
  const result = spawnSync("node", ["-e", [
    `const rl = require("readline").createInterface({ input: process.stdin });`,
    `rl.once("line", (a) => { process.stdout.write(a); rl.close(); });`,
    `rl.once("close", () => process.exit(0));`,
  ].join("\n")], { stdio: ["inherit", "pipe", "inherit"] })
  return result.stdout?.toString().trim() ?? ""
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
  meridian profile add <name> [--headless]          Add a profile via Claude OAuth login
  meridian profile add <name> --oauth-token [TOKEN] Add a profile from a \`claude setup-token\` value
                                                    (if TOKEN is omitted, you will be prompted; input is hidden)
  meridian profile list                             List profiles and auth status
  meridian profile remove <name>                    Remove a profile
  meridian profile switch <name>                    Switch the active profile (requires running proxy)
  meridian profile login <name> [--headless]        Re-authenticate an existing profile (claude-max only)

Examples:
  meridian profile add personal                     # Add personal account (browser login)
  meridian profile add work                         # Add work account
  meridian profile add work --headless              # Print OAuth URL, prompt for returned code, store credentials
  meridian profile add ci --oauth-token             # Add headless CI profile (prompted, no echo)
  meridian profile add ci --oauth-token sk-ant-oat01-...
                                                    # Add headless CI profile (token from CLI argument)
  meridian profile login work --headless            # Re-authenticate via OAuth URL/code prompt
  meridian profile switch work                      # Switch to work account
  meridian profile list                             # Show all profiles`)
}
