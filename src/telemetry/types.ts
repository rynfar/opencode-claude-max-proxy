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

  /** Tool names discovered via ToolSearch this request (deferred tools that got called) */
  discoveredTools?: string[]

  /** Cumulative count of tools discovered via ToolSearch across the entire session */
  sessionDiscoveredCount?: number

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

/** Storage backend for request metrics. */
export interface ITelemetryStore {
  /** Record a completed request metric. */
  record(metric: RequestMetric): void
  /** Number of stored metrics. */
  readonly size: number
  /** Retrieve recent metrics, newest first. */
  getRecent(options?: {
    limit?: number
    since?: number
    model?: string
  }): RequestMetric[]
  /** Find the latest successful metric for a given SDK session. */
  getLastForSession(sdkSessionId: string): RequestMetric | undefined
  /** Compute aggregate statistics over a time window. */
  summarize(windowMs?: number): TelemetrySummary
  /** Clear all stored metrics. */
  clear(): void
}

/** Diagnostic log entry. */
export interface DiagnosticLog {
  /** Unix timestamp */
  timestamp: number
  /** Log level */
  level: "info" | "warn" | "error"
  /** Log category for filtering */
  category: "session" | "lineage" | "error" | "lifecycle" | "token"
  /** Request ID (if associated with a request) */
  requestId?: string
  /** Human-readable message */
  message: string
}

/** Storage backend for diagnostic logs. */
export interface IDiagnosticLogStore {
  /** Append a log entry (timestamp is added automatically). */
  log(entry: Omit<DiagnosticLog, "timestamp">): void
  /** Log a session event. */
  session(message: string, requestId?: string): void
  /** Log a lineage event (compaction, undo, diverged). */
  lineage(message: string, requestId?: string): void
  /** Log an error. */
  error(message: string, requestId?: string): void
  /** Retrieve recent logs, newest first. */
  getRecent(options?: {
    limit?: number
    since?: number
    category?: string
  }): DiagnosticLog[]
  /** Clear all stored logs. */
  clear(): void
}
