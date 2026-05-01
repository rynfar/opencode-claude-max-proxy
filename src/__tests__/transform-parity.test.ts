import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { createRequestContext, runTransformHook } from "../proxy/transform"
import { openCodeTransforms } from "../proxy/transforms/opencode"
import { crushTransforms } from "../proxy/transforms/crush"
import { droidTransforms } from "../proxy/transforms/droid"
import { piTransforms } from "../proxy/transforms/pi"
import { forgeCodeTransforms } from "../proxy/transforms/forgecode"
import { passthroughTransforms } from "../proxy/transforms/passthrough"
import { openCodeAdapter } from "../proxy/adapters/opencode"
import { crushAdapter } from "../proxy/adapters/crush"
import { droidAdapter } from "../proxy/adapters/droid"
import { piAdapter } from "../proxy/adapters/pi"
import { forgeCodeAdapter } from "../proxy/adapters/forgecode"
import { passthroughAdapter } from "../proxy/adapters/passthrough"

function makeCtx(adapter: string, body: any = {}) {
  return createRequestContext({
    adapter,
    body,
    headers: new Headers(),
    model: "sonnet",
    messages: [],
    stream: false,
    workingDirectory: "/tmp",
  })
}

describe("OpenCode transform parity", () => {
  it("matches blockedTools", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.blockedTools]).toEqual([...openCodeAdapter.getBlockedBuiltinTools()])
  })

  it("matches incompatibleTools", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.incompatibleTools]).toEqual([...openCodeAdapter.getAgentIncompatibleTools()])
  })

  it("matches allowedMcpTools", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.allowedMcpTools]).toEqual([...openCodeAdapter.getAllowedMcpTools()])
  })

  it("matches coreToolNames", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect([...ctx.coreToolNames!]).toEqual([...openCodeAdapter.getCoreToolNames!()])
  })

  it("matches supportsThinking", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect(ctx.supportsThinking).toBe(openCodeAdapter.supportsThinking!())
  })

  it("matches shouldTrackFileChanges", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    expect(ctx.shouldTrackFileChanges).toBe(openCodeAdapter.shouldTrackFileChanges!())
  })

  it("matches buildSdkAgents with no Task tool", () => {
    const body = { tools: [] }
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode", body), "opencode")
    expect(ctx.sdkAgents).toEqual(openCodeAdapter.buildSdkAgents!(body, openCodeAdapter.getAllowedMcpTools()))
  })

  it("matches buildSystemContextAddendum with no agents", () => {
    const body = { tools: [] }
    const ctx = runTransformHook(
      openCodeTransforms,
      "onRequest",
      { ...makeCtx("opencode", body), systemContext: "test" },
      "opencode",
    )
    expect(ctx.systemContext).toBe("test")
  })

  it("matches file change extraction for write tool", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    const changes = ctx.extractFileChangesFromToolUse!("write", { filePath: "/test.ts" })
    const expected = openCodeAdapter.extractFileChangesFromToolUse!("write", { filePath: "/test.ts" })
    expect(changes).toEqual(expected)
  })

  it("matches file change extraction for edit tool", () => {
    const ctx = runTransformHook(openCodeTransforms, "onRequest", makeCtx("opencode"), "opencode")
    const changes = ctx.extractFileChangesFromToolUse!("edit", { filePath: "/test.ts" })
    const expected = openCodeAdapter.extractFileChangesFromToolUse!("edit", { filePath: "/test.ts" })
    expect(changes).toEqual(expected)
  })
})

describe("Crush transform parity", () => {
  it("matches blockedTools", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect([...ctx.blockedTools]).toEqual([...crushAdapter.getBlockedBuiltinTools()])
  })

  it("matches allowedMcpTools", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect([...ctx.allowedMcpTools]).toEqual([...crushAdapter.getAllowedMcpTools()])
  })

  it("matches supportsThinking", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect(ctx.supportsThinking).toBe(crushAdapter.supportsThinking!())
  })

  it("matches file change extraction", () => {
    const ctx = runTransformHook(crushTransforms, "onRequest", makeCtx("crush"), "crush")
    expect(ctx.extractFileChangesFromToolUse!("write", { file_path: "/a.ts" }))
      .toEqual(crushAdapter.extractFileChangesFromToolUse!("write", { file_path: "/a.ts" }))
  })
})

