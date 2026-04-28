/**
 * Unit tests for classifyError — pure function, no mocks needed.
 */
import { describe, it, expect } from "bun:test"
import { classifyError, isStaleSessionError, isExtraUsageRequiredError, extractSdkTermination, formatSdkTermination } from "../proxy/errors"

describe("classifyError", () => {
  describe("authentication errors", () => {
    it("detects 401 status codes", () => {
      const result = classifyError("API Error: 401 authentication_error")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })

    it("detects 'authentication' keyword", () => {
      const result = classifyError("authentication failed")
      expect(result.status).toBe(401)
    })

    it("detects 'invalid auth' keyword", () => {
      const result = classifyError("invalid auth token")
      expect(result.status).toBe(401)
    })

    it("detects 'credentials' keyword", () => {
      const result = classifyError("bad credentials provided")
      expect(result.status).toBe(401)
    })

    it("detects process exit code 1 as auth error", () => {
      const result = classifyError("Claude Code process exited with code 1")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })

    it("does NOT classify exit code 1 as auth when 'tool' is mentioned", () => {
      const result = classifyError("Claude Code process exited with code 1 - tool error")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("does NOT classify exit code 1 as auth when 'mcp' is mentioned", () => {
      const result = classifyError("Claude Code process exited with code 1 - mcp server crashed")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("includes captured stderr in exit code 1 message", () => {
      const result = classifyError("Claude Code process exited with code 1\nSubprocess stderr: --permission-mode: invalid value 'bypassPermissions'")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
      expect(result.message).toContain("permission-mode")
    })

    it("classifies as auth error when stderr contains authentication keyword", () => {
      const result = classifyError("Claude Code process exited with code 1\nSubprocess stderr: OAuth token expired")
      expect(result.status).toBe(401)
      expect(result.type).toBe("authentication_error")
    })
  })

  describe("rate limiting", () => {
    it("detects 429 status codes", () => {
      const result = classifyError("429 Too Many Requests")
      expect(result.status).toBe(429)
      expect(result.type).toBe("rate_limit_error")
    })

    it("detects 'rate limit' keyword", () => {
      const result = classifyError("rate limit exceeded")
      expect(result.status).toBe(429)
    })

    it("detects 'too many requests' keyword", () => {
      const result = classifyError("too many requests")
      expect(result.status).toBe(429)
    })
  })

  describe("billing errors", () => {
    it("detects 402 status codes", () => {
      const result = classifyError("402 billing_error")
      expect(result.status).toBe(402)
      expect(result.type).toBe("billing_error")
    })

    it("detects 'subscription' keyword", () => {
      const result = classifyError("subscription expired")
      expect(result.status).toBe(402)
    })
  })

  describe("process crashes", () => {
    it("detects exit code with specific number", () => {
      const result = classifyError("exited with code 137")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
      expect(result.message).toContain("137")
    })

    it("detects 'process exited' keyword", () => {
      const result = classifyError("process exited unexpectedly")
      expect(result.status).toBe(502)
    })

    it("uses 'unknown' when exit code not parseable", () => {
      const result = classifyError("process exited somehow")
      expect(result.message).toContain("unknown")
    })
  })

  describe("timeout errors", () => {
    it("detects 'timeout' keyword", () => {
      const result = classifyError("Request timeout after 120s")
      expect(result.status).toBe(504)
      expect(result.type).toBe("timeout_error")
    })

    it("detects 'timed out' keyword", () => {
      const result = classifyError("connection timed out")
      expect(result.status).toBe(504)
    })
  })

  describe("server errors", () => {
    it("detects 500 status codes", () => {
      const result = classifyError("HTTP 500 from API")
      expect(result.status).toBe(502)
      expect(result.type).toBe("api_error")
    })

    it("detects 'server error' keyword", () => {
      const result = classifyError("internal server error")
      expect(result.status).toBe(502)
    })
  })

  describe("overloaded", () => {
    it("detects 503 status codes", () => {
      const result = classifyError("503 overloaded")
      expect(result.status).toBe(503)
      expect(result.type).toBe("overloaded_error")
    })

    it("detects 'overloaded' keyword", () => {
      const result = classifyError("service overloaded")
      expect(result.status).toBe(503)
    })
  })

  describe("stale session detection", () => {
    it("detects 'No message found with message.uuid' errors", () => {
      expect(isStaleSessionError(new Error("No message found with message.uuid of: e663b687-6d08-4cc4-b9a9-5245ce8f1e07"))).toBe(true)
    })

    it("detects the error embedded in longer messages", () => {
      expect(isStaleSessionError(new Error("claude code returned an error result: No message found with message.uuid of: abc123"))).toBe(true)
    })

    it("detects 'No conversation found with session ID' errors", () => {
      expect(isStaleSessionError(new Error("No conversation found with session ID: 2e9e868c-ab59-482c-ae28-3b60ec9cb95b"))).toBe(true)
    })

    it("detects 'No conversation found to continue' errors", () => {
      expect(isStaleSessionError(new Error("No conversation found to continue"))).toBe(true)
    })

    it("detects 'No conversations found to resume' errors", () => {
      expect(isStaleSessionError(new Error("No conversations found to resume"))).toBe(true)
      expect(isStaleSessionError(new Error("No conversations found to resume."))).toBe(true)
    })

    it("returns false for unrelated errors", () => {
      expect(isStaleSessionError(new Error("rate limit exceeded"))).toBe(false)
      expect(isStaleSessionError(new Error("authentication failed"))).toBe(false)
    })

    it("returns false for non-Error values", () => {
      expect(isStaleSessionError("No message found with message.uuid")).toBe(false)
      expect(isStaleSessionError(null)).toBe(false)
      expect(isStaleSessionError(undefined)).toBe(false)
    })
  })

  describe("extra usage required", () => {
    it("detects the exact error from Claude SDK", () => {
      expect(isExtraUsageRequiredError(
        "Claude Code returned an error result: API Error: Extra usage is required for 1M context · enable extra usage at claude.ai/settings/usage, or use --model to switch"
      )).toBe(true)
    })

    it("detects lowercase variant", () => {
      expect(isExtraUsageRequiredError("extra usage is required for 1m context")).toBe(true)
    })

    it("returns false for unrelated errors", () => {
      expect(isExtraUsageRequiredError("rate limit exceeded")).toBe(false)
      expect(isExtraUsageRequiredError("authentication failed")).toBe(false)
    })

    it("returns false when only 'extra usage' but no '1m'", () => {
      expect(isExtraUsageRequiredError("extra usage enabled")).toBe(false)
    })

    it("returns false when only '1m' but no 'extra usage'", () => {
      expect(isExtraUsageRequiredError("using 1m context window")).toBe(false)
    })
  })

  describe("default/unknown", () => {
    it("returns 500 for unknown errors", () => {
      const result = classifyError("Something weird happened")
      expect(result.status).toBe(500)
      expect(result.type).toBe("api_error")
      expect(result.message).toBe("Something weird happened")
    })

    it("returns 'Unknown error' for empty string", () => {
      const result = classifyError("")
      expect(result.status).toBe(500)
      expect(result.message).toBe("Unknown error")
    })
  })
})

describe("extractSdkTermination", () => {
  describe("max_turns", () => {
    it("detects bare max_turns message", () => {
      const t = extractSdkTermination("Reached maximum number of turns (3)")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(3)
    })

    it("detects max_turns inside SDK wrapper", () => {
      const t = extractSdkTermination("Claude Code returned an error result: Reached maximum number of turns (3)")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(3)
    })

    it("captures any turn count, not just 3", () => {
      const t = extractSdkTermination("Reached maximum number of turns (12)")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(12)
    })

    it("returns max_turns reason even when turn count is malformed", () => {
      const t = extractSdkTermination("Reached maximum number of turns")
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBeUndefined()
    })

    it("captures subprocess stderr tail when present", () => {
      const msg =
        "Claude Code returned an error result: Reached maximum number of turns (3)\n" +
        "Subprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas."
      const t = extractSdkTermination(msg)
      expect(t.reason).toBe("max_turns")
      expect(t.turns).toBe(3)
      expect(t.stderrTail).toContain("Custom betas")
    })
  })

  describe("process_exit", () => {
    it("detects exit code", () => {
      const t = extractSdkTermination("Claude Code process exited with code 137")
      expect(t.reason).toBe("process_exit")
      expect(t.exitCode).toBe(137)
    })

    it("captures stderr tail with exit code", () => {
      const t = extractSdkTermination(
        "process exited with code 1\nSubprocess stderr: --permission-mode invalid value"
      )
      expect(t.reason).toBe("process_exit")
      expect(t.exitCode).toBe(1)
      expect(t.stderrTail).toContain("permission-mode")
    })

    it("returns exit reason without code when code missing", () => {
      const t = extractSdkTermination("process exited unexpectedly")
      expect(t.reason).toBe("process_exit")
      expect(t.exitCode).toBeUndefined()
    })
  })

  describe("aborted", () => {
    it("detects AbortError", () => {
      const t = extractSdkTermination("AbortError: The operation was aborted")
      expect(t.reason).toBe("aborted")
    })

    it("detects 'Aborted' message", () => {
      const t = extractSdkTermination("Aborted")
      expect(t.reason).toBe("aborted")
    })
  })

  describe("unknown", () => {
    it("returns 'unknown' for unrecognized messages", () => {
      const t = extractSdkTermination("Something weird happened")
      expect(t.reason).toBe("unknown")
      expect(t.turns).toBeUndefined()
      expect(t.exitCode).toBeUndefined()
    })

    it("handles empty string safely", () => {
      const t = extractSdkTermination("")
      expect(t.reason).toBe("unknown")
      expect(t.rawTail).toBeUndefined()
    })

    it("captures raw error head when reason=unknown so the cause is debuggable", () => {
      const t = extractSdkTermination("Some weird upstream failure: wibble")
      expect(t.reason).toBe("unknown")
      expect(t.rawTail).toBe("Some weird upstream failure: wibble")
    })

    it("strips the stderr appendix from rawTail (already in stderrTail)", () => {
      const msg =
        "Some weird upstream failure: wibble\n" +
        "Subprocess stderr: Warning: Custom betas..."
      const t = extractSdkTermination(msg)
      expect(t.reason).toBe("unknown")
      expect(t.rawTail).toBe("Some weird upstream failure: wibble")
      expect(t.stderrTail).toContain("Custom betas")
    })

    it("truncates very long rawTail to a sensible bound", () => {
      const longLine = "x".repeat(5000)
      const t = extractSdkTermination(longLine)
      expect(t.reason).toBe("unknown")
      expect((t.rawTail ?? "").length).toBeLessThanOrEqual(300)
    })

    it("does NOT set rawTail when reason is recognized", () => {
      const t = extractSdkTermination("Reached maximum number of turns (3)")
      expect(t.reason).toBe("max_turns")
      expect(t.rawTail).toBeUndefined()
    })
  })

  describe("stderr tail truncation", () => {
    it("truncates very long stderr to a sensible bound", () => {
      const longLine = "x".repeat(10_000)
      const t = extractSdkTermination(`Reached maximum number of turns (3)\nSubprocess stderr: ${longLine}`)
      expect(t.reason).toBe("max_turns")
      expect(t.stderrTail).toBeDefined()
      expect((t.stderrTail ?? "").length).toBeLessThanOrEqual(500)
    })
  })
})

describe("formatSdkTermination", () => {
  it("formats max_turns with full context", () => {
    const line = formatSdkTermination(
      { reason: "max_turns", turns: 3, stderrTail: "Warning: Custom betas..." },
      { model: "opus[1m]", requestSource: "main", isResume: true, hasDeferredTools: false, sdkSessionId: "5fa9ec00-633c-4f00-b1c2-9e1b3c175ca4" },
    )
    expect(line).toContain("sdk_termination")
    expect(line).toContain("reason=max_turns")
    expect(line).toContain("turns=3")
    expect(line).toContain("model=opus[1m]")
    expect(line).toContain("source=main")
    expect(line).toContain("resume=true")
    expect(line).toContain("deferred=false")
    expect(line).toContain("session=5fa9ec00")
    expect(line).toContain("Custom betas")
  })

  it("formats process_exit with exit code and no stderr", () => {
    const line = formatSdkTermination(
      { reason: "process_exit", exitCode: 137 },
      { model: "haiku", isResume: false, hasDeferredTools: false },
    )
    expect(line).toContain("reason=process_exit")
    expect(line).toContain("exit=137")
    expect(line).not.toContain("stderr=")
  })

  it("omits unset context fields", () => {
    const line = formatSdkTermination({ reason: "unknown" }, {})
    expect(line).toBe("sdk_termination reason=unknown")
  })

  it("includes raw=… when reason=unknown carries a rawTail", () => {
    const line = formatSdkTermination(
      { reason: "unknown", rawTail: "Some weird upstream failure" },
      { requestSource: "main" },
    )
    expect(line).toContain("reason=unknown")
    expect(line).toContain("source=main")
    expect(line).toContain('raw="Some weird upstream failure"')
  })
})
