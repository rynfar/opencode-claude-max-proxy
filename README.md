# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

A transparent proxy that lets a Claude Max subscription power [OpenCode](https://opencode.ai), preserving multi-model agent routing.

> **Just want to get running?** The [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude) installer handles everything — proxy, CLI, config — in one command. The rest of this README covers the proxy itself.

## Why This Exists

OpenCode targets the Anthropic API. Claude Max provides access to Claude via the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). This proxy bridges the two.

The problem: if the Agent SDK executes tools directly, everything runs through Claude — even when your OpenCode config routes agents to GPT, Gemini, or other providers. The proxy solves this by intercepting tool calls and forwarding them to OpenCode, so your agent routing stays intact.

## How It Works

```
OpenCode ──► Proxy (localhost) ──► Claude Max (Agent SDK)
                                        │
                                   tool_use response
                                        │
             Proxy intercepts ◄─────────┘
             (stop turn)
                  │
                  ▼
             OpenCode agent system
             (routes to GPT-5.4, Gemini, etc.)
                  │
                  ▼
             Proxy resumes SDK ──► Claude continues
                  │
                  ▼
OpenCode ◄── final response
```

The Claude Agent SDK exposes a `PreToolUse` hook that fires before any tool executes. Combined with `maxTurns: 1`, this gives precise control over the execution boundary:

1. **Claude generates a response** with `tool_use` blocks (read a file, delegate to an agent, run a command)
2. **The PreToolUse hook fires** — we capture the tool name, input, and ID, then return `decision: "block"`
3. **The SDK stops** (blocked tool + maxTurns:1 = turn complete) and we have the full tool_use payload
4. **The proxy returns it to OpenCode** as a standard Anthropic API response with `stop_reason: "tool_use"`
5. **OpenCode handles everything** — file reads, shell commands, and crucially, `Task` delegation through its own agent system with full model routing
6. **OpenCode sends `tool_result` back**, the proxy resumes the SDK session, and Claude continues

From Claude's perspective, tool usage proceeds normally. From OpenCode's perspective, it's talking to the Anthropic API.

## Prerequisites

