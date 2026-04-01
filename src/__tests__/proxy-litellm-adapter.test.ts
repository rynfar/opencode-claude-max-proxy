/**
 * LiteLLM passthrough adapter tests.
 *
 * Covers:
 * - Adapter identity and interface compliance
 * - Session ID extraction from x-litellm-session-id header
 * - CWD extraction from <env> blocks and inline cwd= patterns
 * - Tool configuration (passthrough mode — no built-in tool blocking)
 * - Agent/hook/system-context stubs (all no-ops for passthrough)
 * - usesPassthrough() always true
 * - prefersStreaming() always false
 * - detectAdapter() routing for LiteLLM requests
 */

import { describe, it, expect, mock } from "bun:test"
import { passthroughAdapter } from "../proxy/adapters/passthrough"
import { detectAdapter } from "../proxy/adapters/detect"

// ============================================================
// Identity
// ============================================================

describe("passthroughAdapter — identity", () => {
  it("has name 'passthrough'", () => {
    expect(passthroughAdapter.name).toBe("passthrough")
  })
})

// ============================================================
// Session ID
// ============================================================

describe("passthroughAdapter.getSessionId", () => {
  it("returns session id from x-litellm-session-id header", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "x-litellm-session-id") return "litellm-abc123"
          return undefined
        },
      },
    }
    expect(passthroughAdapter.getSessionId(c as any)).toBe("litellm-abc123")
  })

  it("returns undefined when no x-litellm-session-id header", () => {
    const c = { req: { header: () => undefined } }
    expect(passthroughAdapter.getSessionId(c as any)).toBeUndefined()
  })

  it("ignores x-opencode-session (that's a different adapter)", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "x-opencode-session") return "opencode-xyz"
          return undefined
        },
      },
    }
    expect(passthroughAdapter.getSessionId(c as any)).toBeUndefined()
  })
})

// ============================================================
// Working directory extraction
// ============================================================

describe("passthroughAdapter.extractWorkingDirectory", () => {
  it("extracts CWD from <env cwd='...'> block", () => {
    const body = {
      messages: [
        { role: "user", content: "<env cwd=\"/home/user/project\">context</env>" },
      ],
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBe("/home/user/project")
  })

  it("extracts CWD from inline cwd= pattern in prompt string", () => {
    const body = { prompt: 'Working in cwd="/tmp/work" now.' }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBe("/tmp/work")
  })

  it("extracts CWD from array message content", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<env cwd=\"/opt/app\">info</env>" },
          ],
        },
      ],
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBe("/opt/app")
  })

  it("returns undefined when no CWD present", () => {
    expect(passthroughAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined for null/undefined body", () => {
    expect(passthroughAdapter.extractWorkingDirectory(null)).toBeUndefined()
    expect(passthroughAdapter.extractWorkingDirectory(undefined)).toBeUndefined()
  })

  it("returns undefined for messages without CWD", () => {
    const body = {
      messages: [{ role: "user", content: "Hello, help me with my code." }],
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })
})

// ============================================================
// Content normalisation
// ============================================================

describe("passthroughAdapter.normalizeContent", () => {
  it("passes string content through unchanged", () => {
    expect(passthroughAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("joins text blocks from array content", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ]
    expect(passthroughAdapter.normalizeContent(content)).toBe("hello\n world")
  })

  it("includes tool_use block description in normalised output", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = passthroughAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })
})

// ============================================================
// Tool configuration
// ============================================================

