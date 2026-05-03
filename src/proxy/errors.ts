/**
 * Error classification for SDK errors.
 * Maps raw error messages to structured HTTP error responses.
 */

export interface ClassifiedError {
  status: number
  type: string
  message: string
}

/**
 * Detect specific SDK errors and return helpful messages to the client.
 */
export function classifyError(errMsg: string): ClassifiedError {
  const lower = errMsg.toLowerCase()

  // Expired OAuth token (more specific than the generic auth check below)
  if (lower.includes("oauth token has expired") || lower.includes("not logged in")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude OAuth token has expired and could not be refreshed automatically. Run 'claude login' in your terminal to re-authenticate."
    }
  }

  // Authentication failures
  if (lower.includes("401") || lower.includes("authentication") || lower.includes("invalid auth") || lower.includes("credentials")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
    }
  }

  // Rate limiting
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    const hint = lower.includes("1m") || lower.includes("context")
      ? " If you're frequently hitting this, set MERIDIAN_SONNET_MODEL=sonnet to use the 200k model instead."
      : ""
    return {
      status: 429,
      type: "rate_limit_error",
      message: `Claude Max rate limit reached. Wait a moment and try again.${hint}`
    }
  }

  // Billing / subscription
  if (lower.includes("402") || lower.includes("billing") || lower.includes("subscription") || lower.includes("payment")) {
    return {
      status: 402,
      type: "billing_error",
      message: "Claude Max subscription issue. Check your subscription status at https://claude.ai/settings/subscription"
    }
  }

  // SDK process crash
  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/)
    const code = codeMatch ? codeMatch[1] : "unknown"

    // If stderr was captured it will be appended to the message — use it for classification
    const hasStderr = lower.includes("subprocess stderr:")
    const stderrContent = hasStderr ? lower.split("subprocess stderr:")[1]?.trim() ?? "" : ""

    // Explicit auth signal in stderr takes priority
    if (stderrContent.includes("authentication") || stderrContent.includes("401") || stderrContent.includes("oauth")) {
      return {
        status: 401,
        type: "authentication_error",
        message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
      }
    }

    // Code 1 + no stderr: could be auth, but could also be a bad flag combination
    // or an environment issue. Give a less confident message and include stderr if present.
    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      const stderrHint = stderrContent ? ` Subprocess output: ${stderrContent.slice(0, 200)}` : " Run with CLAUDE_PROXY_DEBUG=1 for more detail."
      return {
        status: 401,
        type: "authentication_error",
        message: `Claude Code process exited (code 1). This is often an authentication issue — try 'claude login' and restart the proxy.${stderrHint}`
      }
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`
    }
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message: "Request timed out. The operation may have been too complex. Try a simpler request."
    }
  }

  // Server errors from Anthropic
  if (lower.includes("500") || lower.includes("server error") || lower.includes("internal error")) {
    return {
      status: 502,
      type: "api_error",
      message: "Claude API returned a server error. This is usually temporary — try again in a moment."
    }
  }

  // Overloaded
  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds."
    }
  }

  // Default
  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error"
  }
}

/**
 * Detect errors caused by an expired or missing OAuth access token.
 * Triggers an inline token refresh + retry in server.ts.
 *
 * Patterns, in order of specificity:
 *   - "OAuth token has expired" / "Not logged in" — CLI-emitted (subprocess
 *     either got 401 with this wording from Anthropic or detected expiry
 *     locally before sending).
 *   - "invalid_token" / "token_expired" — RFC 6750 resource-server errors that
 *     can appear in the API response body.
 *   - "401" + ("authentication" | "unauthorized" | "invalid") — generic 401
 *     wrapping. Anthropic's API does not always echo the CLI-specific wording,
 *     so without this branch a stale access token returns a generic 401 to the
 *     proxy and refresh-and-retry never fires (caller sees the 401).
 *
 * False positives only cost one OAuth round-trip — the refresh is single-shot
 * per request (gated by `tokenRefreshed` in server.ts) and surfaces the
 * original error if it doesn't help.
 */
export function isExpiredTokenError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  if (lower.includes("oauth token has expired") || lower.includes("not logged in")) return true
  if (lower.includes("invalid_token") || lower.includes("token_expired")) return true
  if (lower.includes("401") && (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid"))) return true
  return false
}

/**
 * Detect errors caused by stale session/message UUIDs.
 * These happen when the upstream Claude session no longer contains
 * the referenced message or conversation (expired, evicted server-side, etc.).
 */
export function isStaleSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return msg.includes("No message found with message.uuid")
    || msg.includes("No conversation found with session ID")
    || msg.includes("No conversation found to continue")
    || msg.includes("No conversations found to resume")
}

/**
 * Quick check whether an error message indicates a rate limit.
 * Used by server.ts to decide whether to retry with a smaller context window.
 */
export function isRateLimitError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")
}

/**
 * Detect errors caused by the 1M context window requiring Extra Usage.
 * Max subscribers without Extra Usage enabled get this error when using
 * sonnet[1m] or opus[1m]. The fix is to fall back to the base model.
 */
export function isExtraUsageRequiredError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase()
  return lower.includes("extra usage") && lower.includes("1m")
}

/**
 * Structured SDK-termination metadata extracted from raw error text.
 * Used by diagnosticLog to surface why the SDK subprocess ended (max_turns,
 * exit, abort) plus the captured stderr tail — info that classifyError
 * collapses into a generic api_error.
 */
export interface SdkTermination {
  reason: "max_turns" | "process_exit" | "aborted" | "unknown"
  /** Turn count when reason=max_turns and parseable. */
  turns?: number
  /** Exit code when reason=process_exit and parseable. */
  exitCode?: number
  /** Captured "Subprocess stderr: …" tail (truncated). */
  stderrTail?: string
  /** Truncated raw error message — set only when reason="unknown" so the log
   *  line stays self-contained for unrecognized SDK errors (e.g. so we can
   *  add a new pattern next time). */
  rawTail?: string
}

const STDERR_TAIL_MAX = 500
const RAW_TAIL_MAX = 300

function extractStderrTail(errMsg: string): string | undefined {
  const marker = "Subprocess stderr:"
  const idx = errMsg.indexOf(marker)
  if (idx < 0) return undefined
  const tail = errMsg.slice(idx + marker.length).trim()
  if (!tail) return undefined
  return tail.length > STDERR_TAIL_MAX ? tail.slice(0, STDERR_TAIL_MAX) : tail
}

function makeRawTail(errMsg: string): string | undefined {
  // Strip the stderr appendix; we already log it separately as stderrTail.
  const marker = "Subprocess stderr:"
  const idx = errMsg.indexOf(marker)
  const head = (idx >= 0 ? errMsg.slice(0, idx) : errMsg).trim()
  if (!head) return undefined
  return head.length > RAW_TAIL_MAX ? head.slice(0, RAW_TAIL_MAX) : head
}

/**
 * Parse the raw error message thrown by the Claude Agent SDK into structured
 * termination metadata. Pure function — no I/O.
 *
 * Returns reason="unknown" when the message doesn't match any recognized
 * pattern; callers can still log it with whatever surrounding context they have.
 */
export function extractSdkTermination(errMsg: string): SdkTermination {
  const stderrTail = extractStderrTail(errMsg)

  // Look at both the wrapper text and the stderr tail when classifying
  // (the SDK sometimes emits the operative phrase only into stderr).
  const haystack = `${errMsg}\n${stderrTail ?? ""}`
  const lower = haystack.toLowerCase()

  if (lower.includes("reached maximum number of turns")) {
    const m = haystack.match(/Reached maximum number of turns \((\d+)\)/i)
    return {
      reason: "max_turns",
      ...(m ? { turns: Number(m[1]) } : {}),
      ...(stderrTail ? { stderrTail } : {}),
    }
  }

  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const m = haystack.match(/exited with code (\d+)/i)
    return {
      reason: "process_exit",
      ...(m ? { exitCode: Number(m[1]) } : {}),
      ...(stderrTail ? { stderrTail } : {}),
    }
  }

  if (lower.includes("aborterror") || /\baborted\b/.test(lower)) {
    return {
      reason: "aborted",
      ...(stderrTail ? { stderrTail } : {}),
    }
  }

  const rawTail = makeRawTail(errMsg)
  return {
    reason: "unknown",
    ...(stderrTail ? { stderrTail } : {}),
    ...(rawTail ? { rawTail } : {}),
  }
}

/**
 * Render an SdkTermination plus request context as a single greppable log line.
 * Matches the key=value style used by token-health diagnostic messages so all
 * /telemetry/logs entries are uniform.
 *
 * Session IDs are truncated to 8 chars to keep lines short — full IDs are
 * already on the parent telemetry record.
 */
export function formatSdkTermination(
  t: SdkTermination,
  ctx: {
    model?: string
    requestSource?: string
    isResume?: boolean
    hasDeferredTools?: boolean
    sdkSessionId?: string
  },
): string {
  const parts: string[] = [`reason=${t.reason}`]
  if (t.turns !== undefined) parts.push(`turns=${t.turns}`)
  if (t.exitCode !== undefined) parts.push(`exit=${t.exitCode}`)
  if (ctx.model) parts.push(`model=${ctx.model}`)
  if (ctx.requestSource) parts.push(`source=${ctx.requestSource}`)
  if (ctx.isResume !== undefined) parts.push(`resume=${ctx.isResume}`)
  if (ctx.hasDeferredTools !== undefined) parts.push(`deferred=${ctx.hasDeferredTools}`)
  if (ctx.sdkSessionId) parts.push(`session=${ctx.sdkSessionId.slice(0, 8)}`)
  if (t.rawTail) parts.push(`raw=${JSON.stringify(t.rawTail)}`)
  if (t.stderrTail) parts.push(`stderr=${JSON.stringify(t.stderrTail)}`)
  return `sdk_termination ${parts.join(" ")}`
}
