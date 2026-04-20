/**
 * E/F Layer-2 repro — mirrors meridian's exact persistent-mode flow for
 * parallel passthrough tools in one assistant message.
 *
 * Meridian (real flow) on parallel tool_use in one assistant message:
 *   1. Turn 1 prompt pushed.
 *   2. Model emits assistant msg with tool_use blocks A, B.
 *   3. PreToolUse fires for A → hook enqueues id_A. MCP handler A fires →
 *      dequeues id_A → registerPendingExecution(id_A) → AWAITS an external
 *      signal that never arrives inside turn 1.
 *   4. Handler B does NOT fire yet (SDK fires handlers sequentially).
 *   5. Meridian's turnRunner observes tool_use + pendingCount > 0 and
 *      synthesizes a pause; client sees both tool_uses in its SSE stream
 *      and closes.
 *   6. Client runs both tools locally; returns in turn 2 with both
 *      tool_results in one request.
 *
 * Currently meridian:
 *   - Classifies incoming content against `pendingToolUseIds` which at this
 *     moment contains ONLY id_A (handler B hasn't fired yet).
 *   - Resolves id_A via handler A's promise; routes id_B's tool_result into
 *     `pushContent` as a new user message.
 *   - Handler A returns. SDK calls handler B. Handler B calls
 *     registerPendingExecution(id_B) and awaits. There is no signal that
 *     will resolve id_B. The pushed user message `[tool_result: id_B]` is
 *     in the streaming-input queue but the SDK is blocked on handler B and
 *     does not consume the queue. Deadlock; the stream "hangs" → empty
 *     continuation response (the observed Layer 2 symptom).
 *
 * This script validates two fix strategies head-to-head on the same live
 * SDK subprocess:
 *
 *   CURRENT  — behaves like today's meridian (resolve known pending, push
 *              unknown as user message). Expectation: hang → empty text.
 *   BUFFERED — buffers unmatched tool_result content in a "prebound" map;
 *              when handler B later registers, it is resolved immediately
 *              from the buffer. Expectation: final assistant text arrives.
 *
 * Every other variable is held constant between runs (same prompt, same
 * file fixtures, same two tool names). Determinism is improved by using
 * the non-streaming path inside the spike harness — we drain SDK events
 * serially with manual `.next()` like meridian's consumeTurn.
 *
 * Run:
 *   bun run spike/e-f-repro.ts
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { readFileSync } from "node:fs"

const MODEL = process.env.SPIKE_MODEL ?? "claude-sonnet-4-5"
const FILE_PATH = "/tmp/pi-spike-alpha.txt"
const TIMEOUT_MS = Number(process.env.SPIKE_TIMEOUT_MS ?? 20_000)

// --- Harness primitives ---------------------------------------------------

function createInputQueue<T>() {
  const buffer: T[] = []
  const waiters: Array<(v: IteratorResult<T>) => void> = []
  let closed = false
  return {
    push(v: T) {
      const w = waiters.shift()
      if (w) w({ value: v, done: false })
      else buffer.push(v)
    },
    close() {
      closed = true
      while (waiters.length) waiters.shift()!({ value: undefined as unknown as T, done: true })
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => new Promise((resolve) => {
          if (buffer.length) resolve({ value: buffer.shift()!, done: false })
          else if (closed) resolve({ value: undefined as unknown as T, done: true })
          else waiters.push(resolve)
        }),
      }
    },
  }
}

const userText = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
})

const userToolResult = (toolUseId: string, content: string): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  },
  parent_tool_use_id: null,
})

// --- Runtime that mirrors meridian's SessionRuntime, minus the HTTP layer -

interface PendingEntry { resolve: (s: string) => void; reject: (e: unknown) => void }

function createMeridianLike(opts: { buffered: boolean }) {
  /** Per-tool-name FIFO populated by PreToolUse hook. */
  const fifo = new Map<string, string[]>()
  /** Currently awaiting pending handlers keyed by tool_use_id. */
  const pending = new Map<string, PendingEntry>()
  /** Prebound content awaiting a handler to register — only in BUFFERED mode. */
  const prebound = new Map<string, string>()

  return {
    get pendingCount() { return pending.size },
    get pendingToolUseIds(): ReadonlySet<string> { return new Set(pending.keys()) },
    enqueueToolUseId(toolName: string, id: string) {
      const q = fifo.get(toolName) ?? []
      q.push(id)
      fifo.set(toolName, q)
    },
    dequeueToolUseId(toolName: string): string | undefined {
      const q = fifo.get(toolName)
      if (!q || !q.length) return undefined
      const id = q.shift()
      if (!q.length) fifo.delete(toolName)
      return id
    },
    registerPendingExecution(id: string): Promise<string> {
      // BUFFERED mode: if content was already prebound, resolve immediately.
      if (opts.buffered) {
        const buffered = prebound.get(id)
        if (buffered !== undefined) {
          prebound.delete(id)
          return Promise.resolve(buffered)
        }
      }
      return new Promise<string>((resolve, reject) => {
        pending.set(id, {
          resolve: (s) => { pending.delete(id); resolve(s) },
          reject: (e) => { pending.delete(id); reject(e) },
        })
      })
    },
    resolvePending(id: string, content: string): boolean {
      const e = pending.get(id)
      if (!e) return false
      e.resolve(content)
      return true
    },
    /** BUFFERED-only: store content for a handler that hasn't registered yet. */
    bufferUnmatched(id: string, content: string) {
      prebound.set(id, content)
    },
  }
}

