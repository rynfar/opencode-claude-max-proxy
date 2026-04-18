const KNOWN_ADAPTERS = ["opencode", "crush", "droid", "pi", "forgecode", "passthrough"]
const KNOWN_HOOKS = ["onRequest", "onResponse", "onTelemetry", "onSession", "onToolUse", "onToolResult", "onError"]

export interface ValidationResult {
  valid: boolean
  hooks: string[]
  error?: string
  warnings?: string[]
}

export function validateTransform(exported: unknown): ValidationResult {
  if (exported == null || typeof exported !== "object") {
    return { valid: false, hooks: [], error: "Plugin must export an object" }
  }

  const obj = exported as Record<string, unknown>

  if (typeof obj.name !== "string" || obj.name.length === 0) {
    return { valid: false, hooks: [], error: "Plugin must have a name: string property" }
  }

  const hooks: string[] = []
  for (const hook of KNOWN_HOOKS) {
    if (obj[hook] !== undefined) {
      if (typeof obj[hook] !== "function") {
        return { valid: false, hooks: [], error: `${hook} must be a function, got ${typeof obj[hook]}` }
      }
      hooks.push(hook)
    }
  }

  const warnings: string[] = []
  if (Array.isArray(obj.adapters)) {
    for (const adapter of obj.adapters) {
      if (typeof adapter === "string" && !KNOWN_ADAPTERS.includes(adapter)) {
        warnings.push(adapter)
      }
    }
  }

  return {
    valid: true,
    hooks,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
