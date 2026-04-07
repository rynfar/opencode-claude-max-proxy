/**
 * Telemetry types for request performance tracking.
 *
 * Each proxy request produces a RequestMetric capturing timing for every phase:
 *
 *   queueEnter → queueStart → requestStart ──→ upstreamStart → firstChunk → done
 *   ├─ queueWait ─┤           ├─ proxyOverhead ─┤              │            │
 *   │                                            ├──── TTFB ────┤            │
 *   │                                            ├── upstream duration ──────┤
 *   ├──────────────────── total duration ────────────────────────────────────┤
 */

export interface RequestMetric {
  /** Unique request identifier */
  requestId: string

  /** When this metric was recorded */
  timestamp: number

  /** Which agent adapter handled this request */
  adapter?: string

  /** Model used for SDK query (sonnet, opus, haiku, sonnet[1m], etc.) */
  model: string

  /** Original model string from the client request (e.g. "claude-sonnet-4-6-20250312") */
  requestModel?: string

  /** Streaming or non-streaming */
  mode: "stream" | "non-stream"

  /** Whether the request used session resume */
  isResume: boolean

  /** Whether passthrough mode was active */
  isPassthrough: boolean

  /** Session lineage classification: how the incoming messages related to the stored session.
   *  - continuation: normal follow-up (prefix matched)
   *  - compaction:   older messages rewritten, recent preserved (suffix matched)
   *  - undo:         user undid recent messages (prefix preserved, suffix changed) → SDK fork
   *  - diverged:     no overlap with stored session → fresh start
   *  - new:          first request, no stored session to compare */
  lineageType?: "continuation" | "compaction" | "undo" | "diverged" | "new"

  /** Whether deferred tool loading was active (auto-defer or client defer_loading) */
  hasDeferredTools?: boolean

  /** Number of tools deferred (not in prompt, discoverable via ToolSearch) */
  deferredToolCount?: number

  /** Total number of tools in the request */
  toolCount?: number

  /** Number of messages in the request */
  messageCount?: number

  /** SDK session ID used for this request (for correlating across turns) */
  sdkSessionId?: string

  /** HTTP status code returned to the client */
  status: number

  /** Time spent waiting in the concurrency queue (ms) */
  queueWaitMs: number

  /** Time spent in proxy processing before SDK call — request parsing,
   *  session lookup, prompt building (ms). If this is high, the proxy
   *  is the bottleneck. Typically <50ms. */
  proxyOverheadMs: number

  /** Time from SDK query start to first content chunk (ms) */
  ttfbMs: number | null

  /** Total time the SDK query took (ms) */
  upstreamDurationMs: number

  /** Total time from request received to response sent (ms) */
  totalDurationMs: number

  /** Number of content blocks in the response */
  contentBlocks: number

  /** Number of text stream events forwarded (streaming only) */
  textEvents: number

  /** Error type if the request failed, null if successful */
  error: string | null

  /** Input tokens consumed (from SDK usage) */
  inputTokens?: number

  /** Output tokens generated */
  outputTokens?: number

  /** Input tokens read from prompt cache (lower cost) */
  cacheReadInputTokens?: number

  /** Input tokens written to prompt cache (one-time cost) */
  cacheCreationInputTokens?: number

  /** Cache hit ratio: cacheRead / (cacheRead + cacheCreation + uncached).
   *  1.0 = perfect caching, 0.0 = no caching. undefined when no token data. */
  cacheHitRate?: number
}

export interface PhaseTiming {
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  avg: number
}

export interface TelemetrySummary {
  /** Time window these stats cover */
  windowMs: number
  /** Total requests in the window */
  totalRequests: number
  /** Requests that returned an error */
  errorCount: number
  /** Requests per minute */
  requestsPerMinute: number

  /** Timing breakdowns by phase */
  queueWait: PhaseTiming
  proxyOverhead: PhaseTiming
  ttfb: PhaseTiming
  upstreamDuration: PhaseTiming
  totalDuration: PhaseTiming

  /** Breakdown by model */
  byModel: Record<string, { count: number; avgTotalMs: number }>
  /** Breakdown by mode */
  byMode: Record<string, { count: number; avgTotalMs: number }>

  /** Aggregate token usage across all requests in the window */
  tokenUsage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheCreationTokens: number
    avgCacheHitRate: number
    /** Requests where cache hit rate was 0 despite being a resume */
    cacheMissOnResumeCount: number
  }
}