// --- Shared query setup ---------------------------------------------------

function buildQueryWith(opts: { buffered: boolean }) {
  const input = createInputQueue<SDKUserMessage>()
  const rt = createMeridianLike(opts)

  const makeHandler = (toolName: string) => async () => {
    const id = rt.dequeueToolUseId(toolName)
    if (!id) throw new Error(`no captured tool_use_id for ${toolName}`)
    const result = await rt.registerPendingExecution(id)
    return { content: [{ type: "text" as const, text: result }] }
  }

  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool("read", "Read a file and return its contents.", { path: z.string() }, makeHandler("read")),
      tool("size", "Return the size of a file in bytes.", { path: z.string() }, makeHandler("size")),
    ],
  })

  const sdkOptions: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read", "mcp__spike__size"],
    hooks: {
      PreToolUse: [{
        matcher: "",
        hooks: [async (input: any) => {
          if (input.tool_name === "ToolSearch") return {}
          // Strip `mcp__spike__` prefix like meridian's stripMcpPrefix does.
          const bare = typeof input.tool_name === "string"
            ? input.tool_name.replace(/^mcp__[^_]+__/, "")
            : input.tool_name
          if (typeof bare === "string" && typeof input.tool_use_id === "string") {
            rt.enqueueToolUseId(bare, input.tool_use_id)
          }
          return {}
        }],
      }],
    },
  }

  const q = query({ prompt: input, options: sdkOptions })
  return { q, input, rt }
}

// --- The test ------------------------------------------------------------

interface RunResult {
  label: string
  turn1ToolUses: Array<{ id: string; name: string; input: unknown }>
  turn2Text: string
  turn2StopReason: string | null
  turn2CacheRead: number
  turn2CacheCreate: number
  turn2ResultSeen: boolean
  turn2Timeout: boolean
  notes: string[]
}

