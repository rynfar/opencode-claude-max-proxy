/**
 * Tests for the passthrough proxy adapter.
 */
import { describe, it, expect } from "bun:test"
import { passthroughAdapter } from "../proxy/adapters/passthrough"
import { detectAdapter } from "../proxy/adapters/detect"

describe("passthroughAdapter — identity", () => {
  it("has name 'passthrough'", () => {
    expect(passthroughAdapter.name).toBe("passthrough")
  })
})

describe("passthroughAdapter.getSessionId", () => {
  it("returns session id from x-litellm-session-id header", () => {
    const mockContext = {
      req: {
        header: (name: string) => {
          if (name === "x-litellm-session-id") return "litellm-abc"
          if (name === "x-opencode-session") return "opencode-xyz"
          return undefined
        },
      },
    }
    expect(passthroughAdapter.getSessionId(mockContext as any)).toBe("litellm-abc")
  })

  it("returns undefined when no session header present", () => {
    const mockContext = {
      req: {
        header: () => undefined,
      },
    }
    expect(passthroughAdapter.getSessionId(mockContext as any)).toBeUndefined()
  })
})

describe("passthroughAdapter.extractWorkingDirectory", () => {
  it("extracts CWD from <env> block with cwd attribute", () => {
    const body = {
      model: "claude-sonnet-4-5-20250514",
      messages: [
        {
          role: "user",
          content: "<env cwd=\"/home/user/project\">test</env>",
        },
      ],
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBe("/home/user/project")
  })

  it("extracts CWD from simple prompt with cwd", () => {
    const body = {
      prompt: 'Some text cwd="/tmp/work" more text',
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBe("/tmp/work")
  })

  it("returns undefined when no CWD in prompt", () => {
    expect(passthroughAdapter.extractWorkingDirectory({})).toBeUndefined()
  })

  it("returns undefined for request body without CWD info", () => {
    const body = {
      model: "claude-sonnet-4-5-20250514",
      max_tokens: 32000,
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ name: "bash", description: "Run a command" }],
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })

  it("returns undefined even with system prompt present", () => {
    const body = {
      system: [{ type: "text", text: "You are Claude..." }],
      messages: [{ role: "user", content: "Hello" }],
    }
    expect(passthroughAdapter.extractWorkingDirectory(body)).toBeUndefined()
  })
})

describe("passthroughAdapter.normalizeContent", () => {
  it("normalizes string content", () => {
    expect(passthroughAdapter.normalizeContent("hello world")).toBe("hello world")
  })

  it("normalizes array content to text", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ]
    expect(passthroughAdapter.normalizeContent(content)).toBe("hello\n world")
  })

  it("normalizes tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]
    const result = passthroughAdapter.normalizeContent(content)
    expect(result).toContain("tool_use")
    expect(result).toContain("bash")
  })

  it("converts non-string/array content to string", () => {
    expect(passthroughAdapter.normalizeContent(42 as any)).toBe("42")
  })
})

describe("passthroughAdapter tool configuration", () => {
  it("getBlockedBuiltinTools returns empty array (passthrough mode)", () => {
    const blocked = passthroughAdapter.getBlockedBuiltinTools()
    expect(blocked).toHaveLength(0)
  })

  it("getAgentIncompatibleTools returns empty array (passthrough mode)", () => {
    const incompatible = passthroughAdapter.getAgentIncompatibleTools()
    expect(incompatible).toHaveLength(0)
  })

  it("getMcpServerName returns 'litellm'", () => {
    expect(passthroughAdapter.getMcpServerName()).toBe("litellm")
  })

  it("getAllowedMcpTools returns exactly 6 tools", () => {
    expect(passthroughAdapter.getAllowedMcpTools()).toHaveLength(6)
  })

  it("all tools have mcp__litellm__ prefix", () => {
    for (const tool of passthroughAdapter.getAllowedMcpTools()) {
      expect(tool).toStartWith("mcp__litellm__")
    }
  })

  it("getAllowedMcpTools covers the standard set", () => {
    const tools = passthroughAdapter.getAllowedMcpTools()
    expect(tools).toContain("mcp__litellm__read")
    expect(tools).toContain("mcp__litellm__write")
    expect(tools).toContain("mcp__litellm__edit")
    expect(tools).toContain("mcp__litellm__bash")
    expect(tools).toContain("mcp__litellm__glob")
    expect(tools).toContain("mcp__litellm__grep")
  })
})

