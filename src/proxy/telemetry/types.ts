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
  requestId: string;

  /** When this metric was recorded */
  timestamp: number;

  /** Model used (sonnet, opus, haiku) */
  model: string;

  /** Streaming or non-streaming */
  mode: "stream" | "non-stream";

  /** Whether the request used session resume */
  isResume: boolean;

  /** Whether passthrough mode was active */
  isPassthrough: boolean;

  /** Session lineage classification: how the incoming messages related to the stored session.
   *  - continuation: normal follow-up (prefix matched)
   *  - compaction:   older messages rewritten, recent preserved (suffix matched)
   *  - undo:         user undid recent messages (prefix preserved, suffix changed) → SDK fork
   *  - diverged:     no overlap with stored session → fresh start
   *  - new:          first request, no stored session to compare */
  lineageType?: "continuation" | "compaction" | "undo" | "diverged" | "new"

  /** Number of messages in the request */
  messageCount?: number

  /** SDK session ID used for this request (for correlating across turns) */
  sdkSessionId?: string

  /** HTTP status code returned to the client */
  status: number;

  /** Time spent waiting in the concurrency queue (ms) */
  queueWaitMs: number;

  /** Time spent in proxy processing before SDK call — request parsing,
   *  session lookup, prompt building (ms). If this is high, the proxy
   *  is the bottleneck. Typically <50ms. */
  proxyOverheadMs: number;

  /** Time from SDK query start to first content chunk (ms) */
  ttfbMs: number | null;

  /** Total time the SDK query took (ms) */
  upstreamDurationMs: number;

  /** Total time from request received to response sent (ms) */
  totalDurationMs: number;

  /** Number of content blocks in the response */
  contentBlocks: number;

  /** Number of text stream events forwarded (streaming only) */
  textEvents: number;

  /** Error type if the request failed, null if successful */
  error: string | null;
}

export interface PhaseTiming {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;
}

export interface TelemetrySummary {
  /** Time window these stats cover */
  windowMs: number;
  /** Total requests in the window */
  totalRequests: number;
  /** Requests that returned an error */
  errorCount: number;
  /** Requests per minute */
  requestsPerMinute: number;

  /** Timing breakdowns by phase */
  queueWait: PhaseTiming;
  proxyOverhead: PhaseTiming;
  ttfb: PhaseTiming;
  upstreamDuration: PhaseTiming;
  totalDuration: PhaseTiming;

  /** Breakdown by model */
  byModel: Record<string, { count: number; avgTotalMs: number }>;
  /** Breakdown by mode */
  byMode: Record<string, { count: number; avgTotalMs: number }>;
}
