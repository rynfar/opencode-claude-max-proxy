/**
 * Tests for adapter auto-detection.
 *
 * The proxy selects an adapter based on request headers.
 * Droid is identified by its User-Agent prefix.
 * Everything else defaults to OpenCode.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { detectAdapter } from "../proxy/adapters/detect"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { droidAdapter } from "../proxy/adapters/droid"
import { crushAdapter } from "../proxy/adapters/crush"
import { piAdapter } from "../proxy/adapters/pi"
import { passthroughAdapter } from "../proxy/adapters/passthrough"
import { forgeCodeAdapter } from "../proxy/adapters/forgecode"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"

function makeContext(userAgent: string, extraHeaders?: Record<string, string>): any {
  const allHeaders: Record<string, string> = {}
  if (userAgent) allHeaders["user-agent"] = userAgent
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      allHeaders[k.toLowerCase()] = v
    }
  }
  return {
    req: {
      header: (name?: string) => {
        if (!name) return { ...allHeaders }
        return allHeaders[name.toLowerCase()]
      },
    },
  }
}

describe("detectAdapter — Droid detection", () => {
  it("returns droidAdapter for 'factory-cli/0.89.0'", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    expect(adapter).toBe(droidAdapter)
    expect(adapter.name).toBe("droid")
  })

  it("returns droidAdapter for 'factory-cli/1.0.0'", () => {
    const adapter = detectAdapter(makeContext("factory-cli/1.0.0"))
    expect(adapter).toBe(droidAdapter)
  })

  it("returns droidAdapter for any 'factory-cli/' prefix", () => {
    expect(detectAdapter(makeContext("factory-cli/0.1.0")).name).toBe("droid")
    expect(detectAdapter(makeContext("factory-cli/2.5.3")).name).toBe("droid")
    expect(detectAdapter(makeContext("factory-cli/99.99.99")).name).toBe("droid")
  })

  it("returns droidAdapter for 'factory-cli/' with extra info", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0 (darwin; arm64)"))
    expect(adapter).toBe(droidAdapter)
  })
})

describe("detectAdapter — Crush detection", () => {
  it("returns crushAdapter for 'Charm-Crush/v0.51.2'", () => {
    const adapter = detectAdapter(makeContext("Charm-Crush/v0.51.2 (https://charm.land/crush)"))
    expect(adapter).toBe(crushAdapter)
    expect(adapter.name).toBe("crush")
  })

  it("returns crushAdapter for any 'Charm-Crush/' prefix", () => {
    expect(detectAdapter(makeContext("Charm-Crush/v0.1.0")).name).toBe("crush")
    expect(detectAdapter(makeContext("Charm-Crush/v1.0.0")).name).toBe("crush")
    expect(detectAdapter(makeContext("Charm-Crush/v99.0.0")).name).toBe("crush")
  })

  it("returns crushAdapter for Charm-Crush with extra info", () => {
    const adapter = detectAdapter(makeContext("Charm-Crush/v0.51.2 (https://charm.land/crush)"))
    expect(adapter).toBe(crushAdapter)
  })
})

describe("detectAdapter — Claude Code detection", () => {
  it("returns claudeCodeAdapter for 'claude-cli/2.0.0'", () => {
    const adapter = detectAdapter(makeContext("claude-cli/2.0.0"))
    expect(adapter).toBe(claudeCodeAdapter)
    expect(adapter.name).toBe("claude-code")
  })

  it("returns claudeCodeAdapter for any 'claude-cli/' prefix", () => {
    expect(detectAdapter(makeContext("claude-cli/0.1.0")).name).toBe("claude-code")
    expect(detectAdapter(makeContext("claude-cli/1.0.0")).name).toBe("claude-code")
    expect(detectAdapter(makeContext("claude-cli/99.99.99")).name).toBe("claude-code")
  })

  it("returns claudeCodeAdapter for claude-cli with extra info", () => {
    const adapter = detectAdapter(makeContext("claude-cli/2.0.0 (linux; x64)"))
    expect(adapter).toBe(claudeCodeAdapter)
  })
})

describe("detectAdapter — claude-cli + MERIDIAN_DEFAULT_AGENT tiebreaker", () => {
  // Pi (and downstream Pi-based harnesses like pylon) ship with a User-Agent
  // of `claude-cli/<version>`. When the operator has explicitly set
  // MERIDIAN_DEFAULT_AGENT, the env var should win for this ambiguous UA.
  const originalEnv = process.env.MERIDIAN_DEFAULT_AGENT

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MERIDIAN_DEFAULT_AGENT
    else process.env.MERIDIAN_DEFAULT_AGENT = originalEnv
  })

  it("routes claude-cli/* to pi adapter when MERIDIAN_DEFAULT_AGENT=pi", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "pi"
    const adapter = detectAdapter(makeContext("claude-cli/2.0.0"))
    expect(adapter).toBe(piAdapter)
  })

  it("is case-insensitive on the env value", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "PI"
    expect(detectAdapter(makeContext("claude-cli/2.0.0")).name).toBe("pi")
  })

  it("falls through to claudeCodeAdapter when env is unset", () => {
    delete process.env.MERIDIAN_DEFAULT_AGENT
    expect(detectAdapter(makeContext("claude-cli/2.0.0"))).toBe(claudeCodeAdapter)
  })

  it("falls through to claudeCodeAdapter when env is empty string", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = ""
    expect(detectAdapter(makeContext("claude-cli/2.0.0"))).toBe(claudeCodeAdapter)
  })

  it("does NOT override when env is explicitly claude-code (no-op tiebreaker)", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "claude-code"
    expect(detectAdapter(makeContext("claude-cli/2.0.0"))).toBe(claudeCodeAdapter)
    process.env.MERIDIAN_DEFAULT_AGENT = "claudecode"
    expect(detectAdapter(makeContext("claude-cli/2.0.0"))).toBe(claudeCodeAdapter)
  })

  it("falls through to claudeCodeAdapter when env is an unknown adapter name", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "nonsense-agent"
    expect(detectAdapter(makeContext("claude-cli/2.0.0"))).toBe(claudeCodeAdapter)
  })

  it("does NOT affect other unambiguous UAs (opencode/ still wins over env=pi)", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "pi"
    expect(detectAdapter(makeContext("opencode/1.5.0"))).toBe(openCodeAdapter)
    expect(detectAdapter(makeContext("factory-cli/0.89.0"))).toBe(droidAdapter)
    expect(detectAdapter(makeContext("Charm-Crush/1.0.0"))).toBe(crushAdapter)
  })

  it("explicit x-meridian-agent header still wins over the env tiebreaker", () => {
    process.env.MERIDIAN_DEFAULT_AGENT = "pi"
    const adapter = detectAdapter(makeContext("claude-cli/2.0.0", { "x-meridian-agent": "claude-code" }))
    expect(adapter).toBe(claudeCodeAdapter)
  })
})

describe("detectAdapter — OpenCode fallback", () => {
  it("returns openCodeAdapter for empty User-Agent", () => {
    const adapter = detectAdapter(makeContext(""))
    expect(adapter).toBe(openCodeAdapter)
    expect(adapter.name).toBe("opencode")
  })

  it("returns openCodeAdapter when User-Agent header is missing", () => {
    const ctx = { req: { header: (name?: string) => name ? undefined : {} } }
    const adapter = detectAdapter(ctx as any)
    expect(adapter).toBe(openCodeAdapter)
  })

  it("returns openCodeAdapter for 'opencode/1.0'", () => {
    expect(detectAdapter(makeContext("opencode/1.0")).name).toBe("opencode")
  })

  it("returns openCodeAdapter for unknown User-Agent strings", () => {
    expect(detectAdapter(makeContext("curl/7.88.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("Mozilla/5.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("python-requests/2.28.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("axios/1.3.0")).name).toBe("opencode")
  })

  it("does NOT match 'factory/' without 'cli/'", () => {
    // Only exact 'factory-cli/' prefix triggers Droid
    expect(detectAdapter(makeContext("factory/1.0.0")).name).toBe("opencode")
  })

  it("does NOT match if factory-cli is not at the start", () => {
    // User-Agent with factory-cli in the middle should not trigger Droid
    expect(detectAdapter(makeContext("my-app factory-cli/0.89.0")).name).toBe("opencode")
  })

  it("does NOT match 'Charm-Crush' as OpenCode", () => {
    expect(detectAdapter(makeContext("Charm-Crush/v0.51.2")).name).toBe("crush")
  })
})

describe("detectAdapter — x-meridian-agent header override", () => {
  it("returns piAdapter when x-meridian-agent is 'pi'", () => {
    const adapter = detectAdapter(makeContext("", { "x-meridian-agent": "pi" }))
    expect(adapter).toBe(piAdapter)
    expect(adapter.name).toBe("pi")
  })

  it("returns crushAdapter when x-meridian-agent is 'crush'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "crush" }))).toBe(crushAdapter)
  })

  it("returns openCodeAdapter when x-meridian-agent is 'opencode'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "opencode" }))).toBe(openCodeAdapter)
  })

  it("returns droidAdapter when x-meridian-agent is 'droid'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "droid" }))).toBe(droidAdapter)
  })

  it("returns passthroughAdapter when x-meridian-agent is 'passthrough'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "passthrough" }))).toBe(passthroughAdapter)
  })

  it("returns forgeCodeAdapter when x-meridian-agent is 'forgecode'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "forgecode" }))).toBe(forgeCodeAdapter)
    expect(forgeCodeAdapter.name).toBe("forgecode")
  })

  it("returns claudeCodeAdapter when x-meridian-agent is 'claude-code'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "claude-code" }))).toBe(claudeCodeAdapter)
    expect(claudeCodeAdapter.name).toBe("claude-code")
  })

  it("accepts 'claudecode' as an alias for 'claude-code'", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "claudecode" }))).toBe(claudeCodeAdapter)
  })

  it("is case-insensitive on header value", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "Pi" })).name).toBe("pi")
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "PI" })).name).toBe("pi")
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "CRUSH" })).name).toBe("crush")
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "OpenCode" })).name).toBe("opencode")
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "ForgeCode" })).name).toBe("forgecode")
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "FORGECODE" })).name).toBe("forgecode")
  })

  it("takes precedence over User-Agent detection", () => {
    expect(detectAdapter(makeContext("factory-cli/1.0.0", { "x-meridian-agent": "pi" }))).toBe(piAdapter)
  })

  it("takes precedence over x-opencode-session detection", () => {
    expect(detectAdapter(makeContext("", { "x-meridian-agent": "pi", "x-opencode-session": "sess-123" }))).toBe(piAdapter)
  })

  it("falls through for unknown header values", () => {
    expect(detectAdapter(makeContext("factory-cli/1.0.0", { "x-meridian-agent": "unknown" }))).toBe(droidAdapter)
  })
})

describe("detectAdapter — OpenCode detection", () => {
  it("returns openCodeAdapter when x-opencode-session is present", () => {
    const adapter = detectAdapter(makeContext("", { "x-opencode-session": "sess-abc" }))
    expect(adapter).toBe(openCodeAdapter)
    expect(adapter.name).toBe("opencode")
  })

  it("returns openCodeAdapter when x-session-affinity is present", () => {
    const adapter = detectAdapter(makeContext("", { "x-session-affinity": "ses_2a50aeb32ffe" }))
    expect(adapter).toBe(openCodeAdapter)
  })

  it("returns openCodeAdapter for 'opencode/' User-Agent", () => {
    const adapter = detectAdapter(makeContext("opencode/1.3.15 ai-sdk/provider-utils/4.0.21"))
    expect(adapter).toBe(openCodeAdapter)
  })

  it("returns openCodeAdapter for any 'opencode/' version", () => {
    expect(detectAdapter(makeContext("opencode/0.1.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("opencode/2.0.0")).name).toBe("opencode")
    expect(detectAdapter(makeContext("opencode/99.99.99")).name).toBe("opencode")
  })

  it("returns openCodeAdapter regardless of User-Agent when session header present", () => {
    expect(detectAdapter(makeContext("claude-cli/1.0.0", { "x-opencode-session": "sess-xyz" }))).toBe(openCodeAdapter)
  })

  it("returns openCodeAdapter even with unknown UA when session-affinity present", () => {
    expect(detectAdapter(makeContext("curl/7.88.0", { "x-session-affinity": "ses_123" }))).toBe(openCodeAdapter)
  })
})

describe("detectAdapter — adapter contracts", () => {
  it("detected droid adapter can extract CWD from Droid-format body", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    const body = {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "<system-reminder>\n% pwd\n/tmp/test-project\n</system-reminder>",
        }],
      }],
    }
    expect(adapter.extractWorkingDirectory(body)).toBe("/tmp/test-project")
  })

  it("detected opencode adapter can extract CWD from OpenCode-format body", () => {
    const adapter = detectAdapter(makeContext(""))
    const body = {
      system: "<env>\n  Working directory: /Users/test/project\n</env>",
    }
    expect(adapter.extractWorkingDirectory(body)).toBe("/Users/test/project")
  })

  it("detected droid adapter returns undefined for session ID", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    const ctx = { req: { header: () => "some-value" } }
    expect(adapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("detected opencode adapter extracts session from x-opencode-session", () => {
    const adapter = detectAdapter(makeContext("opencode/1.0"))
    const ctx = {
      req: { header: (name: string) => name === "x-opencode-session" ? "sess-abc" : undefined },
    }
    expect(adapter.getSessionId(ctx as any)).toBe("sess-abc")
  })

  it("detected droid adapter has droid MCP server name", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    expect(adapter.getMcpServerName()).toBe("droid")
  })

  it("detected opencode adapter has opencode MCP server name", () => {
    const adapter = detectAdapter(makeContext(""))
    expect(adapter.getMcpServerName()).toBe("opencode")
  })

  it("detected droid adapter respects env for usesPassthrough — opt-in default off", () => {
    const adapter = detectAdapter(makeContext("factory-cli/0.89.0"))
    expect(typeof adapter.usesPassthrough).toBe("function")
    const savedMP = process.env.MERIDIAN_PASSTHROUGH
    const savedCP = process.env.CLAUDE_PROXY_PASSTHROUGH
    try {
      delete process.env.MERIDIAN_PASSTHROUGH
      delete process.env.CLAUDE_PROXY_PASSTHROUGH
      // Default: off (preserves prior behavior for users without the env var)
      expect(adapter.usesPassthrough!()).toBe(false)
      // Opt-in: on
      process.env.MERIDIAN_PASSTHROUGH = "1"
      expect(adapter.usesPassthrough!()).toBe(true)
    } finally {
      if (savedMP !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedMP
      else delete process.env.MERIDIAN_PASSTHROUGH
      if (savedCP !== undefined) process.env.CLAUDE_PROXY_PASSTHROUGH = savedCP
      else delete process.env.CLAUDE_PROXY_PASSTHROUGH
    }
  })

  it("detected opencode adapter has no usesPassthrough — defers to env var", () => {
    // The openCodeAdapter now implements usesPassthrough() and defaults to true
    // (passthrough mode) unless overridden by MERIDIAN_PASSTHROUGH=0.
    const adapter = detectAdapter(makeContext(""))
    expect(typeof adapter.usesPassthrough).toBe("function")
    // Default behavior: passthrough is true when no env var overrides it
    const saved = process.env.MERIDIAN_PASSTHROUGH
    delete process.env.MERIDIAN_PASSTHROUGH
    try {
      expect(adapter.usesPassthrough!()).toBe(true)
    } finally {
      if (saved !== undefined) process.env.MERIDIAN_PASSTHROUGH = saved
    }
  })

  it("detected crush adapter has no usesPassthrough — defers to env var", () => {
    const adapter = detectAdapter(makeContext("Charm-Crush/v0.51.2"))
    expect(adapter.usesPassthrough).toBeUndefined()
  })

  it("detected crush adapter extracts no CWD (always undefined)", () => {
    const adapter = detectAdapter(makeContext("Charm-Crush/v0.51.2"))
    expect(adapter.extractWorkingDirectory({ messages: [], system: [] })).toBeUndefined()
  })

  it("detected crush adapter returns undefined for session ID", () => {
    const adapter = detectAdapter(makeContext("Charm-Crush/v0.51.2"))
    const ctx = { req: { header: () => "any-value" } }
    expect(adapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("detected crush adapter has crush MCP server name", () => {
    const adapter = detectAdapter(makeContext("Charm-Crush/v0.51.2"))
    expect(adapter.getMcpServerName()).toBe("crush")
  })

  it("detected forgecode adapter extracts CWD from XML tag", () => {
    const adapter = detectAdapter(makeContext("", { "x-meridian-agent": "forgecode" }))
    const body = {
      system: "<current_working_directory>/tmp/forge-project</current_working_directory>",
    }
    expect(adapter.extractWorkingDirectory(body)).toBe("/tmp/forge-project")
  })

  it("detected forgecode adapter returns undefined for session ID", () => {
    const adapter = detectAdapter(makeContext("", { "x-meridian-agent": "forgecode" }))
    const ctx = { req: { header: () => "any-value" } }
    expect(adapter.getSessionId(ctx as any)).toBeUndefined()
  })

  it("detected forgecode adapter has forgecode MCP server name", () => {
    const adapter = detectAdapter(makeContext("", { "x-meridian-agent": "forgecode" }))
    expect(adapter.getMcpServerName()).toBe("forgecode")
  })

  it("detected forgecode adapter has no usesPassthrough — defers to env var", () => {
    const adapter = detectAdapter(makeContext("", { "x-meridian-agent": "forgecode" }))
    expect(adapter.usesPassthrough).toBeUndefined()
  })
})
