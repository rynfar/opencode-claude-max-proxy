/**
 * Pure classifier that turns a per-request options snapshot into two
 * decisions for the persistent-mode dispatcher (design §D4):
 *
 *   reopenCriticalHash → if this differs from the runtime's snapshot,
 *     the runtime must close + cold-reattach with the new options.
 *
 *   inPlaceUpdates → list of `setModel` / `applyFlagSettings` calls the
 *     server should make on the live Query before pushing the turn's
 *     user message. Applies only when reopen is NOT required (model /
 *     effort / thinking only; reopen-critical changes subsume these).
 *
 * This file is pure: no I/O, no SDK import, no `server.ts` knowledge. The
 * server dispatcher consumes it in §5.5c (reopen orchestrator) and
 * §5.5b (in-place applier). Unit-testable without mocks.
 */

import { hashReopenCriticalOptions, type ReopenCriticalOptions } from "./runtime"

export interface InPlaceOptions {
  model?: string
  effort?: unknown
  thinking?: unknown
  taskBudget?: unknown
  maxBudgetUsd?: unknown
  fallbackModel?: string
}

export interface RuntimeOptionsSnapshot {
  reopenCriticalHash: string
  inPlace: InPlaceOptions
}

export type InPlaceUpdate =
  | { kind: "setModel"; model: string | undefined }
  | { kind: "applyFlagSettings"; settings: Record<string, unknown> }

export interface OptionsDriftClassification {
  /** Hash of the reopen-critical subset of the request options. */
  reopenCriticalHash: string
  /** True if the request's reopen-critical hash differs from the runtime's. */
  hashMismatch: boolean
  /** Ordered list of in-place updates to apply BEFORE pushing this turn. */
  inPlaceUpdates: InPlaceUpdate[]
}

/**
 * Capture the runtime-construction-time snapshot of the options that matter
 * for drift detection. Called when a new `SessionRuntime` is created so the
 * manager can compare future requests against it.
 */
export function snapshotOptions(
  reopenCritical: ReopenCriticalOptions,
  inPlace: InPlaceOptions,
): RuntimeOptionsSnapshot {
  return {
    reopenCriticalHash: hashReopenCriticalOptions(reopenCritical),
    inPlace: { ...inPlace },
  }
}

/**
 * Classify a request's options against the runtime's snapshot. The caller
 * passes in the subset that was already extracted from the adapter + request
 * body — this function does not re-parse.
 */
export function classifyOptionsDrift(
  request: { reopenCritical: ReopenCriticalOptions; inPlace: InPlaceOptions },
  snapshot: RuntimeOptionsSnapshot,
): OptionsDriftClassification {
  const reopenCriticalHash = hashReopenCriticalOptions(request.reopenCritical)
  const hashMismatch = reopenCriticalHash !== snapshot.reopenCriticalHash

  if (hashMismatch) {
    // When we reopen, the new runtime captures the new snapshot — no
    // in-place updates needed (they'd be applied against a dead runtime).
    return { reopenCriticalHash, hashMismatch: true, inPlaceUpdates: [] }
  }

  const inPlaceUpdates: InPlaceUpdate[] = []
  if (!Object.is(request.inPlace.model, snapshot.inPlace.model)) {
    inPlaceUpdates.push({ kind: "setModel", model: request.inPlace.model })
  }

  const flagDiff = buildFlagSettingsDelta(request.inPlace, snapshot.inPlace)
  if (flagDiff) inPlaceUpdates.push({ kind: "applyFlagSettings", settings: flagDiff })

  return { reopenCriticalHash, hashMismatch: false, inPlaceUpdates }
}

/**
 * Build the `Settings` object to pass to `Query.applyFlagSettings()` when
 * non-model in-place-updatable options change between turns. Returns `null`
 * if nothing changed. Only includes keys that actually differ so we don't
 * re-apply stable settings on every turn.
 */
function buildFlagSettingsDelta(
  request: InPlaceOptions,
  snapshot: InPlaceOptions,
): Record<string, unknown> | null {
  const diff: Record<string, unknown> = {}
  const keys: Array<keyof InPlaceOptions> = ["effort", "thinking", "taskBudget", "maxBudgetUsd", "fallbackModel"]
  for (const key of keys) {
    if (!deepEqual(request[key], snapshot[key])) {
      diff[key] = request[key]
    }
  }
  return Object.keys(diff).length === 0 ? null : diff
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null) return a === b
  if (typeof a !== "object" || typeof b !== "object") return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const aKeys = Object.keys(a as object).sort()
  const bKeys = Object.keys(b as object).sort()
  if (aKeys.length !== bKeys.length) return false
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false
    if (!deepEqual((a as Record<string, unknown>)[aKeys[i]!], (b as Record<string, unknown>)[aKeys[i]!])) return false
  }
  return true
}
