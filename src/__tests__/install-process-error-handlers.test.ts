/**
 * installProxyProcessErrorHandlers — library safety net
 *
 * The CLI (bin/cli.ts) has long installed uncaughtException + unhandledRejection
 * handlers so that socket-level errors (EPIPE, ECONNRESET) and SDK subprocess
 * crashes don't kill the proxy. Until this commit those handlers lived only in
 * the CLI, so library consumers (e.g. era-code's in-process startProxyServer
 * call) had no safety net — a single mid-stream EPIPE crashed the host process
 * and orphaned downstream agents.
 *
 * This test verifies the exported helper is idempotent and actually attaches
 * listeners. It is intentionally narrow: no socket simulation; that integration
 * is exercised by the proxy stream tests + manual e2e.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installProxyProcessErrorHandlers } from "../proxy/server"

describe("installProxyProcessErrorHandlers", () => {
  let originalUncaught: NodeJS.UncaughtExceptionListener[]
  let originalRejection: NodeJS.UnhandledRejectionListener[]

  beforeEach(() => {
    originalUncaught = process.listeners("uncaughtException")
    originalRejection = process.listeners("unhandledRejection")
  })

  afterEach(() => {
    // Detach anything we may have added; restore the snapshot.
    for (const listener of process.listeners("uncaughtException")) {
      if (!originalUncaught.includes(listener)) {
        process.off("uncaughtException", listener)
      }
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!originalRejection.includes(listener)) {
        process.off("unhandledRejection", listener)
      }
    }
  })

  it("attaches uncaughtException + unhandledRejection listeners", () => {
    const beforeUncaught = process.listenerCount("uncaughtException")
    const beforeRejection = process.listenerCount("unhandledRejection")

    installProxyProcessErrorHandlers()

    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught + 1)
    expect(process.listenerCount("unhandledRejection")).toBe(beforeRejection + 1)
  })

  it("is idempotent — second call is a no-op", () => {
    installProxyProcessErrorHandlers()
    const after1Uncaught = process.listenerCount("uncaughtException")
    const after1Rejection = process.listenerCount("unhandledRejection")

    installProxyProcessErrorHandlers()

    expect(process.listenerCount("uncaughtException")).toBe(after1Uncaught)
    expect(process.listenerCount("unhandledRejection")).toBe(after1Rejection)
  })
})