describe("Droid transform parity", () => {
  // Save/restore env so the parity assertion isn't sensitive to ambient state.
  let savedMP: string | undefined
  let savedCP: string | undefined
  beforeEach(() => {
    savedMP = process.env.MERIDIAN_PASSTHROUGH
    savedCP = process.env.CLAUDE_PROXY_PASSTHROUGH
  })
  afterEach(() => {
    if (savedMP !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedMP
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedCP !== undefined) process.env.CLAUDE_PROXY_PASSTHROUGH = savedCP
    else delete process.env.CLAUDE_PROXY_PASSTHROUGH
  })

  it("matches passthrough (env off → false)", () => {
    delete process.env.MERIDIAN_PASSTHROUGH
    delete process.env.CLAUDE_PROXY_PASSTHROUGH
    const ctx = runTransformHook(droidTransforms, "onRequest", makeCtx("droid"), "droid")
    expect(ctx.passthrough).toBe(droidAdapter.usesPassthrough!())
    expect(ctx.passthrough).toBe(false)
  })

  it("matches passthrough (env on → true)", () => {
    process.env.MERIDIAN_PASSTHROUGH = "1"
    const ctx = runTransformHook(droidTransforms, "onRequest", makeCtx("droid"), "droid")
    expect(ctx.passthrough).toBe(droidAdapter.usesPassthrough!())
    expect(ctx.passthrough).toBe(true)
  })

  it("matches leaksCwdViaSystemReminder", () => {
    const ctx = runTransformHook(droidTransforms, "onRequest", makeCtx("droid"), "droid")
    expect(ctx.leaksCwdViaSystemReminder).toBe(droidAdapter.leaksCwdViaSystemReminder!())
  })
})

describe("Pi transform parity", () => {
  it("matches supportsThinking", () => {
    const ctx = runTransformHook(piTransforms, "onRequest", makeCtx("pi"), "pi")
    expect(ctx.supportsThinking).toBe(piAdapter.supportsThinking!())
  })

  it("matches file change extraction", () => {
    const ctx = runTransformHook(piTransforms, "onRequest", makeCtx("pi"), "pi")
    expect(ctx.extractFileChangesFromToolUse!("write", { filePath: "/a.ts" }))
      .toEqual(piAdapter.extractFileChangesFromToolUse!("write", { filePath: "/a.ts" }))
  })
})

describe("ForgeCode transform parity", () => {
  it("matches file change extraction for patch tool", () => {
    const ctx = runTransformHook(forgeCodeTransforms, "onRequest", makeCtx("forgecode"), "forgecode")
    expect(ctx.extractFileChangesFromToolUse!("patch", { file_path: "/a.ts" }))
      .toEqual(forgeCodeAdapter.extractFileChangesFromToolUse!("patch", { file_path: "/a.ts" }))
  })

  it("matches file change extraction for shell tool", () => {
    const ctx = runTransformHook(forgeCodeTransforms, "onRequest", makeCtx("forgecode"), "forgecode")
    expect(ctx.extractFileChangesFromToolUse!("shell", { command: "echo hi > /tmp/a" }))
      .toEqual(forgeCodeAdapter.extractFileChangesFromToolUse!("shell", { command: "echo hi > /tmp/a" }))
  })
})

describe("Passthrough (LiteLLM) transform parity", () => {
  it("matches passthrough (always true)", () => {
    const ctx = runTransformHook(passthroughTransforms, "onRequest", makeCtx("passthrough"), "passthrough")
    expect(ctx.passthrough).toBe(passthroughAdapter.usesPassthrough!())
  })

  it("matches prefersStreaming with stream=true", () => {
    const ctx = runTransformHook(
      passthroughTransforms,
      "onRequest",
      makeCtx("passthrough", { stream: true }),
      "passthrough",
    )
    expect(ctx.prefersStreaming).toBe(passthroughAdapter.prefersStreaming!({ stream: true }))
  })

  it("matches prefersStreaming with stream=false", () => {
    const ctx = runTransformHook(
      passthroughTransforms,
      "onRequest",
      makeCtx("passthrough", { stream: false }),
      "passthrough",
    )
    expect(ctx.prefersStreaming).toBe(passthroughAdapter.prefersStreaming!({ stream: false }))
  })

  it("matches empty blockedTools", () => {
    const ctx = runTransformHook(passthroughTransforms, "onRequest", makeCtx("passthrough"), "passthrough")
    expect([...ctx.blockedTools]).toEqual([...passthroughAdapter.getBlockedBuiltinTools()])
  })
})