describe("passthroughAdapter — tool configuration", () => {
  it("getBlockedBuiltinTools returns empty (passthrough hook handles blocking)", () => {
    expect(passthroughAdapter.getBlockedBuiltinTools()).toHaveLength(0)
  })

  it("getAgentIncompatibleTools returns empty", () => {
    expect(passthroughAdapter.getAgentIncompatibleTools()).toHaveLength(0)
  })

  it("getMcpServerName returns 'litellm'", () => {
    expect(passthroughAdapter.getMcpServerName()).toBe("litellm")
  })

  it("getAllowedMcpTools returns exactly 6 standard tools", () => {
    expect(passthroughAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("all allowed tools have mcp__litellm__ prefix", () => {
    for (const tool of passthroughAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__litellm__")
    }
  })

  it("getAllowedMcpTools covers the standard file system set", () => {
    const tools = passthroughAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__litellm__read")
    expect(tools).toContain("mcp__litellm__write")
    expect(tools).toContain("mcp__litellm__edit")
    expect(tools).toContain("mcp__litellm__bash")
    expect(tools).toContain("mcp__litellm__glob")
    expect(tools).toContain("mcp__litellm__grep")
  })
})

// ============================================================
// SDK stubs (no-ops for passthrough)
// ============================================================

describe("passthroughAdapter — SDK stubs", () => {
  it("buildSdkAgents returns empty object", () => {
    expect(passthroughAdapter.buildSdkAgents!({}, [])).toEqual({})
  })

  it("buildSdkHooks returns undefined", () => {
    expect(passthroughAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })

  it("buildSystemContextAddendum returns empty string", () => {
    expect(passthroughAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

// ============================================================
// Passthrough and streaming flags
// ============================================================

describe("passthroughAdapter — passthrough and streaming", () => {
  it("usesPassthrough always returns true", () => {
    expect(passthroughAdapter.usesPassthrough!()).toBe(true)
  })

  it("prefersStreaming always returns false (LiteLLM needs non-streaming)", () => {
    expect(passthroughAdapter.prefersStreaming!({})).toBe(false)
    expect(passthroughAdapter.prefersStreaming!({ stream: true })).toBe(false)
  })
})

// ============================================================
// detectAdapter routing
// ============================================================

describe("detectAdapter — LiteLLM routing", () => {
  function makeContext(ua: string, extraHeaders: Record<string, string> = {}) {
    return {
      req: {
        header: (name?: string) => {
          if (!name) return { "user-agent": ua, ...extraHeaders }
          if (name === "user-agent") return ua || undefined
          return extraHeaders[name] ?? extraHeaders[name.toLowerCase()] ?? undefined
        },
      },
    }
  }

  it("routes litellm/* User-Agent to passthrough adapter", () => {
    expect(detectAdapter(makeContext("litellm/1.0.0") as any).name).toBe("passthrough")
  })

  it("routes x-litellm-api-key header to passthrough adapter", () => {
    expect(detectAdapter(makeContext("python-httpx/0.27.0", { "x-litellm-api-key": "sk-123" }) as any).name).toBe("passthrough")
  })

  it("routes x-litellm-model header to passthrough adapter", () => {
    expect(detectAdapter(makeContext("python-httpx/0.27.0", { "x-litellm-model": "claude-sonnet-4-5" }) as any).name).toBe("passthrough")
  })

  it("routes any x-litellm-* header to passthrough (case-insensitive key)", () => {
    expect(detectAdapter(makeContext("", { "x-litellm-custom-header": "val" }) as any).name).toBe("passthrough")
  })

  it("falls back to opencode for python-httpx without litellm headers", () => {
    expect(detectAdapter(makeContext("python-httpx/0.27.0") as any).name).toBe("opencode")
  })

  it("Droid takes priority over LiteLLM headers", () => {
    expect(detectAdapter(makeContext("factory-cli/1.0.0", { "x-litellm-api-key": "sk-123" }) as any).name).toBe("droid")
  })

  it("Crush takes priority over LiteLLM headers", () => {
    expect(detectAdapter(makeContext("Charm-Crush/0.1.0", { "x-litellm-api-key": "sk-123" }) as any).name).toBe("crush")
  })

  it("routes empty User-Agent with litellm header to passthrough", () => {
    expect(detectAdapter(makeContext("", { "x-litellm-session-id": "sess-1" }) as any).name).toBe("passthrough")
  })
})
