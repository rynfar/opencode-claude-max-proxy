# Spike results — persistent streaming-input SDK session

Run date: 2026-04-19. Model: `claude-sonnet-4-5` across all scenarios. Scripts: `spike/persistent-demo.ts` (A/B/C), `spike/pi-passthrough-design.ts` (D/E/F), plus a throwaway `src/proxy/server.ts` patch (since reverted) for the live Pi runs.

## Summary table (all six scenarios)

| # | Scenario | Setup | Correctness | Cache T2 | Verdict |
|---|----------|-------|-------------|----------|---------|
| 1 | Plain text × 2 turns (synthetic)              | streaming-input, no tools                     | PASS | 13795 | unblocks runtime skeleton |
| 2 | SDK-executed single tool (synthetic)          | `createSdkMcpServer`, SDK runs tool           | PASS | 14133 | unblocks turn-boundary assumption |
| 3 | SDK-executed multi-tool parallel (synthetic)  | two tools, model asked to call both           | PASS | 14522 | unblocks multi-tool cache |
| 4 | Live Pi × 2 turns, non-passthrough plain text | spike patch to server.ts, real Pi CLI         | PASS | 10122 (98%) | unblocks live HTTP path |
| 5c | Passthrough hook-block + drain (negative)     | existing §D11 plan                            | FAIL | 14951 | **rejects original plan** |
| 5a | Passthrough `Query.interrupt()` (negative)    | interrupt after first tool_use                | FAIL | 13823 | interrupt has "user abandoned" semantics |
| 5b | Passthrough sentinel MCP + user-msg override  | no hook, MCP returns placeholder, override push | PASS (brittle) | 13823 | works but leaks sentinel |
| **5d** | **Passthrough deferred MCP handler**      | **MCP handler awaits a promise meridian resolves** | **PASS** | **14070** | **chosen** |
| 5e | Deferred handler + multi-tool                 | 3 tool_uses over multiple assistant turns     | PASS | 14676 | multi-tool de-risked |
| 5f | Deferred handler rejection / timeout          | handler rejects; runtime must recover          | runtime recovers | 14071 | timeout mechanism de-risked |

## Empirical facts confirmed (carried into design)

- **Terminator: `SDKResultMessage` (`type === "result"`).** One per logical turn. Both `success` and `error_*` subtypes end the turn. See `isTurnTerminator` in `runtime.ts`.
- **`system(init)` fires at the start of every turn**, not just query startup. Non-terminal. The mocked `Query` helper (task §4) must emit it between turns.
- **`rate_limit_event` is non-terminal.** Observed mid-turn across multiple scenarios.
- **`session_id` is stable across turns** from the first `result` event onward. Correct identifier to persist for cold-reattach.
- **`stop_reason` on the outer terminator is `end_turn`** even when the SDK internally did a tool loop (`numTurns=3` or `4`). No `stop_reason: "tool_use"` from the outer stream in SDK-executed-tool mode.
- **The SDK emits synthetic `user` events during tool execution.** These are internal tool_result messages the SDK generated for its own MCP handlers. They must be forwarded or ignored — never treated as client input or turn terminators.
- **The SDK invokes MCP handlers sequentially** even when the model emits multiple tool_use blocks in one assistant message. Each handler blocks until it returns; next handler runs after. The deferred-handler pattern exploits this without issue.

## Live Pi spike — two bugs surfaced and fixed

During the live Pi run (scenario 4) two non-obvious bugs appeared. Both are fixed and carried into runtime.ts + design.md as invariants:

1. **`for await` with early `return` kills the async iterator.** The for-await protocol invokes `iterator.return()` on early exit, which marks the AsyncGenerator done; subsequent calls to `.next()` yield `{done: true}`. `consumeTurn` now uses manual `.next()` iteration so the same iterator survives across turns.
2. **`cache_control` accumulation exceeds Anthropic's 4-block cap.** Pi attaches `cache_control: {type: "ephemeral"}` to every user message. In request-per-process mode meridian strips them via `stripCacheControlDeep`; in persistent mode they would accumulate in the SDK's in-memory history. After 4 turns Anthropic returns `HTTP 400: "A maximum of 4 blocks with cache_control may be provided"`. Invariant: every user content object pushed into a `SessionRuntime` input queue MUST be run through `stripCacheControlDeep` first (design §D10, task §5.13).

## Why the deferred-handler pattern is the right passthrough mechanism (design §D11)

Four passthrough approaches were tested against two oracles — correctness (model's final answer references the real tool output and does not mention "blocked") and cache (T2 cacheRead > 0):

| Approach | Why it failed / succeeded |
|----------|---------------------------|
| **Hook block + drain** (original §D11) | SDK synthesizes "blocked by hook" narrative text into the conversation during turn 2 drain; when the client's real tool_result later arrives, the model sees contradictory state and hallucinates "the read was blocked" or re-emits tool_use. |
| **`Query.interrupt()`** | Cleanly stops turn-2 generation but leaves the session in a "user stopped me" state. Model replies "I've stopped. How would you like to proceed?" on subsequent turns. Wrong semantics for external tool execution. |
| **Sentinel MCP + user-msg override** | Works but leaks the sentinel string into conversation history and requires an out-of-band "the previous tool call was actually handled externally, its real output was X" user message that is brittle across model versions. |
| **Deferred MCP handler** | Handler creates a pending `Promise<string>`; SDK blocks on it. Meridian's SSE layer forwards the tool_use to the client and closes the client SSE. When the client's next request arrives with the real tool_result, meridian resolves the promise with that content. SDK receives the real content as the tool's native return value — no synthetic narrative, no sentinel, no override. SDK's in-memory conversation is byte-identical to what the client sees. |

Scenario 5e (3 tool_uses across multiple assistant turns) and 5f (handler rejection) confirmed the pattern handles multi-tool sequentially and recovers cleanly from timeouts. All of design §D11's residual operational questions (multi-tool, timeout, hook interaction) are empirically closed.

## Design updates driven by spike results

The design file has been updated in-place; this section is just a cross-reference.

- **§D10 (cache_control stripping)** — new invariant forced by the live-Pi spike's 4-block-cap bug.
- **§D11 (passthrough deferred MCP handler)** — rewritten from "drain in background" to the Scenario-5d pattern after that approach was proven broken.
- **§D9 rollout order** — flipped to OpenCode-first (matches the proven SDK-executed-tool scenarios), Pi second, because Pi adds the deferred-handler mechanism on top of the cache win and is best validated after the cache win is in production.
- **Task §5.12** — re-authored as 10 subtasks implementing the deferred-handler pattern end-to-end (runtime field, MCP rewrite, SSE forward, dispatch classification, timeout, shutdown, 3 integration tests).

## Artifacts

- `spike/persistent-demo.ts` — scenarios 1/2/3 (plain text + SDK-executed tools).
- `spike/pi-passthrough-design.ts` — scenarios 5a/5b/5c/5d/5e/5f (passthrough design).
- Live Pi spike server.ts patch — reverted; findings above are what persist.
- Full run logs: `/tmp/pi-passthrough-design.log`, `/tmp/pi-passthrough-design-EF.log`, `/tmp/pi-live-spike-meridian.log`.

## Residual risk entering implementation

None architectural. Remaining uncertainties are execution-level and captured in the task list:

- Meridian plugin-surface audit under persistent lifecycle (§7.5).
- Options-drift reopen-rate on real traffic (§2, gate waived to enable progress — will be measured post-rollout).
- E2E coverage for persistent mode (§10.6).

The refactor is now as de-risked as it can be before writing production code.
