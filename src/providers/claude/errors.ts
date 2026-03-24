/**
 * Claude-specific error classification.
 *
 * Detects specific error patterns from the Claude SDK and returns
 * user-friendly messages with appropriate HTTP status codes.
 */

import type { ClassifiedError } from "../errors";

export type { ClassifiedError } from "../errors";
export { isClosedControllerError } from "../errors";

/**
 * Check if an error is a stale session UUID error (undo target not found).
 * Used to trigger retry without resumeSessionAt.
 */
export function isSessionUuidError(error: unknown): boolean {
  const msg =
    error instanceof Error ? error.message : String(error ?? "");
  return msg.toLowerCase().includes("no message found with message.uuid");
}

export function classifyError(errMsg: string): ClassifiedError {
  const lower = errMsg.toLowerCase();

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

  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return {
      status: 429,
      type: "rate_limit_error",
      message: "Claude Max rate limit reached. Wait a moment and try again.",
    };
  }

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

  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/);
    const code = codeMatch ? codeMatch[1] : "unknown";

    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      return {
        status: 401,
        type: "authentication_error",
        message:
          "Claude Code process crashed (exit code 1). This usually means authentication expired. Run 'claude login' in your terminal to re-authenticate, then restart the proxy.",
      };
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`,
    };
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message:
        "Request timed out. The operation may have been too complex. Try a simpler request.",
    };
  }

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

  if (lower.includes("no message found with message.uuid")) {
    return {
      status: 409,
      type: "session_uuid_error",
      message:
        "Session undo target not found — the SDK session may have been compacted or expired. The proxy will retry with a fresh session.",
    };
  }

  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds.",
    };
  }

  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error",
  };
}
