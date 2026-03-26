import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { ProfileConfig, ProxyConfig } from "./types"

function expandHome(filePath: string, homeDir: string): string {
  return filePath === "~" ? homeDir : filePath.startsWith("~/") ? join(homeDir, filePath.slice(2)) : filePath
}

function resolveEnvReference(value: string): string | undefined {
  const match = value.match(/^(?:\$env:|env:)(.+)$/)
  if (!match) return undefined
  return process.env[match[1]?.trim() ?? ""]
}

function resolveConfigString(value: string, homeDir: string): string | undefined {
  const envValue = resolveEnvReference(value)
  const resolved = envValue ?? value
  return expandHome(resolved, homeDir)
}

function normalizeProfile(profile: ProfileConfig, homeDir: string): ProfileConfig {
  return {
    ...profile,
    claudeConfigDir: profile.claudeConfigDir ? resolveConfigString(profile.claudeConfigDir, homeDir) : undefined,
    claudeExecutable: profile.claudeExecutable ? resolveConfigString(profile.claudeExecutable, homeDir) : undefined,
    apiKey: profile.apiKey ? resolveConfigString(profile.apiKey, homeDir) : undefined,
    apiKeyEnv: profile.apiKeyEnv,
    baseUrl: profile.baseUrl ? resolveConfigString(profile.baseUrl, homeDir) : undefined,
    authToken: profile.authToken ? resolveConfigString(profile.authToken, homeDir) : undefined,
    authTokenEnv: profile.authTokenEnv,
  }
}

function normalizeConfig(config: Partial<ProxyConfig>, homeDir: string): Partial<ProxyConfig> {
  return {
    ...config,
    requiredApiKeys: config.requiredApiKeys
      ?.map((key) => resolveConfigString(key, homeDir))
      .filter((key): key is string => Boolean(key)),
    profiles: config.profiles?.map((profile) => normalizeProfile(profile, homeDir)),
  }
}

function mergeConfigs(base: Partial<ProxyConfig>, override: Partial<ProxyConfig>): Partial<ProxyConfig> {
  return {
    ...base,
    ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== undefined)),
  }
}

function getDefaultConfigPaths(cwd: string, homeDir: string): string[] {
  return [
    join(homeDir, ".config", "meridian", "config.json"),
    join(cwd, "meridian.config.json"),
  ]
}

export interface ConfigLoaderOptions {
  cwd?: string
  homeDir?: string
  configPath?: string
}

export function loadProxyConfigFile(options: ConfigLoaderOptions = {}): Partial<ProxyConfig> {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const explicitConfigPath = options.configPath ?? process.env.CLAUDE_PROXY_CONFIG
  const configPaths = explicitConfigPath
    ? [expandHome(explicitConfigPath, homeDir)]
    : getDefaultConfigPaths(cwd, homeDir)

  if (explicitConfigPath) {
    const filePath = isAbsolute(configPaths[0]!) ? configPaths[0]! : join(cwd, configPaths[0]!)
    if (!existsSync(filePath)) {
      throw new Error(`Config file not found: ${filePath}`)
    }
  }

  return configPaths.reduce<Partial<ProxyConfig>>((merged, candidatePath) => {
    const filePath = isAbsolute(candidatePath) ? candidatePath : join(cwd, candidatePath)
    if (!existsSync(filePath)) return merged

    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ProxyConfig>
    const normalized = normalizeConfig(parsed, homeDir)
    return mergeConfigs(merged, normalized)
  }, {})
}
