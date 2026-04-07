/**
 * Error classification for SDK errors.
 * Maps raw error messages to structured HTTP error responses.
 */

export interface ClassifiedError {
  status: number;
  type: string;
  message: string;
}

/**
 * Detect specific SDK errors and return helpful messages to the client.
 */
export function classifyError(errMsg: string): ClassifiedError {
  const lower = errMsg.toLowerCase();

  // Expired OAuth token (more specific than the generic auth check below)
  if (
    lower.includes("oauth token has expired") ||
    lower.includes("not logged in")
  ) {
    return {
      status: 401,
      type: "authentication_error",
      message:
        "Claude OAuth token has expired and could not be refreshed automatically. Run 'claude login' in your terminal to re-authenticate.",
    };
  }

  // Authentication failures
  if (
    lower.includes("401") ||
    lower.includes("authentication") ||
    lower.includes("invalid auth") ||
    lower.includes("credentials")
  ) {
    return {
      status: 401,
      type: "authentication_error",
      message:
        "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy.",
    };
  }

  // Rate limiting
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    const hint =
      lower.includes("1m") || lower.includes("context")
        ? " If you're frequently hitting this, set MERIDIAN_SONNET_MODEL=sonnet to use the 200k model instead."
        : "";
    return {
      status: 429,
      type: "rate_limit_error",
      message: `Claude Max rate limit reached. Wait a moment and try again.${hint}`,
    };
  }

  // Billing / subscription
  if (
    lower.includes("402") ||
    lower.includes("billing") ||
    lower.includes("subscription") ||
    lower.includes("payment")
  ) {
    return {
      status: 402,
      type: "billing_error",
      message:
        "Claude Max subscription issue. Check your subscription status at https://claude.ai/settings/subscription",
    };
  }

  // SDK process crash
  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/);
    const code = codeMatch ? codeMatch[1] : "unknown";

    // If stderr was captured it will be appended to the message — use it for classification
    const hasStderr = lower.includes("subprocess stderr:");
    const stderrContent = hasStderr
      ? (lower.split("subprocess stderr:")[1]?.trim() ?? "")
      : "";

    // Explicit auth signal in stderr takes priority
    if (
      stderrContent.includes("authentication") ||
      stderrContent.includes("401") ||
      stderrContent.includes("oauth")
    ) {
      return {
        status: 401,
        type: "authentication_error",
        message:
          "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy.",
      };
    }

    // Code 1 + no stderr: could be auth, but could also be a bad flag combination
    // or an environment issue. Give a less confident message and include stderr if present.
    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      const stderrHint = stderrContent
        ? ` Subprocess output: ${stderrContent.slice(0, 200)}`
        : " Run with CLAUDE_PROXY_DEBUG=1 for more detail.";
      return {
        status: 401,
        type: "authentication_error",
        message: `Claude Code process exited (code 1). This is often an authentication issue — try 'claude login' and restart the proxy.${stderrHint}`,
      };
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`,
    };
  }

  // Timeout
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message:
        "Request timed out. The operation may have been too complex. Try a simpler request.",
    };
  }

  // Server errors from Anthropic
  if (
    lower.includes("500") ||
    lower.includes("server error") ||
    lower.includes("internal error")
  ) {
    return {
      status: 502,
      type: "api_error",
      message:
        "Claude API returned a server error. This is usually temporary — try again in a moment.",
    };
  }

  // Overloaded
  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds.",
    };
  }

  // Default
  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error",
  };
}

/**
 * Detect errors caused by an expired or missing OAuth access token.
 * Triggers an inline token refresh + retry in server.ts.
 *
 * Two distinct messages from the Claude Code CLI:
 *   - "OAuth token has expired" — CLI sent the token, Anthropic API rejected it
 *   - "Not logged in"           — CLI checked expiresAt locally and refused to try
 * Both are resolved by refreshing the token.
 */
export function isExpiredTokenError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("oauth token has expired") || lower.includes("not logged in")
  );
}

/**
 * Detect errors caused by stale session/message UUIDs.
 * These happen when the upstream Claude session no longer contains
 * the referenced message (expired, compacted server-side, etc.).
 */
export function isStaleSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("No message found with message.uuid");
}

/**
 * Quick check whether an error message indicates a rate limit.
 * Used by server.ts to decide whether to retry with a smaller context window.
 */
export function isRateLimitError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  );
}

/**
 * Detect errors caused by the 1M context window requiring Extra Usage.
 * Max subscribers without Extra Usage enabled, OR with Extra Usage credits
 * depleted, get this error when using sonnet[1m] or opus[1m]. The fix is
 * to fall back to the base model.
 *
 * Two distinct error message variants from Anthropic:
 *   1. "Extra usage is required for 1M context"        — when Extra Usage is disabled
 *   2. "You're out of extra usage. Add more at..."     — when Extra Usage credits are depleted
 *
 * Both indicate the same recovery: strip [1m] and use the base model.
 * The check is intentionally permissive — the call site already gates with
 * hasExtendedContext(model), so false positives only fire when actually
 * using a [1m] variant.
 *
 * Related: anthropics/claude-code#39841 (Anthropic gates Opus 1M behind
 * Extra Usage despite docs saying it's included with Max subscriptions).
 */
export function isExtraUsageRequiredError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  // Match either "extra usage" variant. The strict "&& 1m" check from the
  // original implementation missed Anthropic's "out of extra usage" message
  // because it doesn't mention the 1m suffix at all.
  return lower.includes("extra usage") || lower.includes("out of extra");
}
