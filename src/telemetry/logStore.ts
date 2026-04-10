/**
 * In-memory ring buffer for diagnostic log messages.
 *
 * Captures session management events (compaction, undo, diverged, resume)
 * and surfaces them via the telemetry API and dashboard. Replaces the need
 * for users to dig through stderr to report issues.
 */

import type { DiagnosticLog, IDiagnosticLogStore } from "./types"
export type { DiagnosticLog } from "./types"

const DEFAULT_CAPACITY = 500

export class MemoryDiagnosticLogStore implements IDiagnosticLogStore {
  private buffer: (DiagnosticLog | null)[]
  private head = 0
  private count = 0
  private readonly capacity: number

  constructor(capacity?: number) {
    this.capacity = capacity ?? DEFAULT_CAPACITY
    this.buffer = new Array(this.capacity).fill(null)
  }

  log(entry: Omit<DiagnosticLog, "timestamp">): void {
    this.buffer[this.head] = { ...entry, timestamp: Date.now() }
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
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

  clear(): void {
    this.buffer = new Array(this.capacity).fill(null)
    this.head = 0
    this.count = 0
  }
}

/** Singleton instance used by the proxy. */
export const diagnosticLog = new MemoryDiagnosticLogStore()
