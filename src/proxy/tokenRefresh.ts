/**
 * Manual OAuth token refresh for Claude Code credentials.
 * Refreshes the access token using the refresh token from ~/.claude/.credentials.json.
 * Returns true on success, false on any error (credentials read, network, parse, write).
 */

import { readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { claudeLog } from "../logger"

const CREDENTIALS_FILE = `${homedir()}/.claude/.credentials.json`
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

export async function refreshOAuthToken(): Promise<boolean> {
  let credentials: CredentialsFile
  try {
    credentials = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8"))
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
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), "utf-8")
  } catch (err) {
    claudeLog("token_refresh.credentials_write_failed", { error: String(err) })
    return false
  }

  claudeLog("token_refresh.success", { expiresAt })
  return true
}
