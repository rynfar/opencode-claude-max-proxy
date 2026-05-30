/**
 * Tests for the Cherry Studio chat-client adapter.
 *
 * The load-bearing assertion below — that WebSearch / WebFetch are NOT in
 * the adapter's blocked / incompatible lists — is the actual fix for the
 * symptom Ben reported in #481 ("WebSearch tool not exposed in the
 * session"). When this assertion regresses, Cherry Studio's web search
 * silently breaks again.
 */
import { describe, it, expect } from "bun:test"
import { cherryStudioAdapter } from "../proxy/adapters/cherrystudio"

describe("cherryStudioAdapter — identity", () => {
  it("has name 'cherry-studio'", () => {
    expect(cherryStudioAdapter.name).toBe("cherry-studio")
  })
})

describe("cherryStudioAdapter.getSessionId", () => {
  it("always returns undefined — Cherry Studio has no session-affinity header", () => {
    const ctx = { req: { header: () => "anything" } }
    expect(cherryStudioAdapter.getSessionId(ctx as any)).toBeUndefined()
  })
})

describe("cherryStudioAdapter.extractWorkingDirectory", () => {
  it("returns undefined for any body — chat client has no CWD concept", () => {
    expect(cherryStudioAdapter.extractWorkingDirectory({})).toBeUndefined()
    expect(cherryStudioAdapter.extractWorkingDirectory({ system: "anything" })).toBeUndefined()
  })
})

describe("cherryStudioAdapter — tool blocking (regression for #481)", () => {
  // The whole point of this adapter: chat clients have no MCP equivalent for
  // WebSearch / WebFetch and no client-side web access. If we block them, the
  // user sees "tool not exposed" and the fix is silently undone.
  const blocked = new Set<string>([
    ...cherryStudioAdapter.getBlockedBuiltinTools(),
    ...cherryStudioAdapter.getAgentIncompatibleTools(),
  ])

  it("does NOT block WebSearch", () => {
    expect(blocked.has("WebSearch")).toBe(false)
  })

  it("does NOT block WebFetch", () => {
    expect(blocked.has("WebFetch")).toBe(false)
  })

  it("blocks filesystem tools (Read/Write/Edit/Bash) — chat clients shouldn't poke the proxy host", () => {
    expect(blocked.has("Read")).toBe(true)
    expect(blocked.has("Write")).toBe(true)
    expect(blocked.has("Edit")).toBe(true)
    expect(blocked.has("Bash")).toBe(true)
    expect(blocked.has("Glob")).toBe(true)
    expect(blocked.has("Grep")).toBe(true)
  })

  it("blocks Claude-Code-only orchestration tools", () => {
    for (const name of ["CronCreate", "EnterPlanMode", "EnterWorktree", "Skill", "Agent"]) {
      expect(blocked.has(name)).toBe(true)
    }
  })
})

describe("cherryStudioAdapter — chat-client behavior", () => {
  it("usesPassthrough returns false — SDK runs tools, returns results inline", () => {
    expect(cherryStudioAdapter.usesPassthrough?.()).toBe(false)
  })

  it("supportsThinking returns true — Cherry Studio renders thinking when enabled", () => {
    expect(cherryStudioAdapter.supportsThinking?.()).toBe(true)
  })

  it("shouldTrackFileChanges returns false — chat clients don't render diff blocks", () => {
    expect(cherryStudioAdapter.shouldTrackFileChanges?.()).toBe(false)
  })

  it("buildSdkAgents returns empty — no subagent routing", () => {
    expect(cherryStudioAdapter.buildSdkAgents?.({}, [])).toEqual({})
  })

  it("getAllowedMcpTools returns empty — no MCP server-side tools", () => {
    expect(cherryStudioAdapter.getAllowedMcpTools()).toEqual([])
  })

  it("buildSdkHooks returns undefined — no PreToolUse hook needed", () => {
    expect(cherryStudioAdapter.buildSdkHooks?.({}, {})).toBeUndefined()
  })

  it("buildSystemContextAddendum returns empty string", () => {
    expect(cherryStudioAdapter.buildSystemContextAddendum?.({}, {})).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Detection — Cherry Studio has no stable User-Agent (CherryHQ#10209), so
// it must be selected via header or env var. These tests pin that contract.
// ---------------------------------------------------------------------------
describe("Cherry Studio detection via x-meridian-agent header", () => {
  it("x-meridian-agent: cherry-studio routes to cherryStudioAdapter", async () => {
    const { detectAdapter } = await import("../proxy/adapters/detect")
    const ctx = {
      req: {
        header: (name: string) => (name === "x-meridian-agent" ? "cherry-studio" : undefined),
      },
    }
    expect(detectAdapter(ctx as any).name).toBe("cherry-studio")
  })

  it("x-meridian-agent: cherrystudio (no hyphen) also routes — alias", async () => {
    const { detectAdapter } = await import("../proxy/adapters/detect")
    const ctx = {
      req: {
        header: (name: string) => (name === "x-meridian-agent" ? "cherrystudio" : undefined),
      },
    }
    expect(detectAdapter(ctx as any).name).toBe("cherry-studio")
  })

  it("ignores case in x-meridian-agent value", async () => {
    const { detectAdapter } = await import("../proxy/adapters/detect")
    const ctx = {
      req: {
        header: (name: string) => (name === "x-meridian-agent" ? "Cherry-Studio" : undefined),
      },
    }
    expect(detectAdapter(ctx as any).name).toBe("cherry-studio")
  })
})

// ---------------------------------------------------------------------------
// Audit: every adapter registered for detection must also have a UI label.
// Without this, the next adapter we register for detection-only (like
// claude-code originally was) ends up invisible in the settings page —
// users can't see or change its feature toggles. This is the symptom Ben
// described as "It'd be nice to customize things like Client Prompt,
// Thinking Passthrough, Thinking like other harnesses."
// ---------------------------------------------------------------------------
describe("adapter list is single-sourced (regression guard)", () => {
  it("every canonical adapter in ADAPTER_LABELS is reachable via ADAPTER_MAP", async () => {
    const { ADAPTER_MAP, ADAPTER_LABELS } = await import("../proxy/adapters/detect")
    for (const name of Object.keys(ADAPTER_LABELS)) {
      expect(ADAPTER_MAP[name]).toBeDefined()
      expect(ADAPTER_MAP[name]?.name).toBeDefined()
    }
  })

  it("getAllFeatureConfigs returns one entry per ADAPTER_LABELS key", async () => {
    const { ADAPTER_LABELS } = await import("../proxy/adapters/detect")
    const { getAllFeatureConfigs } = await import("../proxy/sdkFeatures")
    const cfg = getAllFeatureConfigs()
    for (const name of Object.keys(ADAPTER_LABELS)) {
      expect(cfg[name]).toBeDefined()
    }
  })

  it("includes cherry-studio specifically (the new entry)", async () => {
    const { ADAPTER_LABELS } = await import("../proxy/adapters/detect")
    const { getAllFeatureConfigs } = await import("../proxy/sdkFeatures")
    expect(ADAPTER_LABELS["cherry-studio"]).toBe("Cherry Studio")
    expect(getAllFeatureConfigs()["cherry-studio"]).toBeDefined()
  })

  it("includes claude-code (latent gap fixed by this change)", async () => {
    const { ADAPTER_LABELS } = await import("../proxy/adapters/detect")
    const { getAllFeatureConfigs } = await import("../proxy/sdkFeatures")
    expect(ADAPTER_LABELS["claude-code"]).toBe("Claude Code")
    expect(getAllFeatureConfigs()["claude-code"]).toBeDefined()
  })
})
