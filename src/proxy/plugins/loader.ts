import { readdirSync, readFileSync, existsSync } from "fs"
import { join, isAbsolute, extname } from "path"
import type { Transform } from "../transform"
import type { PluginEntry, PluginConfig, LoadedPlugin } from "./types"
import { validateTransform } from "./validation"

export function parsePluginConfig(configPath: string): PluginEntry[] {
  if (!existsSync(configPath)) return []
  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as PluginConfig
    return Array.isArray(parsed.plugins) ? parsed.plugins : []
  } catch {
    return []
  }
}

export async function loadPlugins(
  pluginDir: string,
  configPath?: string,
): Promise<LoadedPlugin[]> {
  if (!existsSync(pluginDir)) return []

  const config = configPath ? parsePluginConfig(configPath) : []

  // Discover plugin files
  let filenames: string[]
  try {
    filenames = readdirSync(pluginDir).filter(f => {
      const ext = extname(f)
      return ext === ".ts" || ext === ".js"
    })
  } catch {
    return []
  }

  // Order: plugins.json entries first (in order), then auto-discovered
  const ordered: Array<{ filename: string; entry?: PluginEntry }> = []
  const seen = new Set<string>()

  for (const entry of config) {
    const filename = isAbsolute(entry.path) ? entry.path : entry.path
    if (filenames.includes(filename) || isAbsolute(entry.path)) {
      ordered.push({ filename, entry })
      seen.add(filename)
    }
  }
  for (const filename of filenames) {
    if (!seen.has(filename)) {
      ordered.push({ filename })
    }
  }

  const loaded: LoadedPlugin[] = []
  const seenNames = new Set<string>()

  for (const { filename, entry } of ordered) {
    const filePath = isAbsolute(filename) ? filename : join(pluginDir, filename)

    if (entry && !entry.enabled) {
      loaded.push({
        name: filename,
        status: "disabled",
        hooks: [],
        path: filePath,
        transform: { name: filename },
      })
      continue
    }

    try {
      const mod = await import(filePath)
      const exported = mod.default ?? mod

      // Support single Transform or array of Transforms
      const transforms = Array.isArray(exported) ? exported : [exported]

      for (const item of transforms) {
        const validation = validateTransform(item)
        if (!validation.valid) {
          loaded.push({
            name: filename,
            status: "error",
            error: validation.error,
            hooks: [],
            path: filePath,
            transform: { name: filename },
          })
          continue
        }

        const transform = item as Transform

        if (seenNames.has(transform.name)) {
          loaded.push({
            name: transform.name,
            status: "error",
            error: `Skipped: duplicate plugin name "${transform.name}"`,
            hooks: validation.hooks,
            path: filePath,
            transform,
          })
          continue
        }

        seenNames.add(transform.name)
        loaded.push({
          name: transform.name,
          description: transform.description,
          version: transform.version,
          adapters: transform.adapters,
          hooks: validation.hooks,
          status: "active",
          path: filePath,
          transform,
        })
      }
    } catch (err) {
      loaded.push({
        name: filename,
        status: "error",
        error: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
        hooks: [],
        path: filePath,
        transform: { name: filename },
      })
    }
  }

  return loaded
}

export function getActiveTransforms(plugins: LoadedPlugin[]): Transform[] {
  return plugins
    .filter(p => p.status === "active")
    .map(p => p.transform)
}
