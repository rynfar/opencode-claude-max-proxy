/**
 * SDK feature toggles — per-adapter configuration for Claude Code features.
 *
 * Persisted to ~/.config/meridian/sdk-features.json.
 * Read at request time (no restart needed to pick up changes).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface AdapterFeatures {
  /** Use the Claude Code system prompt preset (tool instructions, safety rules) */
  codeSystemPrompt: boolean
  /** Include the client agent's system prompt (e.g. OpenCode/Crush instructions) */
  clientSystemPrompt: boolean
  /** Redirect the client's system prompt into the first user message instead of the system field.
   *  Avoids system prompt change detection that can cause Claude to reject the request. */
  systemPromptAsUserMessage: boolean
  /** Load CLAUDE.md instruction files (off, project, full) */
  claudeMd: "off" | "project" | "full"
  /** Enable auto-memory (read + write across sessions) */
  memory: boolean
  /** Enable background memory consolidation */
  dreaming: boolean
  /** Default thinking mode (adaptive, enabled, disabled) */
  thinking: "adaptive" | "enabled" | "disabled"
  /** Forward thinking blocks to the client */
  thinkingPassthrough: boolean
  /** Share memory directory with Claude Code (~/.claude instead of SDK default) */
  sharedMemory: boolean
  /** Per-request cost cap in USD (0 = disabled) */
  maxBudgetUsd: number
  /** Fallback model when primary fails (empty = disabled) */
  fallbackModel: string
  /** Enable SDK debug logging to proxy stderr */
  sdkDebug: boolean
  /** Comma-separated extra directories Claude can access (beyond CWD) */
  additionalDirectories: string
}

export type FeatureConfig = Record<string, Partial<AdapterFeatures>>

const DEFAULT_FEATURES: AdapterFeatures = {
  codeSystemPrompt: false,
  clientSystemPrompt: true,
  systemPromptAsUserMessage: true,
  claudeMd: "off" as const,
  memory: false,
  dreaming: false,
  thinking: "disabled",
  thinkingPassthrough: false,
  sharedMemory: false,
  maxBudgetUsd: 0,
  fallbackModel: "",
  sdkDebug: false,
  additionalDirectories: "",
}

/** Adapters that ship with features pre-enabled (none by default — use settings UI) */
const ADAPTER_DEFAULTS: Record<string, Partial<AdapterFeatures>> = {}

function getConfigPath(): string {
  const dir = join(homedir(), ".config", "meridian")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, "sdk-features.json")
}

let cachedConfig: FeatureConfig | null = null
let lastReadTime = 0
const CACHE_TTL_MS = 5000

function readConfig(): FeatureConfig {
  const now = Date.now()
  if (cachedConfig && now - lastReadTime < CACHE_TTL_MS) return cachedConfig

  const path = getConfigPath()
  try {
    if (existsSync(path)) {
      cachedConfig = JSON.parse(readFileSync(path, "utf-8")) as FeatureConfig
    } else {
      cachedConfig = {}
    }
  } catch {
    cachedConfig = {}
  }
  lastReadTime = now
  return cachedConfig
}

function writeConfig(config: FeatureConfig): void {
  const path = getConfigPath()
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2))
    renameSync(tmp, path)
    cachedConfig = config
    lastReadTime = Date.now()
  } catch (e) {
    console.error("[sdk-features] write failed:", (e as Error).message)
  }
}

/**
 * Get resolved features for an adapter.
 * Priority: user config > adapter defaults > global defaults
 */
export function getFeaturesForAdapter(adapterName: string): AdapterFeatures {
  const config = readConfig()
  const userOverrides = config[adapterName] ?? {}
  const adapterDefaults = ADAPTER_DEFAULTS[adapterName] ?? {}

  return {
    ...DEFAULT_FEATURES,
    ...adapterDefaults,
    ...userOverrides,
  }
}

/**
 * Get the full config for all adapters (for the settings UI).
 */
export function getAllFeatureConfigs(): Record<string, AdapterFeatures> {
  const adapters = ["opencode", "crush", "forgecode", "pi", "droid", "passthrough"]
  const result: Record<string, AdapterFeatures> = {}
  for (const name of adapters) {
    result[name] = getFeaturesForAdapter(name)
  }
  return result
}

const VALID_CLAUDE_MD_VALUES = new Set(["off", "project", "full"])
const VALID_THINKING_VALUES = new Set(["adaptive", "enabled", "disabled"])

/**
 * Validate and sanitise a partial feature update.
 * Returns only recognised keys with correct types; throws on invalid input.
 */
export function validateFeatureUpdate(raw: unknown): Partial<AdapterFeatures> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("body must be a JSON object")
  }
  const input = raw as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_FEATURES)) continue
    const expected = typeof DEFAULT_FEATURES[key as keyof AdapterFeatures]
    if (key === "claudeMd") {
      if (typeof value !== "string" || !VALID_CLAUDE_MD_VALUES.has(value)) {
        throw new Error(`claudeMd must be one of: ${[...VALID_CLAUDE_MD_VALUES].join(", ")}`)
      }
      result[key] = value
    } else if (key === "thinking") {
      if (typeof value !== "string" || !VALID_THINKING_VALUES.has(value)) {
        throw new Error(`thinking must be one of: ${[...VALID_THINKING_VALUES].join(", ")}`)
      }
      result[key] = value
    } else if (expected === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
      result[key] = value
    } else if (expected === "number") {
      if (typeof value !== "number" || !isFinite(value)) throw new Error(`${key} must be a finite number`)
      result[key] = value
    } else if (expected === "string") {
      if (typeof value !== "string") throw new Error(`${key} must be a string`)
      result[key] = value
    }
  }
  return result as Partial<AdapterFeatures>
}

/**
 * Update features for a specific adapter.
 */
export function updateAdapterFeatures(adapterName: string, features: Partial<AdapterFeatures>): void {
  const config = readConfig()
  config[adapterName] = { ...(config[adapterName] ?? {}), ...features }
  writeConfig(config)
}

/**
 * Reset an adapter to its defaults (remove user overrides).
 */
export function resetAdapterFeatures(adapterName: string): void {
  const config = readConfig()
  delete config[adapterName]
  writeConfig(config)
}
