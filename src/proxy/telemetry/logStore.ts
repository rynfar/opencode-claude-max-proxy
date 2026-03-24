/**
 * In-memory ring buffer for diagnostic log messages.
 *
 * Captures session management events (compaction, undo, diverged, resume)
 * and surfaces them via the telemetry API and dashboard. Replaces the need
 * for users to dig through stderr to report issues.
 */

export interface DiagnosticLog {
  /** Unix timestamp */
  timestamp: number
  /** Log level */
  level: "info" | "warn" | "error"
  /** Log category for filtering */
  category: "session" | "lineage" | "error" | "lifecycle"
  /** Request ID (if associated with a request) */
  requestId?: string
  /** Human-readable message */
  message: string
}

const DEFAULT_CAPACITY = 500

export class DiagnosticLogStore {
  private buffer: (DiagnosticLog | null)[]
  private head = 0
  private count = 0
  private readonly capacity: number

  constructor(capacity?: number) {
    this.capacity = capacity ?? DEFAULT_CAPACITY
    this.buffer = new Array(this.capacity).fill(null)
  }

  /** Append a log entry. */
  log(entry: Omit<DiagnosticLog, "timestamp">): void {
    this.buffer[this.head] = { ...entry, timestamp: Date.now() }
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Convenience: log a session event. */
  session(message: string, requestId?: string): void {
    this.log({ level: "info", category: "session", message, requestId })
  }

  /** Convenience: log a lineage event (compaction, undo, diverged). */
  lineage(message: string, requestId?: string): void {
    this.log({ level: "warn", category: "lineage", message, requestId })
  }

  /** Convenience: log an error. */
  error(message: string, requestId?: string): void {
    this.log({ level: "error", category: "error", message, requestId })
  }

  /**
   * Retrieve recent logs, newest first.
   * @param options.limit - Max entries (default: 100)
   * @param options.since - Only entries after this timestamp
   * @param options.category - Filter by category
   */
  getRecent(options: { limit?: number; since?: number; category?: string } = {}): DiagnosticLog[] {
    const { limit = 100, since, category } = options
    const results: DiagnosticLog[] = []

    for (let i = 0; i < this.count && results.length < limit; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity
      const entry = this.buffer[idx]
      if (!entry) continue
      if (since && entry.timestamp < since) break
      if (category && entry.category !== category) continue
      results.push(entry)
    }

    return results
  }

  /** Clear all stored logs. */
  clear(): void {
    this.buffer = new Array(this.capacity).fill(null)
    this.head = 0
    this.count = 0
  }
}

/** Singleton instance used by the proxy. */
export const diagnosticLog = new DiagnosticLogStore()
