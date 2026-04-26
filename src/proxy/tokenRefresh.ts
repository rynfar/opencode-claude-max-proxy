/**
 * Cross-platform OAuth token refresh for Claude Code credentials.
 *
 * Storage backends:
 *   macOS  — system Keychain via /usr/bin/security (no prompt — pre-authorised)
 *   Linux  — ~/.claude/.credentials.json
 *
 * The credential store is dependency-injectable for testing. Production code
 * uses createPlatformCredentialStore() which picks the right backend
 * automatically.
 *
 * Concurrent calls to refreshOAuthToken() are deduplicated: if a refresh is
 * already in flight, subsequent callers wait for the same promise rather than
 * issuing a second network request and racing on the write.
 */

import { execFile as execFileCb } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir, platform, userInfo } from "os"
import { join, dirname, resolve } from "path"
import { createHash } from "crypto"
import { promisify } from "util"
import { claudeLog } from "../logger"

const execFile = promisify(execFileCb)

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const KEYCHAIN_SERVICE = "Claude Code-credentials"
const CREDENTIALS_FILE = `${homedir()}/.claude/.credentials.json`
const DEFAULT_CLAUDE_DIR = `${homedir()}/.claude`

/**
 * Map a `claudeConfigDir` to the keychain service name claude-code uses
 * for that directory.
 *
 * Default `~/.claude` uses the bare service name `Claude Code-credentials`.
 * Any other directory uses `Claude Code-credentials-<sha256(absPath).slice(0,8)>` —
 * matching claude-code's own convention so we can read OAuth tokens for
 * additional Meridian profiles without prompting the user.
 */
export function configDirToKeychainService(claudeConfigDir: string): string {
  const abs = resolve(claudeConfigDir)
  if (abs === resolve(DEFAULT_CLAUDE_DIR)) return KEYCHAIN_SERVICE
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8)
  return `${KEYCHAIN_SERVICE}-${hash}`
}

/** Map `claudeConfigDir` to the file-based credentials path. */
export function configDirToCredentialsFile(claudeConfigDir: string): string {
  return join(resolve(claudeConfigDir), ".credentials.json")
}

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string
  rateLimitTier?: string
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Credential store interface — injectable for testing
// ---------------------------------------------------------------------------

export interface CredentialStore {
  read(): Promise<CredentialsFile | null>
  write(credentials: CredentialsFile): Promise<boolean>
}

// ---------------------------------------------------------------------------
// macOS Keychain backend
// ---------------------------------------------------------------------------
//
// Claude Code stores credentials as hex-encoded JSON in the Keychain after
// `claude login`. Older installs may store raw JSON. We detect on read and
// preserve the original encoding on write so Claude Code can always read back
// what we write.

function parseKeychainValue(raw: string): { credentials: CredentialsFile; wasHex: boolean } | null {
  const trimmed = raw.trim()
  // Try raw JSON first
  try {
    return { credentials: JSON.parse(trimmed) as CredentialsFile, wasHex: false }
  } catch {}
  // Try hex-decoded JSON (Claude Code's format after `claude login`)
  try {
    const decoded = Buffer.from(trimmed, "hex").toString("utf-8")
    return { credentials: JSON.parse(decoded) as CredentialsFile, wasHex: true }
  } catch {}
  return null
}

// Track encoding format across read → write within the same refresh call.
// Keyed by service name so per-profile stores don't clobber each other.
const keychainWasHexByService = new Map<string, boolean>()

function buildMacosStore(serviceName: string): CredentialStore {
  return {
    async read() {
      try {
        const { stdout } = await execFile(
          "/usr/bin/security",
          ["find-generic-password", "-s", serviceName, "-a", userInfo().username, "-w"],
          { timeout: 5000 }
        )
        const parsed = parseKeychainValue(stdout)
        if (!parsed) throw new Error("Could not parse keychain value as JSON or hex-encoded JSON")
        keychainWasHexByService.set(serviceName, parsed.wasHex)
        return parsed.credentials
      } catch (err) {
        claudeLog("token_refresh.keychain_read_failed", { service: serviceName, error: String(err) })
        return null
      }
    },

    async write(credentials) {
      const json = JSON.stringify(credentials, null, 2)
      const wasHex = keychainWasHexByService.get(serviceName) ?? false
      // Write back in the same encoding Claude Code expects — hex after `claude login`.
      const value = wasHex ? Buffer.from(json).toString("hex") : json
      try {
        await execFile(
          "/usr/bin/security",
          ["add-generic-password", "-U", "-s", serviceName, "-a", userInfo().username, "-w", value],
          { timeout: 5000 }
        )
        return true
      } catch (err) {
        claudeLog("token_refresh.keychain_write_failed", { service: serviceName, error: String(err) })
        return false
      }
    },
  }
}

