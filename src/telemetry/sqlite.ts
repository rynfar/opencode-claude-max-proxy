import Database from "libsql"
import type { RequestMetric, TelemetrySummary, ITelemetryStore, IDiagnosticLogStore, DiagnosticLog } from "./types"
import { computeSummary } from "./percentiles"

const METRICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS metrics (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id           TEXT    NOT NULL,
  timestamp            INTEGER NOT NULL,
  adapter              TEXT,
  model                TEXT    NOT NULL,
  request_model        TEXT,
  mode                 TEXT    NOT NULL,
  is_resume            INTEGER NOT NULL,
  is_passthrough       INTEGER NOT NULL,
  lineage_type         TEXT,
  has_deferred_tools   INTEGER,
  deferred_tool_count  INTEGER,
  tool_count           INTEGER,
  discovered_tools     TEXT,
  session_discovered_count INTEGER,
  message_count        INTEGER,
  sdk_session_id       TEXT,
  status               INTEGER NOT NULL,
  queue_wait_ms        REAL    NOT NULL,
  proxy_overhead_ms    REAL    NOT NULL,
  ttfb_ms              REAL,
  upstream_duration_ms REAL    NOT NULL,
  total_duration_ms    REAL    NOT NULL,
  content_blocks       INTEGER NOT NULL,
  text_events          INTEGER NOT NULL,
  error                TEXT,
  input_tokens         INTEGER,
  output_tokens        INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_hit_rate       REAL
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts    ON metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_metrics_model ON metrics(model);
CREATE INDEX IF NOT EXISTS idx_metrics_session_success ON metrics(sdk_session_id, timestamp DESC, id DESC);
`

const LOGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS diagnostic_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  INTEGER NOT NULL,
  level      TEXT    NOT NULL,
  category   TEXT    NOT NULL,
  request_id TEXT,
  message    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_ts  ON diagnostic_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_cat ON diagnostic_logs(category);
`

const CLEANUP_INTERVAL = 1000

function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  db.exec(METRICS_SCHEMA)
  db.exec(LOGS_SCHEMA)
  return db
}

class SqliteTelemetryStore implements ITelemetryStore {
  private db: Database.Database
  private retentionMs: number
  private insertCount = 0
  private insertStmt: Database.Statement
  private countStmt: Database.Statement

  constructor(db: Database.Database, retentionDays: number) {
    this.db = db
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000

    this.insertStmt = db.prepare(`
      INSERT INTO metrics (
        request_id, timestamp, adapter, model, request_model, mode,
        is_resume, is_passthrough, lineage_type,
        has_deferred_tools, deferred_tool_count, tool_count, discovered_tools, session_discovered_count,
        message_count, sdk_session_id,
        status, queue_wait_ms, proxy_overhead_ms, ttfb_ms,
        upstream_duration_ms, total_duration_ms, content_blocks, text_events, error,
        input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, cache_hit_rate
      ) VALUES (
        @requestId, @timestamp, @adapter, @model, @requestModel, @mode,
        @isResume, @isPassthrough, @lineageType,
        @hasDeferredTools, @deferredToolCount, @toolCount, @discoveredTools, @sessionDiscoveredCount,
        @messageCount, @sdkSessionId,
        @status, @queueWaitMs, @proxyOverheadMs, @ttfbMs,
        @upstreamDurationMs, @totalDurationMs, @contentBlocks, @textEvents, @error,
        @inputTokens, @outputTokens, @cacheReadInputTokens,
        @cacheCreationInputTokens, @cacheHitRate
      )
    `)

    this.countStmt = db.prepare("SELECT COUNT(*) as cnt FROM metrics")
  }

