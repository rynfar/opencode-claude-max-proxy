/**
 * Multi-profile support.
 *
 * Allows a single Meridian instance to route requests to different Claude
 * accounts. Each profile is a named auth context (a CLAUDE_CONFIG_DIR for
 * Max subscriptions, or an API key for direct API access).
 *
 * Profile selection priority:
 *   1. x-meridian-profile request header (per-request override)
 *   2. Active profile (set via POST /profiles/active or UI)
 *   3. First configured profile (or implicit "default" if none configured)
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { setSetting, getSetting } from "./settings"

const CONFIG_FILE = join(homedir(), ".config", "meridian", "profiles.json")

/** Disk profile cache with short TTL so new profiles are picked up quickly */
const DISK_CACHE_TTL_MS = 5_000
let diskProfilesCache: ProfileConfig[] = []
let diskProfilesCacheAt = 0

/**
 * Load profiles from ~/.config/meridian/profiles.json.
 * Cached with a 5s TTL so new profiles are picked up without restart,
 * while avoiding synchronous disk I/O on every request.
 */
export function loadProfilesFromDisk(): ProfileConfig[] {
  if (diskProfilesCacheAt > 0 && Date.now() - diskProfilesCacheAt < DISK_CACHE_TTL_MS) {
    return diskProfilesCache
  }
  try {
    if (!existsSync(CONFIG_FILE)) {
      diskProfilesCache = []
    } else {
      diskProfilesCache = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    }
    diskProfilesCacheAt = Date.now()
    return diskProfilesCache
  } catch (err) {
    console.warn(`[meridian] Failed to read ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`)
    diskProfilesCacheAt = Date.now()
    diskProfilesCache = []
    return []
  }
}

export type ProfileType = "claude-max" | "api"

export interface ProfileConfig {
  /** Unique profile identifier (e.g. "personal", "work") */
  id: string
  /** Auth type — "claude-max" uses CLAUDE_CONFIG_DIR, "api" uses ANTHROPIC_API_KEY */
  type?: ProfileType
  /** Path to .claude config directory (claude-max profiles) */
  claudeConfigDir?: string
  /** Anthropic API key (api profiles) */
  apiKey?: string
  /** Anthropic base URL override (api profiles) */
  baseUrl?: string
}

export interface ResolvedProfile {
  id: string
  type: ProfileType
  /** Env vars to overlay on the SDK subprocess environment */
  env: Record<string, string>
}

const DEFAULT_PROFILE_ID = "default"

/** Mutable active profile — changed via POST /profiles/active or UI */
let activeProfileId: string | undefined

/**
 * Set the active profile. All requests without an explicit x-meridian-profile
 * header will use this profile. Persisted to ~/.config/meridian/settings.json.
 */
export function setActiveProfile(profileId: string): void {
  activeProfileId = profileId
  setSetting("activeProfile", profileId)
}

/**
 * Get the current active profile ID.
 */
export function getActiveProfileId(): string | undefined {
  return activeProfileId
}

/** Reset active profile — for testing only. */
export function resetActiveProfile(): void {
  activeProfileId = undefined
}

/**
 * Load persisted active profile from settings. Called once at startup
 * to restore the user's last selection. Only restores when disk
 * discovery is enabled (i.e. real CLI startup, not tests).
 * Validates the saved profile actually exists before restoring.
 */
export function restoreActiveProfile(configProfiles?: ProfileConfig[]): void {
  if (activeProfileId) return // already set (e.g. by env var)
  if (!diskDiscoveryEnabled) return // tests / programmatic usage — don't read disk
  const saved = getSetting("activeProfile")
  if (!saved) return
  // Validate the saved profile exists in the effective profile list
  const effective = getEffectiveProfiles(configProfiles)
  if (effective.length === 0 || effective.some(p => p.id === saved)) {
    activeProfileId = saved
  } else {
    console.warn(`[meridian] Saved active profile "${saved}" not found. Using default.`)
  }
}

/**
 * Get the effective profile list: config-provided profiles merged with
 * disk-loaded profiles. Disk profiles are re-read on each call so new
 * profiles added via `meridian profile add` are picked up without restart.
 */
/** Whether disk auto-discovery is enabled (set by CLI at startup) */
let diskDiscoveryEnabled = false

/** Enable disk auto-discovery of profiles. Called by the CLI when
 *  no MERIDIAN_PROFILES env var is set, so the server picks up
 *  profiles from ~/.config/meridian/profiles.json dynamically. */
export function enableDiskProfileDiscovery(): void {
  diskDiscoveryEnabled = true
}

export function getEffectiveProfiles(configProfiles: ProfileConfig[] | undefined): ProfileConfig[] {
  const fromConfig = configProfiles ?? []
  if (!diskDiscoveryEnabled) return fromConfig
  const fromDisk = loadProfilesFromDisk()
  // Config (env var) takes precedence; disk fills in anything not already defined
  const configIds = new Set(fromConfig.map(p => p.id))
  return [...fromConfig, ...fromDisk.filter(p => !configIds.has(p.id))]
}

/** Check if any profiles are available from any source */
export function hasProfiles(configProfiles: ProfileConfig[] | undefined): boolean {
  return getEffectiveProfiles(configProfiles).length > 0
}

/**
 * Resolve a profile from the configuration.
 *
 * @param profiles - Configured profiles (from ProxyConfig)
 * @param defaultProfile - Default profile ID (from ProxyConfig)
 * @param requestedId - Explicit profile ID from request header
 */
export function resolveProfile(
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string
): ResolvedProfile {
  const effective = getEffectiveProfiles(profiles)

  // No profiles configured — return empty env (standard single-account mode)
  if (effective.length === 0) {
    return { id: DEFAULT_PROFILE_ID, type: "claude-max", env: {} }
  }

  // Priority: header > active > config default > first profile
  const resolvedId = requestedId || activeProfileId || defaultProfile || effective[0]!.id
  const profile = effective.find(p => p.id === resolvedId)

  if (!profile) {
    console.warn(`[meridian] Unknown profile "${resolvedId}". Using first configured profile.`)
    return buildResolvedProfile(effective[0]!)
  }

  return buildResolvedProfile(profile)
}

/**
 * Build env overrides for a profile config.
 */
function buildResolvedProfile(profile: ProfileConfig): ResolvedProfile {
  const type = profile.type ?? "claude-max"

  if (type === "api") {
    const env: Record<string, string> = {}
    if (profile.apiKey) env.ANTHROPIC_API_KEY = profile.apiKey
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl
    return { id: profile.id, type, env }
  }

  // claude-max: override config directory
  const env: Record<string, string> = {}
  if (profile.claudeConfigDir) env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir
  return { id: profile.id, type, env }
}

/**
 * Get all configured profile IDs with their types.
 */
export function listProfiles(
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined
): Array<{ id: string; type: ProfileType; isActive: boolean }> {
  const effective = getEffectiveProfiles(profiles)
  if (effective.length === 0) return []

  const currentActive = activeProfileId || defaultProfile || effective[0]!.id
  return effective.map(p => ({
    id: p.id,
    type: p.type ?? "claude-max",
    isActive: p.id === currentActive,
  }))
}
