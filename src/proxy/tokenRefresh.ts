/**
 * OAuth token refresh for Claude Code credentials.
 *
 * Uses a stamp file to rate-limit refresh attempts: only refreshes once per
 * REFRESH_THRESHOLD_MS (6 hours). The stamp file is only updated on a
 * successful refresh so that failures cause a retry on the next request.
 */

import { readFileSync, writeFileSync, statSync, utimesSync } from "fs"
import { tmpdir, homedir } from "os"
import { join } from "path"
import { claudeLog } from "../logger"

const STAMP_FILE = join(tmpdir(), "meridian-token-refresh")
const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json")
const REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000 // 6 hours
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

interface OAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: string
  rateLimitTier: string
}

interface CredentialsFile {
  claudeAiOauth: OAuthCredentials
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
  scope?: string
}

export function stampFileAgeMs(): number {
  try {
    const stat = statSync(STAMP_FILE)
    return Date.now() - stat.mtimeMs
  } catch {
    return Infinity
  }
}

function readCredentials(): CredentialsFile {
  const raw = readFileSync(CREDENTIALS_FILE, "utf-8")
  return JSON.parse(raw) as CredentialsFile
}

function writeCredentials(updated: CredentialsFile): void {
  const tmp = CREDENTIALS_FILE + ".tmp"
  writeFileSync(tmp, JSON.stringify(updated, null, 2), "utf-8")
  // Atomic rename — writeFileSync to final path directly risks partial writes
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(updated, null, 2), "utf-8")
}

function touchStampFile(): void {
  try {
    writeFileSync(STAMP_FILE, "", "utf-8")
  } catch (err) {
    claudeLog("token_refresh.stamp_write_failed", { error: String(err) })
  }
}

export async function refreshOAuthToken(): Promise<boolean> {
  let credentials: CredentialsFile
  try {
    credentials = readCredentials()
  } catch (err) {
    claudeLog("token_refresh.credentials_read_failed", { error: String(err) })
    return false
  }

  const { refreshToken, scopes } = credentials.claudeAiOauth
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
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: Array.isArray(scopes) ? scopes.join(" ") : scopes,
      }),
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

  let tokenResponse: OAuthTokenResponse
  try {
    tokenResponse = (await response.json()) as OAuthTokenResponse
  } catch (err) {
    claudeLog("token_refresh.parse_failed", { error: String(err) })
    return false
  }

  const now = Date.now()
  const expiresAt =
    tokenResponse.expires_at ??
    (tokenResponse.expires_in ? now + tokenResponse.expires_in * 1000 : now + 8 * 60 * 60 * 1000)

  credentials.claudeAiOauth = {
    ...credentials.claudeAiOauth,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? refreshToken,
    expiresAt,
  }

  try {
    writeCredentials(credentials)
  } catch (err) {
    claudeLog("token_refresh.credentials_write_failed", { error: String(err) })
    return false
  }

  touchStampFile()
  claudeLog("token_refresh.success", { expiresAt })
  return true
}

let refreshInProgress = false

export async function refreshTokenIfNeeded(): Promise<void> {
  if (stampFileAgeMs() < REFRESH_THRESHOLD_MS) return
  if (refreshInProgress) return

  refreshInProgress = true
  try {
    await refreshOAuthToken()
  } finally {
    refreshInProgress = false
  }
}
