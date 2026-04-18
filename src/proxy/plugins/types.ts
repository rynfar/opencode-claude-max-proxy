import type { Transform } from "../transform"

export interface PluginEntry {
  path: string
  enabled: boolean
}

export interface PluginConfig {
  plugins: PluginEntry[]
}

export type PluginStatus = "active" | "disabled" | "error"

export interface LoadedPlugin {
  name: string
  description?: string
  version?: string
  adapters?: string[]
  hooks: string[]
  status: PluginStatus
  error?: string
  path: string
  transform: Transform
}
