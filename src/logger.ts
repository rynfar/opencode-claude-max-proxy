import { AsyncLocalStorage } from "node:async_hooks"

type LogFields = Record<string, unknown>

const contextStore = new AsyncLocalStorage<LogFields>()

const shouldLog = () => process.env["OPENCODE_CLAUDE_PROVIDER_DEBUG"]
const shouldLogStreamDebug = () => process.env["OPENCODE_CLAUDE_PROVIDER_STREAM_DEBUG"]

const isVerboseStreamEvent = (event: string): boolean => {
  return event.startsWith("stream.") || event === "response.empty_stream"
}

const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "apiKey",
  "apikey",
  "prompt",
  "messages",
  "content"
])

const sanitize = (value: unknown): unknown => {
  if (value === null || value === undefined) return value

  if (typeof value === "string") {
    if (value.length > 512) {
      return `${value.slice(0, 512)}... [truncated=${value.length}]`
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(sanitize)
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k)) {
        if (typeof v === "string") {
          out[k] = `[redacted len=${v.length}]`
        } else if (Array.isArray(v)) {
          out[k] = `[redacted array len=${v.length}]`
        } else {
          out[k] = "[redacted]"
        }
      } else {
        out[k] = sanitize(v)
      }
    }
    return out
  }

  return value
}

export const withClaudeLogContext = <T>(context: LogFields, fn: () => T): T => {
  return contextStore.run(context, fn)
}

export const claudeLog = (event: string, extra?: LogFields) => {
  if (!shouldLog()) return
  if (isVerboseStreamEvent(event) && !shouldLogStreamDebug()) return

  const context = contextStore.getStore() || {}
  const payload = sanitize({ ts: new Date().toISOString(), event, ...context, ...(extra || {}) })

  console.debug(`[opencode-claude-code-provider] ${JSON.stringify(payload)}`)
}
