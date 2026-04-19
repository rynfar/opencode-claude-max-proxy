/**
 * Spike: persistent streaming-input SDK session — does turn 2 hit the prompt cache
 * for (A) plain text, (B) single tool roundtrip, (C) multi-tool parallel roundtrip?
 *
 * Each scenario opens ONE live query({ prompt: inputQueue, options }) and runs two
 * turns against it. Records cache metrics per turn and logs every event type
 * observed. Gates the server-wiring tasks in
 * openspec/changes/persistent-sdk-sessions/tasks.md.
 *
 * Run:   bun run spike/persistent-demo.ts
 */

import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"

const MODEL = process.env.SPIKE_MODEL ?? "claude-sonnet-4-5"

// --- input queue ----------------------------------------------------------

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

const userMsg = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
})

// --- scenario runner ------------------------------------------------------

interface TurnRecord {
  index: number
  prompt: string
  events: string[]
  toolUseCount: number
  cacheRead: number | null
  cacheCreate: number | null
  stopReason: string | null
  sessionId: string | null
  numTurns: number | null
}

interface ScenarioOptions {
  name: string
  options: Partial<Options>
  prompts: string[]
}

async function runScenario({ name, options, prompts }: ScenarioOptions): Promise<TurnRecord[]> {
  console.log(`\n═══ SCENARIO ${name} — ${prompts.length} turns ═══`)
  const input = createInputQueue<SDKUserMessage>()
  const q = query({
    prompt: input,
    options: {
      executable: "node" as const,
      model: MODEL,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      includePartialMessages: false,
      ...options,
    },
  })

  const turns: TurnRecord[] = []
  let currentIdx = -1

  const consumer = (async () => {
    for await (const m of q) {
      if (currentIdx < 0) continue
      const turn = turns[currentIdx]!
      turn.events.push(m.type)
      if ((m as { type?: unknown }).type === "assistant") {
        const content = ((m as { message?: { content?: unknown } }).message?.content ?? []) as unknown[]
        for (const block of content) {
          if ((block as { type?: unknown }).type === "tool_use") turn.toolUseCount += 1
        }
      }
      if ((m as { type?: unknown }).type === "result") {
        const u = (m as { usage?: Record<string, number> }).usage ?? {}
        turn.cacheRead = u.cache_read_input_tokens ?? 0
        turn.cacheCreate = u.cache_creation_input_tokens ?? 0
        turn.stopReason = (m as { stop_reason?: string | null }).stop_reason ?? null
        turn.sessionId = (m as { session_id?: string }).session_id ?? null
        turn.numTurns = (m as { num_turns?: number }).num_turns ?? null
        console.log(
          `  [turn ${turn.index}] DONE cacheRead=${turn.cacheRead} cacheCreate=${turn.cacheCreate} ` +
          `stop=${turn.stopReason} tools=${turn.toolUseCount} numTurns=${turn.numTurns} events=[${turn.events.join(",")}]`,
        )
        if (turns.length >= prompts.length) break
      }
    }
  })()

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!
    turns.push({ index: i + 1, prompt, events: [], toolUseCount: 0, cacheRead: null, cacheCreate: null, stopReason: null, sessionId: null, numTurns: null })
    currentIdx = i
    console.log(`  [turn ${i + 1}] push: ${JSON.stringify(prompt)}`)
    input.push(userMsg(prompt))
    while (turns[i]!.cacheRead === null) await new Promise((r) => setTimeout(r, 100))
  }

  await consumer
  q.close()
  input.close()
  return turns
}

// --- scenarios ------------------------------------------------------------

// Scenario A: plain text (baseline — already proven in first spike run; included for regression)
async function scenarioA() {
  return runScenario({
    name: "A (plain text, 2 turns)",
    options: {},
    prompts: [
      "Say hello to me in exactly five words.",
      "Now say goodbye in exactly five words.",
    ],
  })
}

// Scenario B: single tool roundtrip
async function scenarioB() {
  const mcp = createSdkMcpServer({
    name: "spike",
    version: "0.0.1",
    tools: [
      tool("square", "Return the square of an integer. Use this when asked to square a number.",
        { n: z.number().int() },
        async ({ n }: { n: number }) => ({ content: [{ type: "text", text: String(n * n) }] }),
      ),
    ],
  })
  return runScenario({
    name: "B (single tool roundtrip)",
    options: {
      mcpServers: { spike: mcp },
      allowedTools: ["mcp__spike__square"],
    },
    prompts: [
      "Use the square tool to compute the square of 7, then tell me the result in one sentence.",
      "Now tell me what that number's last digit is. Just the digit, nothing else.",
    ],
  })
}

// Scenario C: multi-tool parallel roundtrip
async function scenarioC() {
  const mcp = createSdkMcpServer({
    name: "spike",
    version: "0.0.1",
    tools: [
      tool("double", "Return double of an integer.", { n: z.number().int() },
        async ({ n }: { n: number }) => ({ content: [{ type: "text", text: String(n * 2) }] })),
      tool("triple", "Return triple of an integer.", { n: z.number().int() },
        async ({ n }: { n: number }) => ({ content: [{ type: "text", text: String(n * 3) }] })),
    ],
  })
  return runScenario({
    name: "C (multi-tool parallel)",
    options: {
      mcpServers: { spike: mcp },
      allowedTools: ["mcp__spike__double", "mcp__spike__triple"],
    },
    prompts: [
      "In parallel, call the double tool on 5 and the triple tool on 4, then report both results in one short sentence.",
      "Which of those two numbers is bigger? One word.",
    ],
  })
}

// --- orchestrator ---------------------------------------------------------

async function main() {
  const results = new Map<string, TurnRecord[]>()
  results.set("A", await scenarioA())
  results.set("B", await scenarioB())
  results.set("C", await scenarioC())

  console.log("\n═══ SUMMARY ═══")
  let allPassed = true
  for (const [name, turns] of results) {
    for (const t of turns) {
      console.log(`  scenario=${name} turn=${t.index} stop=${t.stopReason} tools=${t.toolUseCount} cacheRead=${t.cacheRead} cacheCreate=${t.cacheCreate}`)
    }
    const t2 = turns[1]
    const passed = !!t2 && (t2.cacheRead ?? 0) > 0
    console.log(`  scenario=${name} turn-2 cacheRead > 0: ${passed ? "PASS" : "FAIL"}\n`)
    if (!passed) allPassed = false
  }
  console.log(`OVERALL: ${allPassed ? "PASS" : "FAIL"}`)
  process.exit(allPassed ? 0 : 1)
}

main().catch((e) => { console.error("SPIKE ERROR:", e); process.exit(2) })
