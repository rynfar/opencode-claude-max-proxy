/**
 * Rate limit store — captures `SDKRateLimitInfo` events emitted by
 * `@anthropic-ai/claude-agent-sdk`'s `query()` stream.
 *
 * The SDK reports the live Claude Max subscription quota state as
 * `rate_limit_event` events in the form:
 *
 *   {
 *     type: "rate_limit_event",
 *     rate_limit_info: {
 *       status: "allowed" | "allowed_warning" | "rejected",
 *       resetsAt?: number,                              // epoch ms
 *       rateLimitType?: "five_hour" | "seven_day"
 *                     | "seven_day_opus" | "seven_day_sonnet"
 *                     | "overage",
 *       utilization?: number,                           // 0..1
 *       overageStatus?: "allowed" | "allowed_warning" | "rejected",
 *       overageResetsAt?: number,
 *       isUsingOverage?: boolean,
 *       surpassedThreshold?: number,
 *       ...
 *     },
 *     uuid, session_id
 *   }
 *
 * We keep the most recent entry per `rateLimitType` (or "default" if absent)
 * in memory. State resets on proxy restart — that's fine because the SDK will
 * push a fresh event on the next request.
 *
 * Singleton — one Meridian process serves one Claude Max subscription, so
 * all in-flight clients share these counters.
 */

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"

export interface RateLimitEntry extends SDKRateLimitInfo {
  /** When this entry was captured (epoch ms). */
  observedAt: number
}

/** Type discriminator for the entry's bucket key. */
export type RateLimitBucketKey = NonNullable<SDKRateLimitInfo["rateLimitType"]> | "default"

class RateLimitStore {
  private entries = new Map<RateLimitBucketKey, RateLimitEntry>()

  /**
   * Record a rate-limit info snapshot.
   * Last-write-wins per bucket key (rateLimitType). Older entries for the
   * same key are overwritten — clients should treat the latest as canonical.
   */
  record(info: SDKRateLimitInfo | undefined | null): void {
    if (!info || typeof info !== "object") return
    const key: RateLimitBucketKey = info.rateLimitType ?? "default"
    this.entries.set(key, { ...info, observedAt: Date.now() })
  }

  /** Snapshot all current entries, newest-first by observedAt. */
  getAll(): RateLimitEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.observedAt - a.observedAt)
  }

  /** Snapshot a single bucket, or undefined if not yet seen. */
  get(key: RateLimitBucketKey): RateLimitEntry | undefined {
    return this.entries.get(key)
  }

  /** Number of distinct buckets observed. */
  get size(): number {
    return this.entries.size
  }

  /** Drop all stored entries. Used by tests and on `/auth/refresh`. */
  clear(): void {
    this.entries.clear()
  }
}

/**
 * Process-wide singleton. Importers should always use this instance — do
 * not instantiate `RateLimitStore` directly outside of tests.
 */
export const rateLimitStore = new RateLimitStore()

/** Exported for test isolation only. */
export { RateLimitStore as _RateLimitStoreForTests }
