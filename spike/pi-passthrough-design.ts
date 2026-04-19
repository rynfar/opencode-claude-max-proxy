/**
 * Spike §1d: Pi passthrough tool-integrity design experiments.
 *
 * The §1c passthrough extension showed that when the SDK's PreToolUse hook
 * returns {decision: "block"}, the SDK generates synthetic "blocked by hook"
 * text that enters the persistent runtime's conversation and corrupts the
 * model's view when the real client tool_result arrives later.
 *
 * This spike isolates the SDK (no meridian HTTP, no Pi) and tests candidate
 * fixes end-to-end:
 *
 *   A. interrupt() immediately after the first tool_use content_block_stop,
 *      then push a real synthetic tool_result and check that the model uses it.
 *
 *   B. no PreToolUse hook; rely on the MCP handler returning a sentinel marker,
 *      then client pushes an override user message with the real tool_result.
 *      (Used for comparison / understanding of the SDK's defaults.)
 *
 *   C. baseline: hook blocks and we do nothing special — confirms the broken
 *      behaviour observed in §1c.
 *
 * Each scenario runs one persistent query; we inspect (a) turn-2 cache metrics
 * and (b) whether the final assistant text references the REAL file content
 * (single word "hello" from /tmp/pi-spike-alpha.txt) vs. hallucinated
 * "blocked" narrative.
 *
 * Run:   bun run spike/pi-passthrough-design.ts
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { readFileSync } from "node:fs"

const MODEL = process.env.SPIKE_MODEL ?? "claude-sonnet-4-5"
const FILE_PATH = "/tmp/pi-spike-alpha.txt"
const FIRST_WORD_EXPECTED = "hello"

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

interface TurnResult {
  label: string
  stopReason: string | null
  cacheRead: number
  cacheCreate: number
  finalText: string
  rawAssistantTypes: string[][]
  capturedToolUseId?: string
  capturedToolUseInput?: unknown
  usedRealFirstWord: boolean
  mentionsBlocked: boolean
}

function extractFinalText(events: SDKMessage[]): string {
  let out = ""
  for (const e of events) {
    if ((e as any).type !== "assistant") continue
    const content = (e as any).message?.content ?? []
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string") out += b.text + "\n"
    }
  }
  return out.trim()
}

async function consumeUntilResult(
  q: AsyncIterator<SDKMessage, void>,
  sink: SDKMessage[],
  onFirstToolUse?: (toolUseId: string, input: unknown) => Promise<void> | void,
): Promise<SDKMessage | null> {
  let seenToolUse = false
  while (true) {
    const step = await q.next()
    if (step.done) return null
    const m = step.value
    sink.push(m)
    const mt = (m as any).type

    if (!seenToolUse && mt === "stream_event") {
      const inner = (m as any).event
      if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
        // Start of a tool_use block — wait for the content_block_stop to ensure we have input
      }
      if (inner?.type === "content_block_stop") {
        // Check if the preceding content was a tool_use
        // (We identified it in assistant event below.)
      }
    }

    if (!seenToolUse && mt === "assistant") {
      const content = (m as any).message?.content ?? []
      const tu = Array.isArray(content) ? content.find((b: any) => b?.type === "tool_use") : null
      if (tu) {
        seenToolUse = true
        if (onFirstToolUse) await onFirstToolUse(tu.id, tu.input)
      }
    }

    if (mt === "result") return m
  }
}

function summarizeResult(label: string, events: SDKMessage[], result: SDKMessage | null): TurnResult {
  const usage = (result as any)?.usage ?? {}
  const finalText = extractFinalText(events)
  const mentionsBlocked = /blocked|cannot|could not/i.test(finalText)
  const usedRealFirstWord = new RegExp(`\\b${FIRST_WORD_EXPECTED}\\b`, "i").test(finalText)
  const assistantTypes: string[][] = []
  for (const e of events) {
    if ((e as any).type === "assistant") {
      const content = (e as any).message?.content ?? []
      if (Array.isArray(content)) assistantTypes.push(content.map((b: any) => b.type))
    }
  }
  return {
    label,
    stopReason: (result as any)?.stop_reason ?? null,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheCreate: usage.cache_creation_input_tokens ?? 0,
    finalText: finalText.slice(0, 200),
    rawAssistantTypes: assistantTypes,
    usedRealFirstWord,
    mentionsBlocked,
  }
}

// =====================================================================
// Scenario C — baseline: PreToolUse hook blocks; no intervention.
// =====================================================================

async function scenarioC_baseline(): Promise<{ t1: TurnResult; t2: TurnResult }> {
  console.log(`\n═══ Scenario C (baseline: hook-blocks, drain naturally) ═══`)
  const input = createInputQueue<SDKUserMessage>()
  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool(
        "read",
        "Read a file and return its contents.",
        { path: z.string() },
        async () => ({ content: [{ type: "text", text: "spike-mcp-handler-should-not-run" }] }),
      ),
    ],
  })

  let capturedToolUseId: string | null = null
  let capturedInput: unknown = null
  const options: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read"],
    hooks: {
      PreToolUse: [{
        matcher: "",
        hooks: [async (input: any) => {
          if (input.tool_name === "ToolSearch") return {}
          capturedToolUseId = input.tool_use_id
          capturedInput = input.tool_input
          return { decision: "block" as const, reason: "Forwarding to client for execution" }
        }],
      }],
    },
  }

  const q = query({ prompt: input, options })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>

  const eventsT1: SDKMessage[] = []
  input.push(userText(`Use the read tool on ${FILE_PATH}. After reading, reply with only the first word of the file contents.`))
  const resT1 = await consumeUntilResult(iter, eventsT1)
  const t1 = summarizeResult("C.T1 baseline", eventsT1, resT1)
  ;(t1 as any).capturedToolUseId = capturedToolUseId
  ;(t1 as any).capturedToolUseInput = capturedInput

  // Push the REAL tool_result as a user message — see if the model recovers
  const eventsT2: SDKMessage[] = []
  const realContent = readFileSync(FILE_PATH, "utf8").trim()
  if (capturedToolUseId) {
    input.push(userToolResult(capturedToolUseId, realContent))
  } else {
    input.push(userText(`(No captured tool_use_id — pushing plain text with the file contents.) The file said: ${realContent}`))
  }
  const resT2 = await consumeUntilResult(iter, eventsT2)
  const t2 = summarizeResult("C.T2 baseline", eventsT2, resT2)

  q.close()
  input.close()
  return { t1, t2 }
}

// =====================================================================
// Scenario A — interrupt() immediately after the first assistant tool_use.
// =====================================================================

async function scenarioA_interrupt(): Promise<{ t1: TurnResult; t2: TurnResult }> {
  console.log(`\n═══ Scenario A (interrupt after first tool_use; then push real tool_result) ═══`)
  const input = createInputQueue<SDKUserMessage>()
  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool(
        "read",
        "Read a file and return its contents.",
        { path: z.string() },
        async () => ({ content: [{ type: "text", text: "spike-mcp-handler-should-not-run" }] }),
      ),
    ],
  })

  let capturedToolUseId: string | null = null
  let capturedInput: unknown = null
  const options: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read"],
    hooks: {
      PreToolUse: [{
        matcher: "",
        hooks: [async (input: any) => {
          if (input.tool_name === "ToolSearch") return {}
          capturedToolUseId = input.tool_use_id
          capturedInput = input.tool_input
          return { decision: "block" as const, reason: "Forwarding to client for execution" }
        }],
      }],
    },
  }

  const q: Query = query({ prompt: input, options })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>

  const eventsT1: SDKMessage[] = []
  input.push(userText(`Use the read tool on ${FILE_PATH}. After reading, reply with only the first word of the file contents.`))

  const resT1 = await consumeUntilResult(iter, eventsT1, async (toolUseId, input) => {
    console.log(`  [A.T1] observed first tool_use id=${toolUseId.slice(0, 8)} input=${JSON.stringify(input)}`)
    try {
      console.log(`  [A.T1] calling q.interrupt()`)
      await q.interrupt()
      console.log(`  [A.T1] interrupt() returned`)
    } catch (e) {
      console.log(`  [A.T1] interrupt() error: ${e}`)
    }
  })
  const t1 = summarizeResult("A.T1 interrupt", eventsT1, resT1)
  ;(t1 as any).capturedToolUseId = capturedToolUseId
  ;(t1 as any).capturedToolUseInput = capturedInput

  const eventsT2: SDKMessage[] = []
  const realContent = readFileSync(FILE_PATH, "utf8").trim()
  if (capturedToolUseId) {
    input.push(userToolResult(capturedToolUseId, realContent))
  } else {
    input.push(userText(`The file contents were: ${realContent}. What is the first word?`))
  }
  const resT2 = await consumeUntilResult(iter, eventsT2)
  const t2 = summarizeResult("A.T2 interrupt+push", eventsT2, resT2)

  q.close()
  input.close()
  return { t1, t2 }
}

// =====================================================================
// Scenario B — no PreToolUse hook. MCP handler returns a sentinel.
// We capture the tool_use from the event stream and push a real
// tool_result as a separate user message via the input queue.
// =====================================================================

async function scenarioB_sentinel(): Promise<{ t1: TurnResult; t2: TurnResult }> {
  console.log(`\n═══ Scenario B (no hook; MCP returns sentinel; client pushes override) ═══`)
  const input = createInputQueue<SDKUserMessage>()
  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool(
        "read",
        "Read a file and return its contents.",
        { path: z.string() },
        async () => ({ content: [{ type: "text", text: "__PENDING_CLIENT_EXECUTION__" }] }),
      ),
    ],
  })

  const options: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read"],
  }

  const q = query({ prompt: input, options })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>

  let capturedToolUseId: string | null = null
  const eventsT1: SDKMessage[] = []
  input.push(userText(`Use the read tool on ${FILE_PATH}. After reading, reply with only the first word of the file contents.`))
  const resT1 = await consumeUntilResult(iter, eventsT1, (toolUseId) => {
    capturedToolUseId = toolUseId
  })
  const t1 = summarizeResult("B.T1 sentinel", eventsT1, resT1)
  ;(t1 as any).capturedToolUseId = capturedToolUseId

  // T2: push the real file contents as a plain user message so the model can
  // answer the original question. (Skipping tool_result since the SDK already
  // fed itself the sentinel string as the "result" of the tool call.)
  const eventsT2: SDKMessage[] = []
  const realContent = readFileSync(FILE_PATH, "utf8").trim()
  input.push(userText(`The read tool was handled externally. Its actual output was: "${realContent}". Now reply with only the first word.`))
  const resT2 = await consumeUntilResult(iter, eventsT2)
  const t2 = summarizeResult("B.T2 override", eventsT2, resT2)

  q.close()
  input.close()
  return { t1, t2 }
}

// =====================================================================
// Scenario D — MCP handler awaits an external promise that meridian
// resolves with the real client-executed tool_result. No hook, no
// sentinel pollution, no override user message. The SDK sees the
// real tool_result directly as the tool's return value.
// =====================================================================

async function scenarioD_deferredHandler(): Promise<{ t1: TurnResult; t2: TurnResult }> {
  console.log(`\n═══ Scenario D (MCP handler awaits external promise; client resolves with real result) ═══`)
  const input = createInputQueue<SDKUserMessage>()

  // Meridian-side: a pending "external tool execution" registry. When the
  // MCP handler is invoked, it creates a pending entry and awaits its
  // resolution. Meridian resolves the entry when the client returns with
  // the real tool_result.
  const pendingExecutions = new Map<string, { resolve: (v: string) => void }>()
  let pendingKey = 0
  let latestPendingKey: string | null = null

  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool(
        "read",
        "Read a file and return its contents.",
        { path: z.string() },
        async (args) => {
          const key = `pending-${++pendingKey}`
          latestPendingKey = key
          console.log(`  [D.handler] invoked for path=${(args as any).path} key=${key} — awaiting external result…`)
          const result = await new Promise<string>((resolve) => {
            pendingExecutions.set(key, { resolve })
          })
          console.log(`  [D.handler] key=${key} resolved with content length=${result.length}`)
          return { content: [{ type: "text", text: result }] }
        },
      ),
    ],
  })

  const options: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read"],
    // No PreToolUse hook — we let the MCP handler be the control point.
  }

  const q = query({ prompt: input, options })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>

  const eventsT1: SDKMessage[] = []
  input.push(userText(`Use the read tool on ${FILE_PATH}. After reading, reply with only the first word of the file contents.`))

  // T1 orchestration:
  // Consume events. When we see a tool_use content_block_start, schedule a
  // resolver to fire after a realistic client-execution delay with the REAL
  // file contents. This mimics meridian receiving a client HTTP request
  // bearing the real tool_result.
  const seenToolIds = new Set<string>()
  const realContent = readFileSync(FILE_PATH, "utf8").trim()
  const consumer = (async () => {
    while (true) {
      const step = await iter.next()
      if (step.done) break
      const m = step.value
      eventsT1.push(m)
      if ((m as any).type === "stream_event") {
        const inner = (m as any).event
        if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
          const id = inner.content_block.id as string
          if (!seenToolIds.has(id)) {
            seenToolIds.add(id)
            // Simulate client going away, executing the tool, and pushing
            // the real result 200ms later.
            setTimeout(() => {
              if (latestPendingKey && pendingExecutions.has(latestPendingKey)) {
                const entry = pendingExecutions.get(latestPendingKey)!
                pendingExecutions.delete(latestPendingKey)
                console.log(`  [D.client] resolving pending handler with real content`)
                entry.resolve(realContent)
              }
            }, 200)
          }
        }
      }
      if ((m as any).type === "result") break
    }
  })()
  await consumer
  const resT1 = eventsT1.find((e) => (e as any).type === "result") ?? null
  const t1 = summarizeResult("D.T1 deferred-handler", eventsT1, resT1)

  // T2: plain follow-up to confirm the session is healthy and cache works.
  const eventsT2: SDKMessage[] = []
  input.push(userText(`Now reply with the LAST word of that file contents.`))
  // Second turn — no tool_use expected since we have the content in history.
  // If the model DOES call read again, resolve with the same content.
  const consumer2 = (async () => {
    while (true) {
      const step = await iter.next()
      if (step.done) break
      const m = step.value
      eventsT2.push(m)
      if ((m as any).type === "stream_event") {
        const inner = (m as any).event
        if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
          const id = inner.content_block.id as string
          if (!seenToolIds.has(id)) {
            seenToolIds.add(id)
            setTimeout(() => {
              if (latestPendingKey && pendingExecutions.has(latestPendingKey)) {
                const entry = pendingExecutions.get(latestPendingKey)!
                pendingExecutions.delete(latestPendingKey)
                entry.resolve(realContent)
              }
            }, 200)
          }
        }
      }
      if ((m as any).type === "result") break
    }
  })()
  await consumer2
  const resT2 = eventsT2.find((e) => (e as any).type === "result") ?? null
  const t2 = summarizeResult("D.T2 deferred-handler followup", eventsT2, resT2)
  // Custom: check T2 final text for "file" (last word of "hello from the pi live spike alpha file")
  t2.usedRealFirstWord = /\bfile\b/i.test(t2.finalText)

  q.close()
  input.close()
  return { t1, t2 }
}

// =====================================================================
// Scenario E — multi-tool parallel with deferred handlers.
// Two tools (read + stat); model asked to call both in parallel; client
// resolves both pending handlers in a batch before the SDK continues.
// =====================================================================

async function scenarioE_deferredParallel(): Promise<{ t1: TurnResult; t2: TurnResult }> {
  console.log(`\n═══ Scenario E (deferred multi-tool parallel) ═══`)
  const input = createInputQueue<SDKUserMessage>()
  const pendingExecutions = new Map<string, { resolve: (v: string) => void; toolName: string }>()

  // SDK executes handlers sequentially — resolve each one immediately on
  // invocation (simulates meridian having already received the client's
  // batched tool_results by the time the first handler fires).
  const realContentHandler = readFileSync(FILE_PATH, "utf8").trim()
  const realSizeHandler = Buffer.byteLength(readFileSync(FILE_PATH), "utf8").toString()
  const readHandler = async (args: unknown) => {
    const key = `read-${Math.random().toString(36).slice(2)}`
    console.log(`  [E.read] invoked path=${(args as any).path} key=${key} — resolving with real contents`)
    const result = await new Promise<string>((resolve) => {
      pendingExecutions.set(key, { resolve, toolName: "read" })
      setTimeout(() => {
        const entry = pendingExecutions.get(key)
        if (entry) { pendingExecutions.delete(key); entry.resolve(realContentHandler) }
      }, 50)
    })
    return { content: [{ type: "text" as const, text: result }] }
  }
  const sizeHandler = async (args: unknown) => {
    const key = `size-${Math.random().toString(36).slice(2)}`
    console.log(`  [E.size] invoked path=${(args as any).path} key=${key} — resolving with real size`)
    const result = await new Promise<string>((resolve) => {
      pendingExecutions.set(key, { resolve, toolName: "size" })
      setTimeout(() => {
        const entry = pendingExecutions.get(key)
        if (entry) { pendingExecutions.delete(key); entry.resolve(realSizeHandler) }
      }, 50)
    })
    return { content: [{ type: "text" as const, text: result }] }
  }

  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool("read", "Read a file and return its contents.", { path: z.string() }, readHandler),
      tool("size", "Return the size of a file in bytes as a number.", { path: z.string() }, sizeHandler),
    ],
  })

  const options: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read", "mcp__spike__size"],
  }

  const q = query({ prompt: input, options })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>
  const realContent = readFileSync(FILE_PATH, "utf8").trim()
  const realSize = Buffer.byteLength(readFileSync(FILE_PATH), "utf8").toString()

  const eventsT1: SDKMessage[] = []
  input.push(userText(`Call BOTH tools in parallel on ${FILE_PATH}: call read to get its contents AND call size to get its byte length. After both results come back, reply with exactly two words joined by a dash: the first word of the file, and then the file's size in bytes.`))

  // Consume until result. Handlers auto-resolve themselves (per-invocation
  // setTimeout in readHandler/sizeHandler), simulating meridian having the
  // batched tool_results ready when each MCP handler fires.
  const consumer = (async () => {
    while (true) {
      const step = await iter.next()
      if (step.done) break
      const m = step.value
      eventsT1.push(m)
      if ((m as any).type === "result") break
    }
  })()
  await consumer
  const resT1 = eventsT1.find((e) => (e as any).type === "result") ?? null
  const t1 = summarizeResult("E.T1 parallel", eventsT1, resT1)
  t1.usedRealFirstWord = /\bhello\b/i.test(t1.finalText) && t1.finalText.includes(realSize)

  // T2 simple followup to verify cache
  const eventsT2: SDKMessage[] = []
  input.push(userText(`What was the size in bytes? Just the number.`))
  const consumer2 = (async () => {
    while (true) {
      const step = await iter.next()
      if (step.done) break
      eventsT2.push(step.value)
      if ((step.value as any).type === "result") break
    }
  })()
  await consumer2
  const resT2 = eventsT2.find((e) => (e as any).type === "result") ?? null
  const t2 = summarizeResult("E.T2 followup", eventsT2, resT2)
  t2.usedRealFirstWord = t2.finalText.includes(realSize)

  q.close()
  input.close()
  return { t1, t2 }
}

// =====================================================================
// Scenario F — deferred handler rejection (timeout path).
// Never resolve the pending entry; test how the SDK reacts to handler throw.
// =====================================================================

async function scenarioF_deferredTimeout(): Promise<{ t1: TurnResult; t2: TurnResult }> {
  console.log(`\n═══ Scenario F (deferred handler rejection / timeout) ═══`)
  const input = createInputQueue<SDKUserMessage>()

  const mcp = createSdkMcpServer({
    name: "spike",
    tools: [
      tool(
        "read",
        "Read a file and return its contents.",
        { path: z.string() },
        async () => {
          console.log(`  [F.read] invoked — will reject after 1s`)
          await new Promise((_, reject) => setTimeout(() => reject(new Error("PendingExecutionTimeout")), 1000))
          return { content: [{ type: "text" as const, text: "unreachable" }] }
        },
      ),
    ],
  })

  const options: Options = {
    executable: "node" as const,
    model: MODEL,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    mcpServers: { spike: mcp },
    allowedTools: ["mcp__spike__read"],
  }

  const q = query({ prompt: input, options })
  const iter = q as unknown as AsyncIterator<SDKMessage, void>

  const eventsT1: SDKMessage[] = []
  input.push(userText(`Use the read tool on ${FILE_PATH}. After reading, reply with only the first word of the file contents.`))

  const consumer = (async () => {
    try {
      while (true) {
        const step = await iter.next()
        if (step.done) break
        eventsT1.push(step.value)
        if ((step.value as any).type === "result") break
      }
    } catch (e) {
      console.log(`  [F.consumer] iterator threw: ${e}`)
    }
  })()
  await consumer
  const resT1 = eventsT1.find((e) => (e as any).type === "result") ?? null
  const t1 = summarizeResult("F.T1 timeout", eventsT1, resT1)

  // T2: push a plain user message to see if the runtime is still usable
  const eventsT2: SDKMessage[] = []
  input.push(userText(`Are you still there? Reply with just "yes" or "no".`))
  const consumer2 = (async () => {
    try {
      while (true) {
        const step = await iter.next()
        if (step.done) break
        eventsT2.push(step.value)
        if ((step.value as any).type === "result") break
      }
    } catch (e) {
      console.log(`  [F.consumer2] iterator threw: ${e}`)
    }
  })()
  await consumer2
  const resT2 = eventsT2.find((e) => (e as any).type === "result") ?? null
  const t2 = summarizeResult("F.T2 runtime-after-timeout", eventsT2, resT2)

  q.close()
  input.close()
  return { t1, t2 }
}

// =====================================================================

function printResult(r: TurnResult) {
  console.log(`  ${r.label}:`)
  console.log(`    stop=${r.stopReason} cacheRead=${r.cacheRead} cacheCreate=${r.cacheCreate}`)
  console.log(`    assistants=[${r.rawAssistantTypes.map((ts) => `[${ts.join(",")}]`).join(" ")}]`)
  console.log(`    final: ${JSON.stringify(r.finalText)}`)
  console.log(`    correctness: usedRealFirstWord=${r.usedRealFirstWord}, mentionsBlocked=${r.mentionsBlocked}`)
}

async function main() {
  // Ensure the test file has known content
  const actual = readFileSync(FILE_PATH, "utf8").trim()
  console.log(`Test file ${FILE_PATH} contents: ${JSON.stringify(actual)}`)
  console.log(`Expected first word: ${FIRST_WORD_EXPECTED}\n`)

  const results: Array<{ scenario: string; t1: TurnResult; t2: TurnResult }> = []

  const only = process.env.SPIKE_ONLY?.split(",").map(s => s.trim().toUpperCase())
  const run = (name: string) => !only || only.includes(name)
  if (run("C")) try { results.push({ scenario: "C", ...(await scenarioC_baseline()) }) } catch (e) { console.error("C failed:", e) }
  if (run("A")) try { results.push({ scenario: "A", ...(await scenarioA_interrupt()) }) } catch (e) { console.error("A failed:", e) }
  if (run("B")) try { results.push({ scenario: "B", ...(await scenarioB_sentinel()) }) } catch (e) { console.error("B failed:", e) }
  if (run("D")) try { results.push({ scenario: "D", ...(await scenarioD_deferredHandler()) }) } catch (e) { console.error("D failed:", e) }
  if (run("E")) try { results.push({ scenario: "E", ...(await scenarioE_deferredParallel()) }) } catch (e) { console.error("E failed:", e) }
  if (run("F")) try { results.push({ scenario: "F", ...(await scenarioF_deferredTimeout()) }) } catch (e) { console.error("F failed:", e) }

  console.log(`\n═══ SUMMARY ═══`)
  for (const r of results) {
    console.log(`\n— Scenario ${r.scenario} —`)
    printResult(r.t1)
    printResult(r.t2)
  }

  console.log(`\n═══ VERDICT ═══`)
  const verdict = (r: { scenario: string; t1: TurnResult; t2: TurnResult }) => {
    const ok = r.t2.usedRealFirstWord && !r.t2.mentionsBlocked
    const cacheOk = r.t2.cacheRead > 0
    return `Scenario ${r.scenario}: correctness=${ok ? "PASS" : "FAIL"} cache=${cacheOk ? "PASS" : "FAIL"} (T2 cacheRead=${r.t2.cacheRead})`
  }
  for (const r of results) console.log(verdict(r))
}

main().catch((e) => { console.error("SPIKE ERROR:", e); process.exit(2) })
