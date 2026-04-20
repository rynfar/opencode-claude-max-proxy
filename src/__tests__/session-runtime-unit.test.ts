import { describe, expect, it } from "bun:test"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

import {
  AsyncQueueOverflowError,
  classifyPassthroughRequest,
  consumeRuntimeContinuation,
  createAsyncQueue,
  createMutex,
  createSessionRuntime,
  createSessionRuntimeManager,
  hashReopenCriticalOptions,
  isTurnTerminator,
  markRuntimeContinuation,
} from "../proxy/session/runtime"

describe("AsyncQueue", () => {
  it("delivers pushed values in FIFO order to a single reader", async () => {
    const q = createAsyncQueue<number>()
    q.push(1); q.push(2); q.push(3); q.close()
    const seen: number[] = []
    for await (const v of q) seen.push(v)
    expect(seen).toEqual([1, 2, 3])
  })

  it("resolves a pending reader when a value is pushed later", async () => {
    const q = createAsyncQueue<string>()
    const it = q[Symbol.asyncIterator]()
    const pending = it.next()
    q.push("later")
    const result = await pending
    expect(result).toEqual({ value: "later", done: false })
  })

  it("terminates pending readers on close()", async () => {
    const q = createAsyncQueue<number>()
    const it = q[Symbol.asyncIterator]()
    const pending = it.next()
    q.close()
    const result = await pending
    expect(result.done).toBe(true)
  })

  it("ignores push after close()", async () => {
    const q = createAsyncQueue<number>()
    q.close()
    q.push(42)
    const it = q[Symbol.asyncIterator]()
    const result = await it.next()
    expect(result.done).toBe(true)
  })

  it("fires onHighWater when depth crosses the soft threshold", () => {
    const depths: number[] = []
    const q = createAsyncQueue<number>({ highWaterMark: 2, onHighWater: (d) => depths.push(d) })
    q.push(1)
    q.push(2)
    expect(depths).toEqual([]) // at threshold but not over
    q.push(3)
    expect(depths).toEqual([3]) // fires once as depth crosses 2→3
    q.push(4)
    expect(depths).toEqual([3]) // doesn't re-fire while sustained above
  })

  it("re-fires onHighWater after depth drops back below the threshold and re-crosses", async () => {
    const depths: number[] = []
    const q = createAsyncQueue<number>({ highWaterMark: 1, onHighWater: (d) => depths.push(d) })
    q.push(1); q.push(2) // depth=2, crosses 1→2, fires
    expect(depths).toEqual([2])
    const it = q[Symbol.asyncIterator]()
    await it.next(); await it.next() // drain back to depth 0
    q.push(3); q.push(4) // depth=2 again, re-fires
    expect(depths).toEqual([2, 2])
  })

  it("throws AsyncQueueOverflowError when pushing past hardCap", () => {
    const q = createAsyncQueue<number>({ hardCap: 2 })
    q.push(1); q.push(2)
    expect(() => q.push(3)).toThrow(AsyncQueueOverflowError)
    try {
      q.push(4)
    } catch (err) {
      if (err instanceof AsyncQueueOverflowError) {
        expect(err.hardCap).toBe(2)
      }
    }
  })

  it("exposes current depth via readonly getter", () => {
    const q = createAsyncQueue<number>()
    expect(q.depth).toBe(0)
    q.push(1); q.push(2); q.push(3)
    expect(q.depth).toBe(3)
  })
})

describe("Mutex", () => {
  it("serializes concurrent acquires", async () => {
    const mutex = createMutex()
    const order: number[] = []
    const run = async (id: number) => {
      const release = await mutex.acquire()
      order.push(id)
      await new Promise((r) => setTimeout(r, 5))
      order.push(-id)
      release()
    }
    await Promise.all([run(1), run(2), run(3)])
    expect(order).toEqual([1, -1, 2, -2, 3, -3])
  })

  it("rejects when acquire times out", async () => {
    const mutex = createMutex()
    const release = await mutex.acquire()
    await expect(mutex.acquire(10)).rejects.toThrow(/timed out/)
    release()
  })

  it("allows new acquires after a timed-out waiter releases", async () => {
    const mutex = createMutex()
    const release = await mutex.acquire()
    await expect(mutex.acquire(10)).rejects.toThrow()
    release()
    const release2 = await mutex.acquire(50)
    release2()
  })
})

