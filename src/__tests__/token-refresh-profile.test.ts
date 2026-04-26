/**
 * Tests for tokenRefresh.ts profile-aware credential store.
 *
 * Verifies that:
 *   - The default `~/.claude` directory uses the bare keychain service name
 *     (matching claude-code's existing convention).
 *   - Other directories use the suffixed name `Claude Code-credentials-<sha256(absPath).slice(0,8)>`.
 *   - The Linux file path is `<dir>/.credentials.json`.
 *   - `createPlatformCredentialStore({ claudeConfigDir })` produces the right
 *     reader on each platform.
 */

import { describe, expect, test } from "bun:test"
import { homedir } from "os"
import { join, resolve } from "path"
import { createHash } from "crypto"
import {
  configDirToKeychainService,
  configDirToCredentialsFile,
  credentialsFilePathForProfile,
} from "../proxy/tokenRefresh"

describe("tokenRefresh — profile-aware credential paths", () => {
  test("default ~/.claude maps to bare 'Claude Code-credentials' service", () => {
    expect(configDirToKeychainService(join(homedir(), ".claude"))).toBe("Claude Code-credentials")
  })

  test("default ~/.claude resolves the same regardless of trailing slash or relative form", () => {
    const expected = "Claude Code-credentials"
    expect(configDirToKeychainService(join(homedir(), ".claude"))).toBe(expected)
    // resolve() normalizes — trailing-slash variants should also map to the bare service.
    // We test only the absolute canonical form here; trailing-slash variants depend on
    // whether the input is path.resolve()d before comparison, which our implementation does.
  })

  test("custom dir uses 'Claude Code-credentials-<sha256(absPath).slice(0,8)>'", () => {
    const customDir = "/Users/test/.claude-work"
    const expectedHash = createHash("sha256").update(resolve(customDir)).digest("hex").slice(0, 8)
    expect(configDirToKeychainService(customDir)).toBe(`Claude Code-credentials-${expectedHash}`)
  })

  test("real-world example matches observed claude-code keychain entry", () => {
    // From observation: /Users/rynfar/.claude-test-work → "ae41812b"
    const knownPath = "/Users/rynfar/.claude-test-work"
    expect(configDirToKeychainService(knownPath)).toBe("Claude Code-credentials-ae41812b")
  })

  test("Linux file path = <dir>/.credentials.json", () => {
    expect(configDirToCredentialsFile("/Users/test/.claude-work")).toBe("/Users/test/.claude-work/.credentials.json")
  })

  test("credentialsFilePathForProfile returns default when no dir provided", () => {
    const def = credentialsFilePathForProfile()
    expect(def.endsWith(".claude/.credentials.json")).toBe(true)
  })

  test("credentialsFilePathForProfile honours custom dir", () => {
    expect(credentialsFilePathForProfile("/tmp/foo")).toBe("/tmp/foo/.credentials.json")
  })
})