const macosStore: CredentialStore = buildMacosStore(KEYCHAIN_SERVICE)

// ---------------------------------------------------------------------------
// Linux / file backend
// ---------------------------------------------------------------------------

function buildFileStore(filePath: string): CredentialStore {
  return {
    async read() {
      try {
        if (!existsSync(filePath)) return null
        return JSON.parse(readFileSync(filePath, "utf-8")) as CredentialsFile
      } catch (err) {
        claudeLog("token_refresh.file_read_failed", { path: filePath, error: String(err) })
        return null
      }
    },

    async write(credentials) {
      try {
        // Ensure parent dir exists for non-default paths.
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, JSON.stringify(credentials, null, 2), "utf-8")
        return true
      } catch (err) {
        claudeLog("token_refresh.file_write_failed", { path: filePath, error: String(err) })
        return false
      }
    },
  }
}


const fileStore: CredentialStore = buildFileStore(CREDENTIALS_FILE)

/**
 * Returns the appropriate credential store for the current platform.
 *
 * If `claudeConfigDir` is provided, returns a profile-specific store that
 * reads from the matching keychain entry (macOS) or `<dir>/.credentials.json`
 * (Linux). Default behaviour (no opts) is unchanged — reads from the
 * standard `~/.claude` location.
 */
export function createPlatformCredentialStore(opts?: { claudeConfigDir?: string }): CredentialStore {
  if (opts?.claudeConfigDir) {
    if (platform() === "darwin") {
      return buildMacosStore(configDirToKeychainService(opts.claudeConfigDir))
    }
    return buildFileStore(configDirToCredentialsFile(opts.claudeConfigDir))
  }
  return platform() === "darwin" ? macosStore : fileStore
}

/** Look up the appropriate file path for a profile (Linux convention even on macOS for inspection). */
export function credentialsFilePathForProfile(claudeConfigDir?: string): string {
  return claudeConfigDir ? configDirToCredentialsFile(claudeConfigDir) : CREDENTIALS_FILE
}

// ---------------------------------------------------------------------------
// OAuth refresh
// ---------------------------------------------------------------------------

/** In-flight refresh promise — deduplicates concurrent callers. */
let inflightRefresh: Promise<boolean> | null = null

/**
 * Refresh the Claude Code OAuth access token.
 *
 * Reads the stored refresh token, exchanges it for a new access token via
 * Anthropic's OAuth endpoint, and writes the updated credentials back.
 *
 * Returns true on success, false on any failure. Concurrent calls share one
 * in-flight request so only one network round-trip is made.
 *
 * @param store  Override the credential store (for testing).
 */
export async function refreshOAuthToken(store?: CredentialStore): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh

  inflightRefresh = doRefresh(store ?? createPlatformCredentialStore()).finally(() => {
    inflightRefresh = null
  })

  return inflightRefresh
}

async function doRefresh(store: CredentialStore): Promise<boolean> {
  const credentials = await store.read()
  if (!credentials) {
    claudeLog("token_refresh.no_credentials", {})
    return false
  }

  const { refreshToken } = credentials.claudeAiOauth
  if (!refreshToken) {
    claudeLog("token_refresh.no_refresh_token", {})
    return false
  }

  let response: Response
  try {
    response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    claudeLog("token_refresh.request_failed", { error: String(err) })
    return false
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    claudeLog("token_refresh.bad_response", { status: response.status, body })
    return false
  }

  let tokenData: { access_token: string; refresh_token?: string; expires_in?: number; expires_at?: number }
  try {
    tokenData = await response.json() as typeof tokenData
  } catch (err) {
    claudeLog("token_refresh.parse_failed", { error: String(err) })
    return false
  }

  const now = Date.now()
  const expiresAt =
    tokenData.expires_at ??
    (tokenData.expires_in ? now + tokenData.expires_in * 1000 : now + 8 * 60 * 60 * 1000)

  credentials.claudeAiOauth = {
    ...credentials.claudeAiOauth,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token ?? refreshToken,
    expiresAt,
  }

  const written = await store.write(credentials)
  if (!written) return false

  claudeLog("token_refresh.success", { expiresAt })
  return true
}

/** Reset in-flight state — for testing only. */
export function resetInflightRefresh(): void {
  inflightRefresh = null
}