  record(metric: RequestMetric): void {
    try {
      this.insertStmt.run({
        requestId: metric.requestId,
        timestamp: metric.timestamp,
        adapter: metric.adapter ?? null,
        model: metric.model,
        requestModel: metric.requestModel ?? null,
        mode: metric.mode,
        isResume: metric.isResume ? 1 : 0,
        isPassthrough: metric.isPassthrough ? 1 : 0,
        lineageType: metric.lineageType ?? null,
        hasDeferredTools: metric.hasDeferredTools ? 1 : metric.hasDeferredTools === false ? 0 : null,
        deferredToolCount: metric.deferredToolCount ?? null,
        toolCount: metric.toolCount ?? null,
        discoveredTools: metric.discoveredTools ? JSON.stringify(metric.discoveredTools) : null,
        sessionDiscoveredCount: metric.sessionDiscoveredCount ?? null,
        messageCount: metric.messageCount ?? null,
        sdkSessionId: metric.sdkSessionId ?? null,
        status: metric.status,
        queueWaitMs: metric.queueWaitMs,
        proxyOverheadMs: metric.proxyOverheadMs,
        ttfbMs: metric.ttfbMs ?? null,
        upstreamDurationMs: metric.upstreamDurationMs,
        totalDurationMs: metric.totalDurationMs,
        contentBlocks: metric.contentBlocks,
        textEvents: metric.textEvents,
        error: metric.error ?? null,
        inputTokens: metric.inputTokens ?? null,
        outputTokens: metric.outputTokens ?? null,
        cacheReadInputTokens: metric.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: metric.cacheCreationInputTokens ?? null,
        cacheHitRate: metric.cacheHitRate ?? null,
      })
    } catch (err) {
      console.error("[telemetry] SQLite write failed, skipping:", err)
      return
    }
    if (++this.insertCount % CLEANUP_INTERVAL === 0) {
      this.cleanup()
    }
  }

  get size(): number {
    try {
      return (this.countStmt.get() as { cnt: number }).cnt
    } catch {
      return 0
    }
  }

  getRecent(options: { limit?: number; since?: number; model?: string } = {}): RequestMetric[] {
    const { limit = 50, since, model } = options
    const conditions: string[] = []
    const params: Record<string, unknown> = { limit }

    if (since !== undefined) {
      conditions.push("timestamp >= @since")
      params.since = since
    }
    if (model !== undefined) {
      conditions.push("model = @model")
      params.model = model
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const sql = `SELECT * FROM metrics ${where} ORDER BY timestamp DESC, id DESC LIMIT @limit`

    try {
      const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[]
      return rows.map(rowToMetric)
    } catch {
      return []
    }
  }

  getLastForSession(sdkSessionId: string): RequestMetric | undefined {
    try {
      const row = this.db.prepare(
        `SELECT * FROM metrics WHERE sdk_session_id = ? AND error IS NULL ORDER BY timestamp DESC, id DESC LIMIT 1`
      ).get(sdkSessionId) as Record<string, unknown> | undefined
      return row ? rowToMetric(row) : undefined
    } catch {
      return undefined
    }
  }

  summarize(windowMs: number = 60 * 60 * 1000): TelemetrySummary {
    const since = Date.now() - windowMs
    const metrics = this.getRecent({ limit: 100_000, since })
    return computeSummary(metrics, windowMs)
  }

  clear(): void {
    try {
      this.db.exec("DELETE FROM metrics")
    } catch { /* ignore */ }
  }

  cleanup(): void {
    try {
      const cutoff = Date.now() - this.retentionMs
      this.db.prepare("DELETE FROM metrics WHERE timestamp < ?").run(cutoff)
      this.db.prepare("DELETE FROM diagnostic_logs WHERE timestamp < ?").run(cutoff)
      this.db.pragma("wal_checkpoint(TRUNCATE)")
    } catch (err) {
      console.error("[telemetry] SQLite cleanup failed:", err)
    }
  }
}

class SqliteDiagnosticLogStore implements IDiagnosticLogStore {
  private db: Database.Database
  private insertStmt: Database.Statement

  constructor(db: Database.Database) {
    this.db = db
    this.insertStmt = db.prepare(`
      INSERT INTO diagnostic_logs (timestamp, level, category, request_id, message)
      VALUES (@timestamp, @level, @category, @requestId, @message)
    `)
  }

