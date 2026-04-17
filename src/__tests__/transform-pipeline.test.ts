import { describe, it, expect } from "bun:test"
import {
  runTransformHook,
  runObserveHook,
  buildPipeline,
  createRequestContext,
  type Transform,
  type RequestContext,
  type TelemetryContext,
} from "../proxy/transform"

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return createRequestContext({
    adapter: "test",
    body: {},
    headers: new Headers(),
    model: "sonnet",
    messages: [],
    stream: false,
    workingDirectory: "/tmp",
    ...overrides,
  })
}

describe("runTransformHook", () => {
  it("returns context unchanged when no transforms have the hook", () => {
    const t: Transform = { name: "noop" }
    const ctx = makeCtx()
    const result = runTransformHook([t], "onRequest", ctx, "test")
    expect(result).toEqual(ctx)
  })

  it("chains transforms in order", () => {
    const t1: Transform = {
      name: "first",
      onRequest: (ctx) => ({ ...ctx, model: ctx.model + "-a" }),
    }
    const t2: Transform = {
      name: "second",
      onRequest: (ctx) => ({ ...ctx, model: ctx.model + "-b" }),
    }
    const ctx = makeCtx({ model: "base" })
    const result = runTransformHook([t1, t2], "onRequest", ctx, "test")
    expect(result.model).toBe("base-a-b")
  })

  it("skips transforms scoped to other adapters", () => {
    const t: Transform = {
      name: "opencode-only",
      adapters: ["opencode"],
      onRequest: (ctx) => ({ ...ctx, model: "changed" }),
    }
    const ctx = makeCtx({ model: "original" })
    const result = runTransformHook([t], "onRequest", ctx, "crush")
    expect(result.model).toBe("original")
  })

  it("runs transforms scoped to the matching adapter", () => {
    const t: Transform = {
      name: "opencode-only",
      adapters: ["opencode"],
      onRequest: (ctx) => ({ ...ctx, model: "changed" }),
    }
    const ctx = makeCtx({ model: "original" })
    const result = runTransformHook([t], "onRequest", ctx, "opencode")
    expect(result.model).toBe("changed")
  })

  it("runs transforms with no adapter scope for all adapters", () => {
    const t: Transform = {
      name: "global",
      onRequest: (ctx) => ({ ...ctx, model: "global" }),
    }
    const ctx = makeCtx()
    const result = runTransformHook([t], "onRequest", ctx, "anything")
    expect(result.model).toBe("global")
  })

  it("preserves metadata across transforms", () => {
    const t1: Transform = {
      name: "set-meta",
      onRequest: (ctx) => ({
        ...ctx,
        metadata: { ...ctx.metadata, key: "value" },
      }),
    }
    const t2: Transform = {
      name: "read-meta",
      onRequest: (ctx) => ({
        ...ctx,
        model: ctx.metadata.key === "value" ? "from-meta" : "no-meta",
      }),
    }
    const ctx = makeCtx()
    const result = runTransformHook([t1, t2], "onRequest", ctx, "test")
    expect(result.model).toBe("from-meta")
    expect(result.metadata.key).toBe("value")
  })

  it("does not mutate the original context", () => {
    const t: Transform = {
      name: "mutator",
      onRequest: (ctx) => ({ ...ctx, model: "changed" }),
    }
    const ctx = makeCtx({ model: "original" })
    runTransformHook([t], "onRequest", ctx, "test")
    expect(ctx.model).toBe("original")
  })
})

describe("runObserveHook", () => {
  it("calls all matching transforms", () => {
    const calls: string[] = []
    const t1: Transform = {
      name: "logger1",
      onTelemetry: () => { calls.push("t1") },
    }
    const t2: Transform = {
      name: "logger2",
      onTelemetry: () => { calls.push("t2") },
    }
    const ctx: TelemetryContext = {
      adapter: "test",
      model: "sonnet",
      requestId: "req-1",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: 0,
    }
    runObserveHook([t1, t2], "onTelemetry", ctx, "test")
    expect(calls).toEqual(["t1", "t2"])
  })

  it("skips transforms scoped to other adapters", () => {
    const calls: string[] = []
    const t: Transform = {
      name: "scoped",
      adapters: ["opencode"],
      onTelemetry: () => { calls.push("called") },
    }
    const ctx: TelemetryContext = {
      adapter: "crush",
      model: "sonnet",
      requestId: "req-1",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      cacheHitRate: 0,
    }
    runObserveHook([t], "onTelemetry", ctx, "crush")
    expect(calls).toEqual([])
  })
})

describe("buildPipeline", () => {
  it("orders adapter transforms before plugin transforms", () => {
    const adapter: Transform = { name: "adapter-t" }
    const plugin: Transform = { name: "plugin-t" }
    const pipeline = buildPipeline([adapter], [plugin])
    expect(pipeline.map((t) => t.name)).toEqual(["adapter-t", "plugin-t"])
  })

  it("returns empty array when no transforms", () => {
    expect(buildPipeline([], [])).toEqual([])
  })
})

describe("createRequestContext", () => {
  it("sets defaults for SDK configuration fields", () => {
    const ctx = makeCtx()
    expect(ctx.blockedTools).toEqual([])
    expect(ctx.incompatibleTools).toEqual([])
    expect(ctx.allowedMcpTools).toEqual([])
    expect(ctx.sdkAgents).toEqual({})
    expect(ctx.supportsThinking).toBe(false)
    expect(ctx.shouldTrackFileChanges).toBe(true)
    expect(ctx.leaksCwdViaSystemReminder).toBe(false)
    expect(ctx.metadata).toEqual({})
  })
})
