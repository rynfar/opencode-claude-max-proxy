/**
 * Transparent retry wrapper for SDK query calls.
 *
 * Handles two retry scenarios:
 * 1. Stale session UUID → evict session and replay as fresh (one-shot)
 * 2. Rate limiting → strip [1m] context (free), then exponential backoff
 *
 * Both streaming and non-streaming paths use identical retry logic;
 * only the "committed response" check differs (stream_event vs assistant).
 */

import { query } from "@anthropic-ai/claude-agent-sdk"
import { claudeLog } from "../logger"
import { isStaleSessionError, isRateLimitError } from "./errors"
import { hasExtendedContext, stripExtendedContext } from "./models"
import { buildQueryOptions, type QueryContext } from "./query"
import { buildFreshPrompt } from "./prepareMessages"
import { evictSession } from "./session/cache"

const MAX_RATE_LIMIT_RETRIES = 2
const RATE_LIMIT_BASE_DELAY_MS = 1000

export interface RetryContext {
  /** "stream" or "non_stream" */
  mode: "stream" | "non_stream"
  /** Request ID for logging */
  requestId: string
  /** Current model (may be mutated by [1m] fallback) */
  getModel(): string
  setModel(m: string): void
  /** Build query options for the current attempt */
  buildOpts(overrides?: Partial<QueryContext>): QueryContext
  /** All messages (for fresh prompt on stale session retry) */
  allMessages: Array<{ role: string; content: any }>
  /** Agent session ID for eviction */
  agentSessionId: string | undefined
  /** Working directory for eviction */
  workingDirectory: string
  /** SDK UUID map to reset on eviction */
  sdkUuidMap: Array<string | null>
  /** Check if an event means the response is committed (no more retries) */
  isCommitted(event: any): boolean
}

/**
 * Wrap a query call with transparent retry logic.
 * Returns an async generator that yields SDK events.
 */
export async function* withRetry(ctx: RetryContext): AsyncGenerator<any> {
  let rateLimitRetries = 0

  while (true) {
    let committed = false
    try {
      for await (const event of query(buildQueryOptions(ctx.buildOpts()))) {
        if (ctx.isCommitted(event)) {
          committed = true
        }
        yield event
      }
      return
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)

      // Never retry after response is committed
      if (committed) throw error

      // Retry: stale undo UUID — evict session and start fresh (one-shot)
      if (isStaleSessionError(error)) {
        claudeLog("session.stale_uuid_retry", {
          mode: ctx.mode,
          rollbackUuid: ctx.buildOpts().undoRollbackUuid,
          resumeSessionId: ctx.buildOpts().resumeSessionId,
        })
        console.error(`[PROXY] Stale session UUID, evicting and retrying as fresh session`)
        evictSession(ctx.agentSessionId, ctx.workingDirectory, ctx.allMessages)
        ctx.sdkUuidMap.length = 0
        for (let i = 0; i < ctx.allMessages.length; i++) ctx.sdkUuidMap.push(null)
        yield* query(buildQueryOptions(ctx.buildOpts({
          prompt: buildFreshPrompt(ctx.allMessages),
          resumeSessionId: undefined,
          isUndo: false,
          undoRollbackUuid: undefined,
        })))
        return
      }

      // Rate-limit retry: first strip [1m] (free, different tier), then backoff
      if (isRateLimitError(errMsg)) {
        const model = ctx.getModel()
        if (hasExtendedContext(model)) {
          const stripped = stripExtendedContext(model)
          claudeLog("upstream.context_fallback", {
            mode: ctx.mode,
            from: model,
            to: stripped,
            reason: "rate_limit",
          })
          console.error(`[PROXY] ${ctx.requestId} rate-limited on [1m], retrying with ${stripped}`)
          ctx.setModel(stripped)
          continue
        }
        if (rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
          rateLimitRetries++
          const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, rateLimitRetries - 1)
          claudeLog("upstream.rate_limit_backoff", {
            mode: ctx.mode,
            model,
            attempt: rateLimitRetries,
            maxAttempts: MAX_RATE_LIMIT_RETRIES,
            delayMs: delay,
          })
          console.error(`[PROXY] ${ctx.requestId} rate-limited on ${model}, retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${delay}ms`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
      }

      throw error
    }
  }
}
