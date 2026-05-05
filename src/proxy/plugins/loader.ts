import { readdirSync, readFileSync, existsSync } from "fs"
import { join, isAbsolute, extname } from "path"
import { pathToFileURL } from "url"
import type { Transform } from "../transform"
import type { PluginEntry, PluginConfig, LoadedPlugin } from "./types"
import { validateTransform } from "./validation"
import { registerPluginStats, resetAllPluginStats } from "./stats"

// Monotonic counter appended to the import cache-buster. Date.now() alone
// collides when multiple reloads happen within the same millisecond (tests,
// rapid hot iteration), causing Node/Bun to serve the cached module.
let loadCounter = 0

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
  // Wipe stats before loading so plugins removed from the config don't leave
  // stale counters behind and reloaded plugins start fresh.
  resetAllPluginStats()

  const config = configPath ? parsePluginConfig(configPath) : []

  // Plugins can come from two places:
  //   1. Auto-discovery in pluginDir (if the directory exists)
  //   2. Absolute paths referenced in plugins.json
  // Either source is sufficient on its own — don't bail just because
  // pluginDir is missing when the user has absolute paths configured.
  const pluginDirExists = existsSync(pluginDir)
  let filenames: string[] = []
  if (pluginDirExists) {
    try {
      filenames = readdirSync(pluginDir).filter(f => {
        const ext = extname(f)
        return ext === ".ts" || ext === ".js"
      })
    } catch {
      filenames = []
    }
  }

  if (!pluginDirExists && config.length === 0) return []

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
      // Bust the module cache so POST /plugins/reload picks up file edits.
      // Without the query string, Node/Bun serve the first-loaded version
      // forever and authors can't iterate without restarting meridian.
      // Include a counter in addition to Date.now() — when reload fires
      // many times within the same millisecond (tests, hot iteration) the
      // timestamp alone collides and we serve the cached build.
      const cacheBuster = `?t=${Date.now()}-${++loadCounter}`
      const mod = await import(pathToFileURL(filePath).href + cacheBuster)
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
        registerPluginStats(transform.name)
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
