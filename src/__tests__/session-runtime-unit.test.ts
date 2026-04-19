import { describe, expect, it } from "bun:test"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"

import {
  createAsyncQueue,
  createMutex,
  createSessionRuntime,
  createSessionRuntimeManager,
  hashReopenCriticalOptions,
  isTurnTerminator,
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
