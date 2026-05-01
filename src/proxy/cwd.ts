/**
 * Resolve the SDK subprocess `cwd:` option, falling back to a known-valid
 * path on the proxy host when the resolved working directory doesn't exist.
 *
 * Background — issue #381:
 *   When meridian runs on a remote machine (e.g. accessed over Tailscale)
 *   and the client (OpenCode/Crush/etc.) runs on a different machine, the
 *   adapter extracts the client's reported working directory and passes it
 *   to the SDK as `cwd:`. That path doesn't exist on the proxy host, so
 *   `child_process.spawn(claude, { cwd })` fails with ENOENT — which the
 *   SDK then reports as the misleading "Claude Code native binary not
 *   found at ..." error.
 *
 *   Falling back to the proxy's own `process.cwd()` lets the SDK spawn
 *   succeed; `clientWorkingDirectory` is tracked separately (and emitted
 *   into the model's context via buildCwdNote) so the model still hears
 *   about the user's real working directory.
 */

import { existsSync } from "node:fs"

export interface CwdResolution {
  /** Path passed to the SDK as `cwd:`. Always exists on the proxy host. */
  workingDirectory: string
  /**
   * The originally-resolved path before existence validation. May not
   * exist on the proxy host. Used as `clientWorkingDirectory` for
   * fingerprint bucketing and the system-prompt cwdNote.
   */
  claimedWorkingDirectory: string
  /** True if `workingDirectory` differs from `claimedWorkingDirectory`. */
  fellBack: boolean
}

export interface ResolveCwdOpts {
  /** MERIDIAN_WORKDIR / CLAUDE_PROXY_WORKDIR (highest precedence). */
  envOverride: string | undefined
  /** Adapter's extracted client working directory. */
  adapterCwd: string | undefined
  /** Last-resort fallback. Must exist; typically `process.cwd()`. */
  fallback: string
  /** Injection point for tests. Defaults to `node:fs`'s existsSync. */
  exists?: (path: string) => boolean
}

export function resolveSdkWorkingDirectory(opts: ResolveCwdOpts): CwdResolution {
  const exists = opts.exists ?? existsSync
  const claimed = opts.envOverride || opts.adapterCwd || opts.fallback
  if (exists(claimed)) {
    return { workingDirectory: claimed, claimedWorkingDirectory: claimed, fellBack: false }
  }
  return { workingDirectory: opts.fallback, claimedWorkingDirectory: claimed, fellBack: true }
}
