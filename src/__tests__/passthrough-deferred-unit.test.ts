import { describe, expect, it } from "bun:test"

import {
  createDeferredPassthroughHandler,
  createPassthroughMcpServer,
  type PassthroughDeferredMode,
} from "../proxy/passthroughTools"

// --- Fake deferredMode implementation (test double) -----------------------

interface FakeDeferredHarness {
  mode: PassthroughDeferredMode
  /** Simulate the PreToolUse hook firing for a tool call. */
  recordToolUse: (toolName: string, toolUseId: string) => void
  /** Simulate meridian receiving the client's tool_result and resolving. */
  resolveTool: (toolUseId: string, content: string) => void
  /** Inspect registered pending promises. */
  pending: Map<string, (content: string) => void>
  /** Introspect captured tool_use_ids per tool name. */
  captured: Map<string, string[]>
}

function makeFakeDeferred(): FakeDeferredHarness {
  const captured = new Map<string, string[]>()
  const pending = new Map<string, (content: string) => void>()

  const mode: PassthroughDeferredMode = {
    dequeueToolUseId(toolName: string): string | undefined {
      return captured.get(toolName)?.shift()
    },
    registerPendingExecution(toolUseId: string): Promise<string> {
      return new Promise((resolve) => {
        pending.set(toolUseId, (content: string) => {
          pending.delete(toolUseId)
          resolve(content)
        })
      })
    },
  }

  return {
    mode,
    captured,
    pending,
    recordToolUse(toolName, toolUseId) {
      const q = captured.get(toolName) ?? []
      q.push(toolUseId)
      captured.set(toolName, q)
    },
    resolveTool(toolUseId, content) {
      const resolver = pending.get(toolUseId)
      if (!resolver) throw new Error(`resolveTool: no pending entry for ${toolUseId}`)
      resolver(content)
    },
  }
}

describe("createDeferredPassthroughHandler", () => {
  it("dequeues tool_use_id, registers pending, and returns resolved content", async () => {
    const h = makeFakeDeferred()
    h.recordToolUse("read", "toolu_alpha")
    const handler = createDeferredPassthroughHandler("read", h.mode)

    // Start handler (it will block on registerPendingExecution until we resolve)
    const result = handler()
    await new Promise((r) => setTimeout(r, 5))
    expect(h.pending.has("toolu_alpha")).toBe(true)

    h.resolveTool("toolu_alpha", "hello from the real file")

    const value = await result
    expect(value).toEqual({
      content: [{ type: "text", text: "hello from the real file" }],
    })
    expect(h.pending.size).toBe(0)
  })

  it("dequeues per-tool-name FIFO so parallel tools get the right id", async () => {
    const h = makeFakeDeferred()
    h.recordToolUse("read", "toolu_read_1")
    h.recordToolUse("read", "toolu_read_2")
    h.recordToolUse("size", "toolu_size_1")

    const readHandler = createDeferredPassthroughHandler("read", h.mode)
    const sizeHandler = createDeferredPassthroughHandler("size", h.mode)

    const r1 = readHandler()
    await new Promise((r) => setTimeout(r, 5))
    expect([...h.pending.keys()]).toContain("toolu_read_1")
    h.resolveTool("toolu_read_1", "first read")

    const r2 = readHandler()
    await new Promise((r) => setTimeout(r, 5))
    expect([...h.pending.keys()]).toContain("toolu_read_2")
    h.resolveTool("toolu_read_2", "second read")

    const s1 = sizeHandler()
    await new Promise((r) => setTimeout(r, 5))
    expect([...h.pending.keys()]).toContain("toolu_size_1")
    h.resolveTool("toolu_size_1", "42")

    expect((await r1).content[0]!.text).toBe("first read")
    expect((await r2).content[0]!.text).toBe("second read")
    expect((await s1).content[0]!.text).toBe("42")
  })

  it("throws when the FIFO is empty (PreToolUse / handler coordination broken)", async () => {
    const h = makeFakeDeferred()
    const handler = createDeferredPassthroughHandler("read", h.mode)
    // No recordToolUse call — FIFO is empty.
    await expect(handler()).rejects.toThrow(/no captured tool_use_id/)
  })

  it("propagates registerPendingExecution rejection to the caller", async () => {
    const failingMode: PassthroughDeferredMode = {
      dequeueToolUseId: () => "toolu_x",
      registerPendingExecution: () => Promise.reject(new Error("timeout")),
    }
    const handler = createDeferredPassthroughHandler("read", failingMode)
    await expect(handler()).rejects.toThrow(/timeout/)
  })
})

describe("createPassthroughMcpServer — legacy (no deferredMode)", () => {
  it("registers tools with no-op handlers returning the 'passthrough' sentinel", () => {
    const result = createPassthroughMcpServer([
      { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      { name: "write", description: "Write a file" },
    ])
    expect(result.toolNames.sort()).toEqual(["mcp__oc__read", "mcp__oc__write"].sort())
    expect(result.hasDeferredTools).toBe(false)
  })
})

describe("createPassthroughMcpServer — deferred mode", () => {
  it("builds an MCP server using the provided deferredMode for handlers", () => {
    const h = makeFakeDeferred()
    const result = createPassthroughMcpServer(
      [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
      undefined,
      { deferredMode: h.mode },
    )
    expect(result.toolNames).toEqual(["mcp__oc__read"])
    expect(result.hasDeferredTools).toBe(false)
    // The handler behavior is covered by createDeferredPassthroughHandler tests
    // above (identical code path after the refactor).
  })
})