  log(entry: Omit<DiagnosticLog, "timestamp">): void {
    try {
      this.insertStmt.run({
        timestamp: Date.now(),
        level: entry.level,
        category: entry.category,
        requestId: entry.requestId ?? null,
        message: entry.message,
      })
    } catch (err) {
      console.error("[telemetry] SQLite log write failed:", err)
    }
  }

  session(message: string, requestId?: string): void {
    this.log({ level: "info", category: "session", message, requestId })
  }

  lineage(message: string, requestId?: string): void {
    this.log({ level: "warn", category: "lineage", message, requestId })
  }

  error(message: string, requestId?: string): void {
    this.log({ level: "error", category: "error", message, requestId })
  }

  getRecent(options: { limit?: number; since?: number; category?: string } = {}): DiagnosticLog[] {
    const { limit = 100, since, category } = options
    const conditions: string[] = []
    const params: Record<string, unknown> = { limit }

    if (since !== undefined) {
      conditions.push("timestamp >= @since")
      params.since = since
    }
    if (category !== undefined) {
      conditions.push("category = @category")
      params.category = category
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
    const sql = `SELECT * FROM diagnostic_logs ${where} ORDER BY timestamp DESC, id DESC LIMIT @limit`

    try {
      const rows = this.db.prepare(sql).all(params) as Record<string, unknown>[]
      return rows.map((r) => ({
        timestamp: r.timestamp as number,
        level: r.level as DiagnosticLog["level"],
        category: r.category as DiagnosticLog["category"],
        requestId: (r.request_id as string) ?? undefined,
        message: r.message as string,
      }))
    } catch {
      return []
    }
  }

  clear(): void {
    try {
      this.db.exec("DELETE FROM diagnostic_logs")
    } catch { /* ignore */ }
  }
}

function rowToMetric(r: Record<string, unknown>): RequestMetric {
  return {
    requestId: r.request_id as string,
    timestamp: r.timestamp as number,
    adapter: (r.adapter as string) ?? undefined,
    model: r.model as string,
    requestModel: (r.request_model as string) ?? undefined,
    mode: r.mode as RequestMetric["mode"],
    isResume: r.is_resume === 1,
    isPassthrough: r.is_passthrough === 1,
    lineageType: (r.lineage_type as RequestMetric["lineageType"]) ?? undefined,
    hasDeferredTools: r.has_deferred_tools === 1 ? true : r.has_deferred_tools === 0 ? false : undefined,
    deferredToolCount: (r.deferred_tool_count as number) ?? undefined,
    toolCount: (r.tool_count as number) ?? undefined,
    discoveredTools: r.discovered_tools ? JSON.parse(r.discovered_tools as string) : undefined,
    sessionDiscoveredCount: (r.session_discovered_count as number) ?? undefined,
    messageCount: (r.message_count as number) ?? undefined,
    sdkSessionId: (r.sdk_session_id as string) ?? undefined,
    status: r.status as number,
    queueWaitMs: r.queue_wait_ms as number,
    proxyOverheadMs: r.proxy_overhead_ms as number,
    ttfbMs: (r.ttfb_ms as number) ?? null,
    upstreamDurationMs: r.upstream_duration_ms as number,
    totalDurationMs: r.total_duration_ms as number,
    contentBlocks: r.content_blocks as number,
    textEvents: r.text_events as number,
    error: (r.error as string) ?? null,
    inputTokens: (r.input_tokens as number) ?? undefined,
    outputTokens: (r.output_tokens as number) ?? undefined,
    cacheReadInputTokens: (r.cache_read_input_tokens as number) ?? undefined,
    cacheCreationInputTokens: (r.cache_creation_input_tokens as number) ?? undefined,
    cacheHitRate: (r.cache_hit_rate as number) ?? undefined,
  }
}

export function createSqliteStores(dbPath: string, retentionDays: number) {
  const db = openDatabase(dbPath)
  return {
    telemetry: new SqliteTelemetryStore(db, retentionDays) as ITelemetryStore,
    diagnostics: new SqliteDiagnosticLogStore(db) as IDiagnosticLogStore,
    close: () => { try { db.close() } catch { /* ignore */ } },
  }
}
