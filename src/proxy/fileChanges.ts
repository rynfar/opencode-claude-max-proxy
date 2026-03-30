/**
 * File change tracking for both internal and passthrough modes.
 *
 * Internal mode: PostToolUse hooks capture MCP tool executions (write/edit).
 * Passthrough mode: Scans body.messages for client-side tool_use blocks.
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

/** A recorded file operation from an MCP tool execution. */
export interface FileChange {
  /** The operation type: "wrote" or "edited" */
  operation: "wrote" | "edited"
  /** The file path from the tool input */
  path: string
}

/**
 * Extract a FileChange from a PostToolUse hook input, if applicable.
 *
 * Only tracks write and edit operations — read/glob/grep are read-only.
 * Returns undefined for non-file-changing tools.
 *
 * @param toolName - The full MCP tool name (e.g. "mcp__opencode__write")
 * @param toolInput - The tool's input parameters
 * @param mcpPrefix - The MCP prefix to match (e.g. "mcp__opencode__")
 */
export function extractFileChange(
  toolName: string,
  toolInput: unknown,
  mcpPrefix: string
): FileChange | undefined {
  if (!toolName.startsWith(mcpPrefix)) return undefined

  const shortName = toolName.slice(mcpPrefix.length)
  const input = toolInput as Record<string, unknown> | null | undefined

  if (shortName === "write" && input?.path) {
    return { operation: "wrote", path: String(input.path) }
  }

  if (shortName === "edit" && input?.path) {
    return { operation: "edited", path: String(input.path) }
  }

  return undefined
}

/**
 * Create a PostToolUse hook matcher that captures file changes.
 *
 * The hook pushes FileChange entries into the provided array.
 * The caller (server.ts) reads this array after the SDK completes
 * to inject a summary into the response.
 *
 * @param changes - Mutable array to push changes into (shared with caller)
 * @param mcpPrefix - The MCP prefix for this adapter (e.g. "mcp__opencode__")
 */
export function createFileChangeHook(
  changes: FileChange[],
  mcpPrefix: string
) {
  return {
    matcher: "",  // Match ALL tools (filter inside the hook)
    hooks: [async (input: {
      tool_name: string
      tool_input: unknown
      tool_response: unknown
      tool_use_id: string
    }) => {
      // Check for MCP write/edit tools first
      const change = extractFileChange(input.tool_name, input.tool_input, mcpPrefix)
      if (change) {
        changes.push(change)
        return {}
      }
      // Check for bash commands with redirects (>, >>, tee, sed -i)
      if (input.tool_name === `${mcpPrefix}bash`) {
        const toolInput = input.tool_input as Record<string, unknown> | null | undefined
        if (toolInput?.command) {
          const bashChanges = extractFileChangesFromBash(String(toolInput.command))
          changes.push(...bashChanges)
        }
      }
      return {}
    }],
  }
}

/**
 * Extract file paths from a bash command string by detecting output redirects
 * and common file-mutating commands (sed -i, tee, cp, mv).
 *
 * This is a best-effort heuristic — it won't catch every possible way bash
 * can write files, but it handles the patterns coding agents use most often.
 *
 * @param command - The bash command string
 */
export function extractFileChangesFromBash(command: string): FileChange[] {
  const changes: FileChange[] = []
  const seen = new Set<string>()

  const addChange = (operation: FileChange["operation"], path: string) => {
    // Filter out /dev/null and common non-file targets
    if (path === "/dev/null" || path === "/dev/stderr" || path === "/dev/stdout") return
    // Filter empty or whitespace-only paths
    if (!path.trim()) return
    const key = `${operation}:${path}`
    if (!seen.has(key)) {
      seen.add(key)
      changes.push({ operation, path })
    }
  }

  // 1. Output redirects: > file or >> file (but not stderr 2> or 2>>)
  //    Match: optional space, then > or >>, then the target path
  //    Negative lookbehind for digits (to skip 2>, 1>, etc.)
  const redirectRegex = /(?<![0-9])>{1,2}\s*['"]?([^\s'";&|)]+)['"]?/g
  let match
  while ((match = redirectRegex.exec(command)) !== null) {
    addChange("wrote", match[1]!)
  }

  // 2. tee [-a] file
  const teeRegex = /\btee\s+(?:-[a-zA-Z]\s+)*['"]?([^\s'";&|)]+)['"]?/g
  while ((match = teeRegex.exec(command)) !== null) {
    addChange("wrote", match[1]!)
  }

  // 3. sed -i (in-place edit)
  const sedRegex = /\bsed\s+(?:-[a-zA-Z]*i[a-zA-Z]*|-i)\b.*?['"]?([^\s'";&|)]+)['"]?\s*$/gm
  while ((match = sedRegex.exec(command)) !== null) {
    addChange("edited", match[1]!)
  }

  return changes
}

/**
 * Extract file changes from conversation history (passthrough mode).
 *
 * In passthrough mode the SDK doesn't execute tools — the client does.
 * The conversation history in body.messages contains assistant tool_use
 * blocks from completed tool loops. We scan these to build the file
 * change list.
 *
 * Only scans tool_use blocks that have a corresponding tool_result
 * (i.e., the tool was actually executed, not just proposed).
 *
 * @param messages - The body.messages array from the request
 * @param extractFn - Adapter's extractFileChangesFromToolUse method
 */
export function extractFileChangesFromMessages(
  messages: Array<{ role: string; content: unknown }>,
  extractFn: (toolName: string, toolInput: unknown) => FileChange[]
): FileChange[] {
  const changes: FileChange[] = []
  // Collect tool_use IDs that have a corresponding tool_result
  const executedToolIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "user") continue
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const block of content) {
      if (block?.type === "tool_result" && block.tool_use_id) {
        executedToolIds.add(block.tool_use_id)
      }
    }
  }

  // Scan assistant tool_use blocks that were actually executed
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    const content = Array.isArray(msg.content) ? msg.content : []
    for (const block of content) {
      if (block?.type !== "tool_use") continue
      if (!executedToolIds.has(block.id)) continue
      const blockChanges = extractFn(block.name, block.input)
      changes.push(...blockChanges)
    }
  }
  return changes
}

/**
 * Format file changes into a human-readable summary string.
 *
 * Deduplicates by path+operation and returns a newline-separated list.
 * Returns undefined if no changes to report.
 *
 * @param changes - Array of recorded file changes
 */
export function formatFileChangeSummary(changes: FileChange[]): string | undefined {
  if (changes.length === 0) return undefined

  // Deduplicate: same path+operation only listed once
  const seen = new Set<string>()
  const unique: FileChange[] = []
  for (const c of changes) {
    const key = `${c.operation}:${c.path}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(c)
    }
  }

  const lines = unique.map((c) => `- ${c.operation} ${c.path}`)
  return `\n\nFiles changed:\n${lines.join("\n")}`
}