describe("hashReopenCriticalOptions", () => {
  it("produces a stable hash regardless of key order", () => {
    const a = hashReopenCriticalOptions({ cwd: "/a", systemPrompt: "x", allowedTools: ["b", "a"] })
    const b = hashReopenCriticalOptions({ allowedTools: ["a", "b"], systemPrompt: "x", cwd: "/a" })
    expect(a).toBe(b)
  })

  it("changes when any reopen-critical field changes", () => {
    const base = hashReopenCriticalOptions({ cwd: "/a", systemPrompt: "x" })
    expect(hashReopenCriticalOptions({ cwd: "/b", systemPrompt: "x" })).not.toBe(base)
    expect(hashReopenCriticalOptions({ cwd: "/a", systemPrompt: "y" })).not.toBe(base)
    expect(hashReopenCriticalOptions({ cwd: "/a", systemPrompt: "x", allowedTools: ["t"] })).not.toBe(base)
  })

  it("treats empty and undefined arrays as equivalent", () => {
    const a = hashReopenCriticalOptions({ cwd: "/a", allowedTools: [] })
    const b = hashReopenCriticalOptions({ cwd: "/a" })
    expect(a).toBe(b)
  })

  it("returns a 16-char hex digest", () => {
    const h = hashReopenCriticalOptions({ cwd: "/a" })
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("isTurnTerminator", () => {
  it("recognizes the result event as the terminator", () => {
    expect(isTurnTerminator({ type: "result" } as unknown as SDKMessage)).toBe(true)
  })

  it("does not treat other events as terminators", () => {
    expect(isTurnTerminator({ type: "assistant" } as unknown as SDKMessage)).toBe(false)
    expect(isTurnTerminator({ type: "system" } as unknown as SDKMessage)).toBe(false)
    expect(isTurnTerminator({ type: "rate_limit_event" } as unknown as SDKMessage)).toBe(false)
  })
})

// Minimal fake Query for runtime/manager tests.
function fakeQuery(messages: SDKMessage[] = [], closeFn?: () => void): Query {
  async function* gen() { for (const m of messages) yield m }
  const g = gen() as unknown as Query
  ;(g as unknown as { close: () => void }).close = closeFn ?? (() => {})
  return g
}

describe("SessionRuntime", () => {
  it("yields events until the turn terminator", async () => {
    const events: SDKMessage[] = [
      { type: "system", subtype: "init" } as unknown as SDKMessage,
      { type: "assistant" } as unknown as SDKMessage,
      { type: "result", subtype: "success", session_id: "sid-abc" } as unknown as SDKMessage,
      { type: "assistant" } as unknown as SDKMessage, // should NOT be yielded
    ]
    const runtime = createSessionRuntime({
      profileSessionId: "p1",
      optionsHash: "h1",
      query: fakeQuery(events),
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
    const yielded: SDKMessage[] = []
    for await (const m of runtime.consumeTurn()) yielded.push(m)
    expect(yielded.length).toBe(3)
    expect(yielded[yielded.length - 1]!.type).toBe("result")
    expect(runtime.claudeSessionId).toBe("sid-abc")
  })

  it("serializes pushTurn via acquireTurn", async () => {
    const q1 = createAsyncQueue<SDKUserMessage>()
    const runtime = createSessionRuntime({
      profileSessionId: "p1",
      optionsHash: "h1",
      query: fakeQuery([]),
      inputQueue: q1,
    })
    const r1 = await runtime.acquireTurn()
    await expect(runtime.acquireTurn(10)).rejects.toThrow(/timed out/)
    r1()
    const r2 = await runtime.acquireTurn(50)
    r2()
  })

  it("close() terminates the query and input queue", async () => {
    let queryClosed = false
    const q = createAsyncQueue<SDKUserMessage>()
    const runtime = createSessionRuntime({
      profileSessionId: "p1",
      optionsHash: "h1",
      query: fakeQuery([], () => { queryClosed = true }),
      inputQueue: q,
    })
    await runtime.close()
    expect(runtime.closed).toBe(true)
    expect(queryClosed).toBe(true)
    expect(q.closed).toBe(true)
  })

  it("acquireTurn after close throws", async () => {
    const runtime = createSessionRuntime({
      profileSessionId: "p1",
      optionsHash: "h1",
      query: fakeQuery([]),
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
    await runtime.close()
    await expect(runtime.acquireTurn()).rejects.toThrow(/closed/)
  })
})

describe("classifyPassthroughRequest", () => {
  it("diverts matching tool_result blocks to resolve and strips them from pushContent", () => {
    const content = [
      { type: "tool_result", tool_use_id: "toolu_1", content: "hello world" },
      { type: "tool_result", tool_use_id: "toolu_2", content: "second output" },
    ]
    const result = classifyPassthroughRequest(content, new Set(["toolu_1", "toolu_2"]))
    expect(result.resolve).toEqual([
      { toolUseId: "toolu_1", content: "hello world" },
      { toolUseId: "toolu_2", content: "second output" },
    ])
    expect(result.pushContent).toBeNull()
  })

  it("routes unmatched tool_result blocks to the prebind bucket (not pushContent)", () => {
    // Parallel-tool case: client returns with both tool_results in one
    // request but only the first handler has registered as pending. The
    // second result must be prebound so the later-firing handler resolves
    // from the buffer. Pushing it as a user message would deadlock the SDK.
    const content = [
      { type: "tool_result", tool_use_id: "toolu_1", content: "resolved" },
      { type: "tool_result", tool_use_id: "toolu_unknown", content: "orphaned" },
    ]
    const result = classifyPassthroughRequest(content, new Set(["toolu_1"]))
    expect(result.resolve).toEqual([{ toolUseId: "toolu_1", content: "resolved" }])
    expect(result.prebind).toEqual([{ toolUseId: "toolu_unknown", content: "orphaned" }])
    expect(result.pushContent).toBeNull()
  })

  it("preserves non-tool_result blocks (text, images) in pushContent", () => {
    const content = [
      { type: "text", text: "look at this" },
      { type: "tool_result", tool_use_id: "toolu_1", content: "result text" },
      { type: "image", source: { type: "base64", data: "..." } },
    ]
    const result = classifyPassthroughRequest(content, new Set(["toolu_1"]))
    expect(result.resolve).toEqual([{ toolUseId: "toolu_1", content: "result text" }])
    expect(result.pushContent).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", source: { type: "base64", data: "..." } },
    ])
  })

  it("flattens tool_result block-array content by joining text subblocks", () => {
    const content = [
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ]
    const result = classifyPassthroughRequest(content, new Set(["toolu_1"]))
    expect(result.resolve).toEqual([{ toolUseId: "toolu_1", content: "line one\nline two" }])
  })

  it("wraps a plain string user content into a single-element push array", () => {
    const result = classifyPassthroughRequest("hello", new Set(["toolu_1"]))
    expect(result.resolve).toEqual([])
    expect(result.pushContent).toEqual(["hello"])
  })

  it("wraps a non-array object user content into a single-element push array", () => {
    // §3.15: previously returned `pushContent: []` which silently lost the
    // payload. The fix wraps non-array non-null content in a one-element
    // array so the push survives. tool_result correlation does NOT happen
    // for the non-array shape — only the canonical content-block array
    // carries `tool_use_id` blocks the classifier knows how to resolve.
    const block = { type: "text", text: "hello" }
    const result = classifyPassthroughRequest(block, new Set(["toolu_1"]))
    expect(result.resolve).toEqual([])
    expect(result.pushContent).toEqual([block])
  })

  it("returns null pushContent for null / undefined user content", () => {
    const fromNull = classifyPassthroughRequest(null, new Set(["toolu_1"]))
    expect(fromNull.resolve).toEqual([])
    expect(fromNull.pushContent).toBeNull()

    const fromUndef = classifyPassthroughRequest(undefined, new Set(["toolu_1"]))
    expect(fromUndef.resolve).toEqual([])
    expect(fromUndef.pushContent).toBeNull()
  })

  it("routes tool_result blocks to prebind when pending set is empty", () => {
    const content = [{ type: "tool_result", tool_use_id: "toolu_1", content: "x" }]
    const result = classifyPassthroughRequest(content, new Set())
    expect(result.resolve).toEqual([])
    expect(result.prebind).toEqual([{ toolUseId: "toolu_1", content: "x" }])
    expect(result.pushContent).toBeNull()
  })
})

describe("SessionRuntime — pending executions", () => {
  function emptyRuntime() {
    return createSessionRuntime({
      profileSessionId: "p1",
      optionsHash: "h",
      query: (async function* () { /* empty */ })() as unknown as Query,
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
  }

  it("registerPendingExecution returns a promise that resolves via resolvePendingExecution", async () => {
    const runtime = emptyRuntime()
    const resultPromise = runtime.registerPendingExecution("toolu_abc")
    expect(runtime.pendingCount).toBe(1)
    expect(runtime.pendingToolUseIds.has("toolu_abc")).toBe(true)
    const hit = runtime.resolvePendingExecution("toolu_abc", "file contents")
    expect(hit).toBe(true)
    const content = await resultPromise
    expect(content).toBe("file contents")
    expect(runtime.pendingCount).toBe(0)
  })

  it("rejectPendingExecution throws the rejection into the awaiting caller", async () => {
    const runtime = emptyRuntime()
    const resultPromise = runtime.registerPendingExecution("toolu_abc")
    const caught = resultPromise.catch((e) => e)
    const hit = runtime.rejectPendingExecution("toolu_abc", new Error("timeout"))
    expect(hit).toBe(true)
    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timeout/)
    expect(runtime.pendingCount).toBe(0)
  })

  it("resolve/reject return false for unknown tool_use_ids", () => {
    const runtime = emptyRuntime()
    expect(runtime.resolvePendingExecution("toolu_missing", "x")).toBe(false)
    expect(runtime.rejectPendingExecution("toolu_missing", new Error())).toBe(false)
  })

  it("rejectAllPending rejects every pending entry and returns the count", async () => {
    const runtime = emptyRuntime()
    const p1 = runtime.registerPendingExecution("toolu_1")
    const p2 = runtime.registerPendingExecution("toolu_2")
    // Pre-attach rejection handlers so synchronous reject inside rejectAllPending
    // doesn't fire an unhandled-rejection warning between now and the awaits.
    const p1Caught = p1.catch((e) => e)
    const p2Caught = p2.catch((e) => e)
    expect(runtime.pendingCount).toBe(2)
    const count = runtime.rejectAllPending(new Error("shutdown"))
    expect(count).toBe(2)
    expect(runtime.pendingCount).toBe(0)
    await expect(p1Caught).resolves.toBeInstanceOf(Error)
    await expect(p2Caught).resolves.toBeInstanceOf(Error)
    expect((await p1Caught as Error).message).toMatch(/shutdown/)
    expect((await p2Caught as Error).message).toMatch(/shutdown/)
  })

  it("close() rejects all pending handlers so the SDK unblocks", async () => {
    const runtime = emptyRuntime()
    const pending = runtime.registerPendingExecution("toolu_abc")
    const caught = pending.catch((e) => e)
    await runtime.close()
    const result = await caught
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/closed/)
    expect(runtime.pendingCount).toBe(0)
  })

  it("registerPendingExecution on a closed runtime throws", async () => {
    const runtime = emptyRuntime()
    await runtime.close()
    await expect(runtime.registerPendingExecution("toolu_abc")).rejects.toThrow(/closed/)
  })

  it("rejects a pending handler after the configured idle timeout (§5.12f)", async () => {
    const runtime = createSessionRuntime({
      profileSessionId: "p1",
      query: (async function* () { /* empty */ })() as unknown as Query,
      inputQueue: createAsyncQueue<SDKUserMessage>(),
      pendingExecutionTimeoutMs: 20,
    })
    const pending = runtime.registerPendingExecution("toolu_abc")
    const err = await pending.catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/timed out after 20ms/)
    expect(runtime.pendingCount).toBe(0)
  })

  it("does NOT arm an idle timeout when pendingExecutionTimeoutMs is unset (default = infinity)", async () => {
    const runtime = createSessionRuntime({
      profileSessionId: "p1",
      query: (async function* () { /* empty */ })() as unknown as Query,
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
    const pending = runtime.registerPendingExecution("toolu_abc")
    const racer = Promise.race([
      pending.then(() => "resolved"),
      new Promise<string>((r) => setTimeout(() => r("timeout-wait"), 30)),
    ])
    const outcome = await racer
    expect(outcome).toBe("timeout-wait") // still pending; no timeout fired
    // cleanup: resolve so the dangling promise doesn't warn on test exit
    runtime.resolvePendingExecution("toolu_abc", "x")
    await pending
  })
})

describe("SessionRuntime — prebound tool_result buffer", () => {
  function emptyRuntime() {
    return createSessionRuntime({
      profileSessionId: "p1",
      query: (async function* () { /* empty */ })() as unknown as Query,
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
  }

  it("prebindPendingResult followed by registerPendingExecution resolves synchronously from the buffer", async () => {
    const runtime = emptyRuntime()
    runtime.prebindPendingResult("toolu_B", "payload-B")
    expect(runtime.prebindCount).toBe(1)

    const result = runtime.registerPendingExecution("toolu_B")
    // The handler must never enter the pending registry — it drains the
    // buffer synchronously.
    expect(runtime.pendingCount).toBe(0)
    expect(runtime.prebindCount).toBe(0)
    expect(await result).toBe("payload-B")
  })

  it("prebindPendingResult resolves an already-registered handler immediately (reverse-order race)", async () => {
    const runtime = emptyRuntime()
    const pending = runtime.registerPendingExecution("toolu_A")
    expect(runtime.pendingCount).toBe(1)
    runtime.prebindPendingResult("toolu_A", "payload-A")
    expect(await pending).toBe("payload-A")
    expect(runtime.pendingCount).toBe(0)
    expect(runtime.prebindCount).toBe(0)
  })

  it("close() clears the prebound buffer", async () => {
    const runtime = emptyRuntime()
    runtime.prebindPendingResult("toolu_X", "gone")
    expect(runtime.prebindCount).toBe(1)
    await runtime.close()
    expect(runtime.prebindCount).toBe(0)
  })

  it("prebindPendingResult on a closed runtime is a no-op (does not throw)", async () => {
    const runtime = emptyRuntime()
    await runtime.close()
    runtime.prebindPendingResult("toolu_X", "gone")
    expect(runtime.prebindCount).toBe(0)
  })

  it("supports the parallel-tool flow end-to-end (resolve first, prebind second)", async () => {
    // Mirrors the real E/F shape: when turn-2's batched tool_results arrive,
    // the first handler is already pending, the second hasn't fired yet.
    const runtime = emptyRuntime()
    const pendingA = runtime.registerPendingExecution("toolu_A")

    // Client returns both tool_results in one batch — meridian classifies
    // and resolves A immediately, prebinds B.
    const resolvedA = runtime.resolvePendingExecution("toolu_A", "alpha")
    runtime.prebindPendingResult("toolu_B", "beta")
    expect(resolvedA).toBe(true)
    expect(await pendingA).toBe("alpha")

    // The SDK later fires handler B; it drains the buffer synchronously.
    const pendingB = runtime.registerPendingExecution("toolu_B")
    expect(await pendingB).toBe("beta")
    expect(runtime.pendingCount).toBe(0)
    expect(runtime.prebindCount).toBe(0)
  })
})

describe("SessionRuntime — tool_use_id FIFO", () => {
  function emptyRuntime() {
    return createSessionRuntime({
      profileSessionId: "p1",
      optionsHash: "h",
      query: (async function* () { /* empty */ })() as unknown as Query,
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
  }

  it("dequeues ids in FIFO order per tool name", () => {
    const runtime = emptyRuntime()
    runtime.enqueueToolUseId("read", "toolu_1")
    runtime.enqueueToolUseId("read", "toolu_2")
    runtime.enqueueToolUseId("read", "toolu_3")
    expect(runtime.dequeueToolUseId("read")).toBe("toolu_1")
    expect(runtime.dequeueToolUseId("read")).toBe("toolu_2")
    expect(runtime.dequeueToolUseId("read")).toBe("toolu_3")
    expect(runtime.dequeueToolUseId("read")).toBeUndefined()
  })

  it("keeps queues per tool name isolated", () => {
    const runtime = emptyRuntime()
    runtime.enqueueToolUseId("read", "r1")
    runtime.enqueueToolUseId("write", "w1")
    runtime.enqueueToolUseId("read", "r2")
    expect(runtime.dequeueToolUseId("read")).toBe("r1")
    expect(runtime.dequeueToolUseId("write")).toBe("w1")
    expect(runtime.dequeueToolUseId("read")).toBe("r2")
  })

  it("returns undefined for an unknown tool name", () => {
    const runtime = emptyRuntime()
    expect(runtime.dequeueToolUseId("read")).toBeUndefined()
  })
})

describe("SessionRuntimeManager", () => {
  function makeRuntime(id: string, lastActivity: number) {
    const runtime = createSessionRuntime({
      profileSessionId: id,
      optionsHash: "h",
      query: fakeQuery([]),
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
    runtime.lastActivity = lastActivity
    return runtime
  }

  it("put/get roundtrip", () => {
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 4 })
    const r = makeRuntime("a", Date.now())
    mgr.put(r)
    expect(mgr.get("a")).toBe(r)
  })

  it("drop closes and removes the runtime", async () => {
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 4 })
    const r = makeRuntime("a", Date.now())
    mgr.put(r)
    await mgr.drop("a")
    expect(mgr.get("a")).toBeUndefined()
    expect(r.closed).toBe(true)
  })

  it("hard cap evicts the LRU entry and closes it", async () => {
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 2 })
    const a = makeRuntime("a", Date.now())
    const b = makeRuntime("b", Date.now())
    const c = makeRuntime("c", Date.now())
    mgr.put(a)
    mgr.put(b)
    mgr.put(c) // evicts "a"
    await new Promise((r) => setTimeout(r, 5))
    expect(mgr.get("a")).toBeUndefined()
    expect(a.closed).toBe(true)
    expect(mgr.get("b")).toBe(b)
    expect(mgr.get("c")).toBe(c)
  })

  it("sweepIdle evicts runtimes older than the idle cutoff", async () => {
    let clock = 1_000_000
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 4, now: () => clock })
    const fresh = makeRuntime("fresh", clock - 100)
    const stale = makeRuntime("stale", clock - 2000)
    mgr.put(fresh)
    mgr.put(stale)
    const evicted = await mgr.sweepIdle()
    expect(evicted).toBe(1)
    expect(mgr.get("stale")).toBeUndefined()
    expect(mgr.get("fresh")).toBe(fresh)
    expect(stale.closed).toBe(true)
  })

  it("emits lifecycle events + bumps counters (§7.2/§7.3)", async () => {
    const events: Array<{ e: string; id: string }> = []
    const mgr = createSessionRuntimeManager({
      idleMs: 1000, maxLive: 4,
      onLifecycle: (e, id) => events.push({ e, id }),
    })
    const a = makeRuntime("a", Date.now())
    mgr.put(a)
    expect(mgr.counters.creates).toBe(1)
    expect(mgr.counters.live).toBe(1)
    expect(events).toEqual([{ e: "create", id: "a" }])

    mgr.put(a) // re-put same key → reattach, not create
    expect(mgr.counters.creates).toBe(1)
    expect(events[events.length - 1]).toEqual({ e: "reattach", id: "a" })

    await mgr.drop("a")
    expect(mgr.counters.live).toBe(0)
    expect(events[events.length - 1]).toEqual({ e: "close", id: "a" })

    const b = makeRuntime("b", Date.now() - 10_000)
    mgr.put(b)
    await mgr.sweepIdle()
    expect(mgr.counters.evictions).toBe(1)
  })

  it("sweepIdle skips stale runtimes whose turn mutex is currently held (§3.12)", async () => {
    let clock = 1_000_000
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 4, now: () => clock })
    const busyStale = makeRuntime("busy", clock - 2000)
    const idleStale = makeRuntime("idle", clock - 2000)
    mgr.put(busyStale)
    mgr.put(idleStale)

    // Hold the busy runtime's turn mutex — simulates an in-flight turn.
    const release = await busyStale.acquireTurn()
    try {
      const evicted = await mgr.sweepIdle()
      expect(evicted).toBe(1)
      expect(mgr.get("idle")).toBeUndefined()
      expect(mgr.get("busy")).toBe(busyStale) // still alive
      expect(busyStale.closed).toBe(false)
      expect(idleStale.closed).toBe(true)
    } finally {
      release()
    }

    // Now that the mutex is released, a second sweep collects the busy one.
    const evicted2 = await mgr.sweepIdle()
    expect(evicted2).toBe(1)
    expect(mgr.get("busy")).toBeUndefined()
    expect(busyStale.closed).toBe(true)
  })

  it("closeAll closes every runtime and empties the map", async () => {
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 4 })
    const a = makeRuntime("a", Date.now())
    const b = makeRuntime("b", Date.now())
    mgr.put(a); mgr.put(b)
    await mgr.closeAll()
    expect(mgr.size).toBe(0)
    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
  })

  it("get returns undefined if the runtime was closed externally", async () => {
    const mgr = createSessionRuntimeManager({ idleMs: 1000, maxLive: 4 })
    const r = makeRuntime("a", Date.now())
    mgr.put(r)
    await r.close()
    expect(mgr.get("a")).toBeUndefined()
  })
})

describe("Continuation-after-pending flags (§5.12d)", () => {
  function emptyRuntime() {
    return createSessionRuntime({
      profileSessionId: "p1",
      query: (async function* () { /* empty */ })() as unknown as Query,
      inputQueue: createAsyncQueue<SDKUserMessage>(),
    })
  }

  it("consumeRuntimeContinuation returns false on an unflagged runtime", () => {
    const r = emptyRuntime()
    expect(consumeRuntimeContinuation(r)).toBe(false)
  })

  it("markRuntimeContinuation sets the flag so the next consume returns true once, then false", () => {
    const r = emptyRuntime()
    markRuntimeContinuation(r)
    expect(consumeRuntimeContinuation(r)).toBe(true)
    // second call — flag is consumed, returns false
    expect(consumeRuntimeContinuation(r)).toBe(false)
  })

  it("two runtimes have independent flags", () => {
    const a = emptyRuntime()
    const b = emptyRuntime()
    markRuntimeContinuation(a)
    expect(consumeRuntimeContinuation(b)).toBe(false)
    expect(consumeRuntimeContinuation(a)).toBe(true)
  })

  it("re-marking after consume resets the flag for the next request cycle", () => {
    const r = emptyRuntime()
    markRuntimeContinuation(r)
    consumeRuntimeContinuation(r)
    markRuntimeContinuation(r)
    expect(consumeRuntimeContinuation(r)).toBe(true)
  })
})