1. **Claude Max subscription** — [Subscribe here](https://claude.ai/settings/billing)
2. **Claude CLI authenticated:**
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```
3. **Clear any existing OpenCode Anthropic auth** — cached auth overrides the proxy:
   ```bash
   opencode auth logout   # select "anthropic" when prompted
   ```

## Install

### npm (recommended)

```bash
npm install -g opencode-claude-max-proxy
```

### From Source

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install
```

> Requires [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`

### Docker

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
docker compose -f docker/docker-compose.yml up -d

# Login to Claude inside the container (one-time)
docker compose -f docker/docker-compose.yml exec proxy claude login

# Verify
curl http://127.0.0.1:3456/health
```

> On macOS, use `./docker/docker-auth.sh` to copy host credentials into the container (handles the keychain/scopes format difference). On Linux, volume-mounting `~/.claude` may work directly.

## Connect OpenCode

Once the proxy is running, point OpenCode at it via environment variables or config file.

### Environment Variables

```bash
# Terminal 1: start the proxy
CLAUDE_PROXY_PASSTHROUGH=1 claude-max-proxy
# or: CLAUDE_PROXY_PASSTHROUGH=1 bun run dev (from source)

# Terminal 2+: connect OpenCode
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

`ANTHROPIC_API_KEY` can be any non-empty string. Authentication is handled by `claude login`.

### Config File

Set the proxy URL in `~/.config/opencode/opencode.json` (global) or your project's `opencode.json`:

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "http://127.0.0.1:3456",
        "apiKey": "dummy"
      }
    }
  }
}
```

This also works with OpenCode Desktop.

## Modes

### Passthrough (recommended)

```bash
CLAUDE_PROXY_PASSTHROUGH=1 claude-max-proxy
```

All tool execution is forwarded to OpenCode. Multi-model agent routing works. Full agent system prompts are preserved.

### Internal

```bash
claude-max-proxy
```

Tools execute inside the proxy via MCP. Subagents run on Claude via the SDK's native system. Simpler conceptually, but all agents use Claude regardless of your config.

|                       | Passthrough            | Internal            |
| --------------------- | ---------------------- | ------------------- |
| Tool execution        | OpenCode               | Proxy (MCP)         |
| Agent delegation      | OpenCode → multi-model | SDK → Claude only   |
| oh-my-opencode models | ✅ Respected           | ❌ All Claude       |
| Agent system prompts  | ✅ Full                | ⚠️ Description only |

## Agent Compatibility

The proxy extracts agent definitions from the `Task` tool description that OpenCode sends in each request. It works with:

- **Native OpenCode** — `build` and `plan` agents
- **[oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)** — `oracle`, `explore`, `librarian`, `sisyphus-junior`, `metis`, `momus`, etc.
- **Custom agents** — anything defined in your `opencode.json`

In internal mode, a `PreToolUse` hook fuzzy-matches agent names (e.g., `general-purpose` → `general`, `Explore` → `explore`). In passthrough mode, OpenCode handles names directly.

## Session Resume

The proxy tracks SDK session IDs and resumes conversations on follow-up requests. Sessions are stored in `~/.cache/opencode-claude-max-proxy/sessions.json`, shared across all proxy instances. An in-memory LRU cache (default 1000 entries, configurable via `CLAUDE_PROXY_MAX_SESSIONS`) provides fast lookups with automatic eviction and disk-store fallback.

Lookup order:

1. **Header-based** — if the OpenCode request includes session headers
2. **Fingerprint-based** (automatic fallback) — hashes the first user message to match returning conversations

Lineage verification detects diverged history (undo, edit, branch) and avoids resuming stale sessions. Sessions expire after 24 hours.

## Configuration

| Variable                            | Default   | Description                                              |
| ----------------------------------- | --------- | -------------------------------------------------------- |
| `CLAUDE_PROXY_PASSTHROUGH`          | (unset)   | Enable passthrough mode to forward all tools to OpenCode |
| `CLAUDE_PROXY_PORT`                 | 3456      | Proxy server port                                        |
| `CLAUDE_PROXY_HOST`                 | 127.0.0.1 | Proxy server host                                        |
| `CLAUDE_PROXY_WORKDIR`              | (cwd)     | Working directory for Claude and tools                   |
| `CLAUDE_PROXY_MAX_CONCURRENT`       | 1         | Max concurrent SDK sessions (increase with caution)      |
| `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | 120       | Connection idle timeout                                  |
| `CLAUDE_PROXY_MAX_SESSIONS`         | 1000      | Max cached session entries (LRU eviction)                |
| `LOG_LEVEL`                         | info      | Log verbosity: `silent`, `error`, `warn`, `info`, `debug`, `verbose` |

## Concurrency

The proxy supports concurrent requests, but the SDK's `cli.js` subprocess can segfault during stream cleanup ([oven-sh/bun#17947](https://github.com/oven-sh/bun/issues/17947)). Responses are always delivered correctly; the crash occurs after completion. The supervisor auto-restarts within a few seconds.

> The [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude) launcher avoids this by giving each terminal its own proxy on a random port.

## FAQ

### Does this work without oh-my-opencode?

Yes. Both modes work with native OpenCode and any custom agents. oh-my-opencode just adds more agents and model routing.

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set. The proxy never uses it — authentication is handled by your `claude login` session through the Agent SDK.

### What about rate limits?

Your Claude Max subscription has its own usage limits. The proxy doesn't add any additional limits.

### Is my data sent anywhere else?

No. The proxy runs locally. Requests go directly to Claude through the official SDK. In passthrough mode, tool execution happens in OpenCode on your machine.

### Why does internal mode use MCP tools?

The Claude Agent SDK uses different parameter names than OpenCode (e.g., `file_path` vs `filePath`). Internal mode provides its own MCP tools with SDK-compatible names. Passthrough mode doesn't need this since OpenCode handles execution directly.

## Troubleshooting

| Problem                       | Solution                                                                  |
| ----------------------------- | ------------------------------------------------------------------------- |
| "Authentication failed"       | Run `claude login` to authenticate                                        |
| "Connection refused"          | Make sure the proxy is running                                            |
| "Port 3456 is already in use" | `kill $(lsof -ti :3456)` or use `CLAUDE_PROXY_PORT=4567`                  |
| Title generation fails        | Set `"small_model": "anthropic/claude-haiku-4-5"` in your OpenCode config |

## Auto-start (macOS)

```bash
cat > ~/Library/LaunchAgents/com.claude-max-proxy.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(pwd)/bin/claude-proxy-supervisor.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>CLAUDE_PROXY_PASSTHROUGH</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

## Development

```bash
bun run dev                           # Watch mode (auto-restart on changes)
bun test                              # Run tests
bun run lint                          # Lint with Biome
bun run typecheck                     # Type-check without emitting
bun run build                         # Compile to dist/
curl http://127.0.0.1:3456/health     # Auth status, subscription, mode
```

### Architecture

```
src/
├── index.ts                # Package exports (logger, createProxyServer, startProxy, stopProxy)
├── proxy/
│   ├── index.ts            # Hono app, routes, Node HTTP server lifecycle
│   ├── env.ts              # Hono env type definitions (telemetry vars)
│   ├── health.ts           # /health endpoint (Claude auth check)
│   ├── throttle.ts         # Concurrency limit for /messages
│   ├── session/
│   │   ├── index.ts        # LRU session cache with disk-store fallback
│   │   ├── store.ts        # Shared file store (~/.cache/…/sessions.json)
│   │   └── lineage.ts      # Fingerprinting & lineage verification
│   └── telemetry/
│       ├── mount.ts        # Route mounting
│       ├── routes.ts       # GET /telemetry, /telemetry/requests, /telemetry/summary
│       ├── store.ts        # Metrics ring buffer
│       ├── context.ts      # Per-request telemetry context
│       ├── dashboard.ts    # HTML dashboard
│       └── types.ts        # Telemetry type definitions
├── providers/
│   ├── messages.ts         # Shared message type utilities
│   ├── errors.ts           # Error classification
│   ├── types.ts            # Shared provider types
│   └── claude/
│       ├── index.ts        # Orchestrator: parse → session → hooks → query
│       ├── parse.ts        # Request parsing & Claude executable resolution
│       ├── prompt.ts       # Message conversion & prompt building
│       ├── options.ts      # SDK query option builder
│       ├── hooks.ts        # PreToolUse hook (tool capture & blocking)
│       ├── agents.ts       # Agent extraction from Task tool description
│       ├── passthrough.ts  # Dynamic MCP tool registration for passthrough mode
│       ├── mcp-tools.ts    # MCP tool definitions for internal mode
│       ├── stream.ts       # Streaming response handler (SSE)
│       ├── non-stream.ts   # Non-streaming response handler
│       ├── errors.ts       # Claude-specific error classification
│       ├── constants.ts    # SDK constants
│       └── types.ts        # Claude provider types
├── logger/
│   ├── index.ts            # Structured logging (consola)
│   └── sanitizer.ts        # Log sanitization
└── utils/
    └── lru-map.ts          # Generic LRU map with eviction callbacks
tests/                      # Unit & integration tests (bun test)
bin/
├── cli.ts                  # CLI entry point
└── claude-proxy-supervisor.sh  # Auto-restart supervisor
docker/
├── Dockerfile              # Multi-stage build (bun build → node:22-alpine)
├── docker-compose.yml      # Docker Compose config
├── entrypoint.sh           # Container entrypoint
└── docker-auth.sh          # macOS credential helper
```

## Disclaimer

This is an **unofficial wrapper** around Anthropic's publicly available [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). It is not affiliated with, endorsed by, or supported by Anthropic.

**Use at your own risk.** It is your responsibility to review and comply with [Anthropic's Terms of Service](https://www.anthropic.com/legal/consumer-terms) and [Authorized Usage Policy](https://www.anthropic.com/legal/aup).

This project calls `query()` from Anthropic's public npm package using your own authenticated account. No API keys are intercepted, no authentication is bypassed, and no proprietary systems are reverse-engineered.

## License

MIT

## Credits

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.

[opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude) installer by [@ianjwhite99](https://github.com/ianjwhite99). Multimodal support based on work by [@juanferreiramorel](https://github.com/juanferreiramorel). Per-terminal proxy idea by [@calebdw](https://github.com/calebdw). README cleanup by [@skipships](https://github.com/skipships).