async function runCase(buffered: boolean): Promise<RunResult> {
  const label = buffered ? "BUFFERED" : "CURRENT"
  console.log(`\n━━━ ${label} ━━━`)
  const { q, input, rt } = buildQueryWith({ buffered })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>

  const realContent = readFileSync(FILE_PATH, "utf8").trim()
  const realSize = Buffer.byteLength(readFileSync(FILE_PATH), "utf8").toString()

  const turn1ToolUses: Array<{ id: string; name: string; input: unknown }> = []
  const notes: string[] = []

  // --- Turn 1: push prompt, consume until the assistant msg that contains
  //     the parallel tool_uses finishes streaming AND handler A has blocked.
  input.push(userText(
    `Call BOTH tools in parallel on ${FILE_PATH} IN A SINGLE ASSISTANT MESSAGE: ` +
    `one tool_use for read, one tool_use for size. Do NOT wait for the first result. ` +
    `After both come back, reply with exactly two words joined by a dash: the first word of the file, then the size in bytes.`,
  ))

  // We stop consuming once the assistant message containing both tool_use
  // blocks has been yielded AND pendingCount > 0. This matches meridian's
  // turnRunner synthetic-pause condition.
  let sawAssistantWithTools = false
  while (true) {
    const step = await iter.next()
    if (step.done) { notes.push("iterator.done before turn-1 pause"); break }
    const m = step.value
    if ((m as any).type === "assistant") {
      const content = (m as any).message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === "tool_use") {
            turn1ToolUses.push({ id: b.id, name: b.name, input: b.input })
            sawAssistantWithTools = true
          }
        }
      }
    }
    // Break once we've seen the assistant msg AND at least one handler has
    // registered pending. (Handler B will still be un-fired because the
    // SDK fires handlers sequentially.)
    if (sawAssistantWithTools && rt.pendingCount > 0) {
      notes.push(`turn-1 pause: tool_uses=${turn1ToolUses.length} pending=${rt.pendingCount}`)
      break
    }
    if ((m as any).type === "result") {
      notes.push(`turn-1 unexpectedly terminated at 'result' before pending`)
      break
    }
  }

  // Bare-name form so we can log without leaking the mcp__spike__ prefix.
  console.log(`  turn1 tool_uses: ${turn1ToolUses.map(t => `${t.name.replace(/^mcp__[^_]+__/, "")}#${t.id}`).join(", ")}`)
  console.log(`  turn1 pending: ${[...rt.pendingToolUseIds].join(",")}`)

  if (turn1ToolUses.length < 2) {
    notes.push("model only emitted 1 tool_use; skipping turn 2")
    return { label, turn1ToolUses, turn2Text: "", turn2StopReason: null, turn2CacheRead: 0, turn2CacheCreate: 0, turn2ResultSeen: false, turn2Timeout: false, notes }
  }

  // --- Turn 2: simulate meridian receiving both tool_results in one HTTP
  //     request. Route them per the two approaches under test.
  //
  // Map turn1 tool_use ids to real content.
  const resultsById = new Map<string, string>()
  for (const tu of turn1ToolUses) {
    if (tu.name.endsWith("read")) resultsById.set(tu.id, realContent)
    else if (tu.name.endsWith("size")) resultsById.set(tu.id, realSize)
  }

  // Classify: which ids are currently pending vs. orphans?
  const incoming = [...resultsById.entries()]
  for (const [id, content] of incoming) {
    if (rt.pendingToolUseIds.has(id)) {
      rt.resolvePending(id, content)
      notes.push(`resolved pending ${id}`)
    } else {
      if (buffered) {
        rt.bufferUnmatched(id, content)
        notes.push(`buffered unmatched ${id}`)
      } else {
        // CURRENT mode: push as user message (today's meridian behavior).
        input.push(userToolResult(id, content))
        notes.push(`pushed unmatched ${id} as user msg`)
      }
    }
  }

  // --- Drain turn 2. Watch for text content, stop_reason, and result.
  //     Timeout so a hung run doesn't wedge the whole spike.
  let turn2Text = ""
  let turn2StopReason: string | null = null
  let turn2CacheRead = 0
  let turn2CacheCreate = 0
  let turn2ResultSeen = false
  let turn2Timeout = false

  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS))
  const drain = (async () => {
    while (true) {
      const step = await iter.next()
      if (step.done) { notes.push("iterator.done in turn 2"); break }
      const m = step.value
      if ((m as any).type === "assistant") {
        const c = (m as any).message?.content
        if (Array.isArray(c)) for (const b of c) if (b?.type === "text" && typeof b.text === "string") turn2Text += b.text
      }
      if ((m as any).type === "result") {
        turn2ResultSeen = true
        turn2StopReason = (m as any).stop_reason ?? null
        const usage = (m as any).usage ?? {}
        turn2CacheRead = usage.cache_read_input_tokens ?? 0
        turn2CacheCreate = usage.cache_creation_input_tokens ?? 0
        return "result"
      }
    }
    return "done"
  })()

  const raced = await Promise.race([drain, timeout])
  if (raced === "timeout") {
    turn2Timeout = true
    notes.push(`turn-2 timeout after ${TIMEOUT_MS}ms`)
  }

  try { q.close() } catch { /* ignore */ }
  try { input.close() } catch { /* ignore */ }

  return {
    label, turn1ToolUses,
    turn2Text: turn2Text.slice(0, 200),
    turn2StopReason, turn2CacheRead, turn2CacheCreate,
    turn2ResultSeen, turn2Timeout, notes,
  }
}

async function main() {
  console.log(`file: ${FILE_PATH} -> ${JSON.stringify(readFileSync(FILE_PATH, "utf8").trim())}`)
  console.log(`model: ${MODEL} timeout: ${TIMEOUT_MS}ms`)

  const results: RunResult[] = []
  for (const buffered of [false, true]) {
    try {
      results.push(await runCase(buffered))
    } catch (e) {
      console.error(`case failed (buffered=${buffered}):`, e)
    }
  }

  console.log(`\n━━━ SUMMARY ━━━`)
  for (const r of results) {
    const status = r.turn2Timeout ? "TIMEOUT" : r.turn2ResultSeen ? (r.turn2Text.length > 0 ? "PASS" : "EMPTY") : "NO_RESULT"
    console.log(`\n[${r.label}] status=${status}`)
    console.log(`  turn1 tool_uses: ${r.turn1ToolUses.length}`)
    console.log(`  turn2 text: ${JSON.stringify(r.turn2Text)}`)
    console.log(`  turn2 stop_reason: ${r.turn2StopReason}  cacheRead: ${r.turn2CacheRead}  cacheCreate: ${r.turn2CacheCreate}`)
    console.log(`  notes:`)
    for (const n of r.notes) console.log(`    - ${n}`)
  }
}

main().catch((e) => { console.error("SPIKE ERROR:", e); process.exit(2) })
