/**
 * Unit tests for `resolveClaudeExecutable` — the pure resolver underlying
 * `resolveClaudeExecutableAsync`. These tests inject mock dependencies so
 * we can simulate Windows behavior, missing binaries, broken stubs, and
 * various PATH-lookup edge cases without touching the real filesystem.
 *
 * Covers the issue space documented in #417 (Windows resolver) and #445
 * (postinstall-broken stub).
 */
import { describe, it, expect } from "bun:test"
import { resolveClaudeExecutable } from "../proxy/models"

type Deps = Parameters<typeof resolveClaudeExecutable>[0]

/**
 * Builds a minimal-deps stub for a single test case. Each filesystem
 * predicate / package resolution / exec call is configurable; defaults
 * mimic an empty environment where everything misses.
 */
function makeDeps(overrides: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> {
  return {
    existsSync: () => false,
    statSync: () => ({ size: 0 }),
    exec: async () => ({ stdout: "" }),
    resolvePackage: (specifier) => {
      throw new Error(`mock: not configured to resolve ${specifier}`)
    },
    envGet: () => undefined,
    platform: "darwin",
    arch: "arm64",
    isBun: false,
    ...overrides,
  }
}

describe("resolveClaudeExecutable: env override", () => {
  it("returns MERIDIAN_CLAUDE_PATH when set and the file exists", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/custom/claude" : undefined),
      existsSync: (p) => p === "/custom/claude",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/custom/claude")
  })

  it("falls through when MERIDIAN_CLAUDE_PATH is set but the file is missing", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/nope" : undefined),
      existsSync: () => false,
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("ignores empty string env value", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "" : undefined),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: bundled binary with stub-size guard", () => {
  it("returns the bundled binary when it exists and is the real ~200 MB binary", async () => {
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/lib/node_modules/@anthropic-ai/claude-code/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      statSync: () => ({ size: 213_404_000 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe(
      "/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    )
  })

  it("skips the bundled binary when it is the ~500 byte stub (postinstall failed)", async () => {
    // This is the issue #445 scenario: install.cjs threw, the stub was
    // never replaced. Resolver must NOT hand back the broken stub.
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/m/claude-code/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-code/bin/claude.exe",
      statSync: () => ({ size: 512 }), // stub
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("treats files at the 4 KB threshold as a stub (boundary check)", async () => {
    // Only the bundled package resolves; subsequent steps must miss so
    // the test isolates the stub-guard behavior.
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/m/claude-code/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-code/bin/claude.exe",
      statSync: () => ({ size: 4096 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("treats files just above 4 KB as a real binary", async () => {
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/m/claude-code/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-code/bin/claude.exe",
      statSync: () => ({ size: 4097 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/m/claude-code/bin/claude.exe")
  })

  it("falls through when the package itself can't be resolved", async () => {
    const deps = makeDeps({
      resolvePackage: () => {
        throw new Error("not found")
      },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: platform-specific peer package", () => {
  it("falls back to claude-code-darwin-arm64 when bundled stub is broken", async () => {
    // Simulates issue #445 on macOS: bundled stub is 500 bytes (skipped),
    // but the platform-specific package binary is intact (~200 MB).
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/m/claude-code/package.json"
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return "/m/claude-code-darwin-arm64/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => {
        if (p === "/m/claude-code/bin/claude.exe") return true // stub exists
        if (p === "/m/claude-code-darwin-arm64/claude") return true // real binary
        return false
      },
      statSync: () => ({ size: 500 }), // bundled is stub
    })
    expect(await resolveClaudeExecutable(deps)).toBe(
      "/m/claude-code-darwin-arm64/claude",
    )
  })

  it("uses claude.exe filename on win32-x64", async () => {
    const deps = makeDeps({
      platform: "win32",
      arch: "x64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-win32-x64/package.json") return "/m/claude-code-win32-x64/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-code-win32-x64/claude.exe",
    })
    expect(await resolveClaudeExecutable(deps)).toBe(
      "/m/claude-code-win32-x64/claude.exe",
    )
  })

  it("works on win32-arm64 too", async () => {
    const deps = makeDeps({
      platform: "win32",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-win32-arm64/package.json") return "/m/claude-code-win32-arm64/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-code-win32-arm64/claude.exe",
    })
    expect(await resolveClaudeExecutable(deps)).toBe(
      "/m/claude-code-win32-arm64/claude.exe",
    )
  })

  it("on linux, also tries the -musl variant", async () => {
    const deps = makeDeps({
      platform: "linux",
      arch: "x64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-linux-x64/package.json") throw new Error("not installed")
        if (s === "@anthropic-ai/claude-code-linux-x64-musl/package.json") return "/m/claude-code-linux-x64-musl/package.json"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-code-linux-x64-musl/claude",
    })
    expect(await resolveClaudeExecutable(deps)).toBe(
      "/m/claude-code-linux-x64-musl/claude",
    )
  })

  it("returns null when no platform package resolves", async () => {
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: () => { throw new Error("not installed") },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: PATH lookup", () => {
  it("uses `where` on Windows", async () => {
    let capturedCmd = ""
    const deps = makeDeps({
      platform: "win32",
      arch: "x64",
      exec: async (cmd) => {
        capturedCmd = cmd
        return { stdout: "C:\\Users\\me\\nodejs\\claude.exe\r\n" }
      },
      existsSync: (p) => p === "C:\\Users\\me\\nodejs\\claude.exe",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("C:\\Users\\me\\nodejs\\claude.exe")
    expect(capturedCmd).toBe("where claude")
  })

  it("uses `which` on POSIX", async () => {
    let capturedCmd = ""
    const deps = makeDeps({
      platform: "darwin",
      exec: async (cmd) => {
        capturedCmd = cmd
        return { stdout: "/usr/local/bin/claude\n" }
      },
      existsSync: (p) => p === "/usr/local/bin/claude",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/usr/local/bin/claude")
    expect(capturedCmd).toBe("which claude")
  })

  it("on Windows, picks the first existing path from a multi-line `where` output", async () => {
    const deps = makeDeps({
      platform: "win32",
      exec: async () => ({
        stdout:
          "C:\\Old\\nodejs\\claude.exe\r\n" +
          "C:\\Users\\me\\nodejs\\claude.exe\r\n" +
          "C:\\Other\\claude.exe\r\n",
      }),
      existsSync: (p) =>
        p === "C:\\Users\\me\\nodejs\\claude.exe" || p === "C:\\Other\\claude.exe",
    })
    // First match-and-exists wins.
    expect(await resolveClaudeExecutable(deps)).toBe("C:\\Users\\me\\nodejs\\claude.exe")
  })

  it("on Windows, filters out mingw-style paths emitted by Git-for-Windows `which.exe`", async () => {
    // This is the exact #417 reporter-described case: Git Bash's `which`
    // emits `/c/...` style paths that Node's `existsSync` rejects.
    // Our implementation uses `where` (cmd builtin), but ALSO defends
    // against ever feeding a /-prefixed path to existsSync on Windows.
    const deps = makeDeps({
      platform: "win32",
      exec: async () => ({ stdout: "/c/nvm4w/nodejs/claude\r\n" }),
      // existsSync would return false for the mingw path anyway, but
      // assert we never try it.
      existsSync: (p) => {
        if (p.startsWith("/c/")) {
          throw new Error("must not call existsSync with mingw-style path on Windows")
        }
        return false
      },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("returns null when the lookup command throws", async () => {
    const deps = makeDeps({
      exec: async () => {
        throw new Error("which: command not found")
      },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("returns null when stdout is empty", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("returns null when stdout has only whitespace", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "\n   \r\n  \n" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: legacy SDK cli.js (bun only)", () => {
  it("returns the SDK cli.js when running under bun", async () => {
    const deps = makeDeps({
      isBun: true,
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk") return "/m/claude-agent-sdk/index.js"
        throw new Error("not configured")
      },
      existsSync: (p) => p === "/m/claude-agent-sdk/cli.js",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/m/claude-agent-sdk/cli.js")
  })

  it("skips the SDK cli.js when not under bun (won't exec js as binary)", async () => {
    const deps = makeDeps({
      isBun: false,
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk") return "/m/claude-agent-sdk/index.js"
        throw new Error("not configured")
      },
      existsSync: () => true, // even if file exists, skip it on non-bun
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: priority ordering", () => {
  it("env override beats every other source", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/explicit/claude" : undefined),
      existsSync: () => true, // every other source would also "succeed"
      resolvePackage: () => "/some/other/path/package.json",
      statSync: () => ({ size: 213_404_000 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/explicit/claude")
  })

  it("bundled real binary beats platform package and PATH lookup", async () => {
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/m/cc/package.json"
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return "/m/cc-d-a/package.json"
        throw new Error("not configured")
      },
      existsSync: () => true,
      statSync: () => ({ size: 213_404_000 }), // bundled is real
      exec: async () => ({ stdout: "/usr/local/bin/claude\n" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/m/cc/bin/claude.exe")
  })

  it("platform package beats PATH lookup when bundled is a stub", async () => {
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return "/m/cc/package.json"
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return "/m/cc-d-a/package.json"
        throw new Error("not configured")
      },
      existsSync: () => true,
      statSync: () => ({ size: 500 }), // stub
      exec: async () => ({ stdout: "/usr/local/bin/claude\n" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/m/cc-d-a/claude")
  })

  it("returns null when ALL sources miss", async () => {
    const deps = makeDeps({
      envGet: () => undefined,
      resolvePackage: () => { throw new Error("nope") },
      existsSync: () => false,
      exec: async () => ({ stdout: "" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})
