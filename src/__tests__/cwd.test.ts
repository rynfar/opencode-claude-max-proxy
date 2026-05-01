/**
 * Unit tests for resolveSdkWorkingDirectory.
 *
 * Verifies the precedence chain (env > adapter > fallback) and the
 * existsSync-based fallback that fixes the remote-host issue (#381).
 */

import { describe, it, expect } from "bun:test"
import { resolveSdkWorkingDirectory } from "../proxy/cwd"

describe("resolveSdkWorkingDirectory", () => {
  it("uses env override when set and exists", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/env/path",
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: (p) => p === "/env/path",
    })
    expect(r.workingDirectory).toBe("/env/path")
    expect(r.claimedWorkingDirectory).toBe("/env/path")
    expect(r.fellBack).toBe(false)
  })

  it("uses adapter cwd when env is unset and adapter cwd exists", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: (p) => p === "/adapter/path",
    })
    expect(r.workingDirectory).toBe("/adapter/path")
    expect(r.claimedWorkingDirectory).toBe("/adapter/path")
    expect(r.fellBack).toBe(false)
  })

  it("uses fallback when both env and adapter are unset", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: undefined,
      fallback: "/fallback",
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/fallback")
    expect(r.claimedWorkingDirectory).toBe("/fallback")
    expect(r.fellBack).toBe(false)
  })

  // Regression for #381 — when client supplies a working directory that
  // doesn't exist on the proxy host (remote-host setup), we MUST fall back
  // to the proxy's own cwd or the SDK spawn dies with ENOENT.
  it("falls back to fallback when adapter cwd doesn't exist (remote-host case)", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: "/Users/clientmachine/proj",
      fallback: "/home/proxy",
      exists: (p) => p === "/home/proxy", // adapter path missing on proxy host
    })
    expect(r.workingDirectory).toBe("/home/proxy")
    expect(r.claimedWorkingDirectory).toBe("/Users/clientmachine/proj")
    expect(r.fellBack).toBe(true)
  })

  it("falls back when env override doesn't exist", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/missing",
      adapterCwd: undefined,
      fallback: "/home/proxy",
      exists: (p) => p === "/home/proxy",
    })
    expect(r.workingDirectory).toBe("/home/proxy")
    expect(r.claimedWorkingDirectory).toBe("/missing")
    expect(r.fellBack).toBe(true)
  })

  it("env override beats adapter cwd even when adapter cwd exists", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/env/path",
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: () => true, // both exist
    })
    expect(r.workingDirectory).toBe("/env/path")
    expect(r.fellBack).toBe(false)
  })

  it("treats empty string envOverride as unset", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "",
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/adapter/path")
  })
})
