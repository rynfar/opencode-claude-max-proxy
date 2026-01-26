const shouldLog = () =>
  process.env["OPENCODE_CLAUDE_PROVIDER_DEBUG"] || process.env["CLAUDE_PROXY_DEBUG"]

export const claudeLog = (message: string, extra?: Record<string, unknown>) => {
  if (!shouldLog()) return
  const parts = ["[opencode-claude-code-provider]", message]
  if (extra && Object.keys(extra).length > 0) {
    parts.push(JSON.stringify(extra))
  }
  console.debug(parts.join(" "))
}