describe("passthroughAdapter.buildSdkAgents", () => {
  it("always returns empty object — passthrough manages subagents internally", () => {
    const body = {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "Hello" }],
    }
    expect(passthroughAdapter.buildSdkAgents!(body, ["mcp__litellm__read"])).toEqual({})
  })

  it("returns empty even with Task-like tools in the body", () => {
    const body = {
      tools: [{
        name: "task",
        description: "Available agent types:\n- oracle: research\n- coder: coding",
        input_schema: { type: "object" },
      }],
    }
    expect(passthroughAdapter.buildSdkAgents!(body, [])).toEqual({})
  })

  it("returns empty for empty body", () => {
    expect(passthroughAdapter.buildSdkAgents!({}, [])).toEqual({})
  })
})

describe("passthroughAdapter.buildSdkHooks", () => {
  it("always returns undefined — no hook-based agent correction needed", () => {
    const sdkAgents = { oracle: {}, explore: {} }
    expect(passthroughAdapter.buildSdkHooks!({}, sdkAgents)).toBeUndefined()
  })

  it("returns undefined for empty agents", () => {
    expect(passthroughAdapter.buildSdkHooks!({}, {})).toBeUndefined()
  })
})

describe("passthroughAdapter.buildSystemContextAddendum", () => {
  it("always returns empty string — no extra context for passthrough", () => {
    const sdkAgents = { oracle: {}, explore: {} }
    expect(passthroughAdapter.buildSystemContextAddendum!({}, sdkAgents)).toBe("")
  })

  it("returns empty string for empty agents", () => {
    expect(passthroughAdapter.buildSystemContextAddendum!({}, {})).toBe("")
  })
})

describe("passthroughAdapter.usesPassthrough", () => {
  it("always returns true — passthrough requires passthrough mode", () => {
    expect(passthroughAdapter.usesPassthrough!()).toBe(true)
  })
})

describe("detectAdapter — passthrough detection", () => {
  it("detects passthrough by x-litellm-api-key header", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "x-litellm-api-key") return "sk-123456"
          if (name === "user-agent") return "python-httpx/0.27.0"
          return undefined
        },
      },
    }
    expect(detectAdapter(c as any).name).toBe("passthrough")
  })

  it("detects passthrough by x-litellm-model header", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "x-litellm-model") return "claude-sonnet-4-5"
          if (name === "user-agent") return "python-httpx/0.27.0"
          return undefined
        },
      },
    }
    expect(detectAdapter(c as any).name).toBe("passthrough")
  })

  it("detects passthrough by any x-litellm-* header (case insensitive)", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name.toLowerCase() === "x-litellm-custom") return "value"
          if (name === "user-agent") return "python-httpx/0.27.0"
          return undefined
        },
      },
    }
    expect(detectAdapter(c as any).name).toBe("passthrough")
  })

  it("falls back to opencode for generic python-httpx without litellm headers", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "user-agent") return "python-httpx/0.27.0"
          return undefined
        },
      },
    }
    expect(detectAdapter(c as any).name).toBe("opencode")
  })

  it("still prefers Droid over passthrough when factory-cli User-Agent present", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "user-agent") return "factory-cli/1.0.0"
          if (name === "x-litellm-api-key") return "sk-123456"
          return undefined
        },
      },
    }
    expect(detectAdapter(c as any).name).toBe("droid")
  })

  it("still prefers Crush over passthrough when Charm-Crush User-Agent present", () => {
    const c = {
      req: {
        header: (name: string) => {
          if (name === "user-agent") return "Charm-Crush/0.1.0"
          if (name === "x-litellm-api-key") return "sk-123456"
          return undefined
        },
      },
    }
    expect(detectAdapter(c as any).name).toBe("crush")
  })
})
