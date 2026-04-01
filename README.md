<p align="center">
  <img src="assets/banner.svg" alt="Meridian" width="800"/>
</p>

<p align="center">
  <a href="https://github.com/rynfar/meridian/releases"><img src="https://img.shields.io/github/v/release/rynfar/meridian?style=flat-square&color=6366f1&label=release" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@rynfar/meridian"><img src="https://img.shields.io/npm/v/@rynfar/meridian?style=flat-square&color=8b5cf6&label=npm" alt="npm"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-a78bfa?style=flat-square" alt="Platform"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-c4b5fd?style=flat-square" alt="License"></a>
</p>

---

Meridian turns your Claude Max subscription into a local Anthropic API. Any tool that speaks the Anthropic protocol — OpenCode, Crush, Cline, Continue, Aider — connects to Meridian and gets Claude, powered by your existing subscription through the official Claude Code SDK.

Harness Claude, your way.

> [!NOTE]
> **Renamed from `opencode-claude-max-proxy`.** If you're upgrading, see [`MIGRATION.md`](MIGRATION.md) for the checklist. Your existing sessions, env vars, and agent configs all continue to work.

## Quick Start

```bash
# Install
npm install -g @rynfar/meridian

# Authenticate (one time)
claude login

# Start
meridian
```

Meridian starts on `http://127.0.0.1:3456`. Point any Anthropic-compatible tool at it:

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

The API key value doesn't matter — Meridian authenticates through your Claude Max session, not API keys.

## Why Meridian?

You're paying for Claude Max. It includes programmatic access through the Claude Code SDK. But your favorite coding tools expect an Anthropic API endpoint and an API key.

Meridian bridges that gap. It runs locally, accepts standard Anthropic API requests, and routes them through the SDK using your Max subscription. Claude does the work — Meridian just lets you pick the tool.

<p align="center">
  <img src="assets/how-it-works.svg" alt="How Meridian works" width="920"/>
</p>

## Features

- **Standard Anthropic API** — drop-in compatible with any tool that supports custom `base_url`
- **Session management** — conversations persist across requests, survive compaction and undo, resume after proxy restarts
- **Streaming** — full SSE streaming with MCP tool filtering
- **Concurrent sessions** — run parent + subagent requests in parallel
- **Passthrough mode** — forward tool calls to the client instead of executing internally
- **Multimodal** — images, documents, and file attachments pass through to Claude
- **Telemetry dashboard** — real-time performance metrics at `/telemetry`
- **Cross-proxy resume** — sessions persist to disk and survive restarts
- **Agent adapter pattern** — extensible architecture for supporting new agent protocols

## Agent Setup

### OpenCode

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

For automatic session tracking, use a plugin like [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude), or see the [reference plugin](examples/opencode-plugin/claude-max-headers.ts) to build your own.

### Crush

Add a provider to `~/.config/crush/crush.json`:

```json
{
  "providers": {
    "meridian": {
      "id": "meridian",
      "name": "Meridian",
      "type": "anthropic",
      "base_url": "http://127.0.0.1:3456",
      "api_key": "dummy",
      "models": [
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6 (1M)", "context_window": 1000000, "default_max_tokens": 64000, "can_reason": true, "supports_attachments": true },
        { "id": "claude-opus-4-6",   "name": "Claude Opus 4.6 (1M)",   "context_window": 1000000, "default_max_tokens": 32768, "can_reason": true, "supports_attachments": true },
        { "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "context_window": 200000, "default_max_tokens": 16384, "can_reason": true, "supports_attachments": true }
      ]
    }
  }
}
```

Then use Meridian models in Crush:

```bash
crush run --model meridian/claude-sonnet-4-6 "refactor this function"
crush --model meridian/claude-opus-4-6       # interactive TUI
```

Crush is automatically detected from its `Charm-Crush/` User-Agent — no extra configuration needed. In `crush run` headless mode all tool operations (read, write, bash) execute automatically without prompting.

### Droid (Factory AI)

Droid connects via its BYOK (Bring Your Own Key) feature. This is a one-time setup.

**1. Add Meridian as a custom model provider** in `~/.factory/settings.json`:

```json
{
  "customModels": [
    {
      "model": "claude-sonnet-4-6",
      "name": "Sonnet 4.6 (1M — Meridian)",
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:3456",
      "apiKey": "x"
    },
    {
      "model": "claude-opus-4-6",
      "name": "Opus 4.6 (1M — Meridian)",
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:3456",
      "apiKey": "x"
    },
    {
      "model": "claude-haiku-4-5-20251001",
      "name": "Haiku 4.5 (Meridian)",
      "provider": "anthropic",
      "baseUrl": "http://127.0.0.1:3456",
      "apiKey": "x"
    }
  ]
}
```

The `apiKey` value doesn't matter — Meridian authenticates through your Claude Max session.

**2. In the Droid TUI**, open the model selector (`/model`) and choose any `custom:claude-*` model.

**How models map to Claude Max tiers:**

| Model name in config | Claude Max tier |
|---|---|
| `claude-sonnet-4-6` | `sonnet[1m]` — Sonnet 4.6 with 1M context |
| `claude-opus-4-6` | `opus[1m]` — Opus 4.6 with 1M context |
| `claude-haiku-4-5-20251001` | `haiku` — Haiku 4.5 |
| `claude-sonnet-4-5-*` | `sonnet` — Sonnet 4.5, no extended context |

> **Note:** Droid automatically uses Meridian's internal tool execution mode regardless of the global `CLAUDE_PROXY_PASSTHROUGH` setting. No extra configuration needed.

### Cline

Cline CLI connects by setting `anthropicBaseUrl` in its config. This is a one-time setup.

**1. Authenticate Cline with the Anthropic provider:**

```bash
cline auth --provider anthropic --apikey "dummy" --modelid "claude-sonnet-4-6"
```

**2. Add the proxy base URL** to `~/.cline/data/globalState.json`:

```json
{
  "anthropicBaseUrl": "http://127.0.0.1:3456",
  "actModeApiProvider": "anthropic",
  "actModeApiModelId": "claude-sonnet-4-6"
}
```

**3. Run Cline:**

```bash
cline --yolo "refactor the login function"                       # interactive
cline --yolo --model claude-opus-4-6 "review this codebase"      # opus
cline --yolo --model claude-haiku-4-5-20251001 "quick question"  # haiku (fastest)
```

No adapter or plugin needed — Cline uses the standard Anthropic SDK and falls through to the default adapter. All models (Sonnet 4.6, Opus 4.6, Haiku 4.5) route to their correct Claude Max tiers automatically.

### Aider

Aider works out of the box — no plugin or config file needed:

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 \
  aider --model anthropic/claude-sonnet-4-5-20250929
```

All standard aider features work: file editing, repo-map, git integration, multi-file changes.

> **Note:** Aider's `--no-stream` flag is incompatible due to a litellm parsing issue — use the default streaming mode (no flag needed).

### Any Anthropic-compatible tool

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
# Then start your tool normally
```

## Tested Agents

| Agent | Status | Plugin | Notes |
|-------|--------|--------|-------|
| [OpenCode](https://github.com/anomalyco/opencode) | ✅ Verified | [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude) | Full tool support, session resume, streaming, subagents |
| [Droid (Factory AI)](https://factory.ai/product/ide) | ✅ Verified | BYOK config (see setup above) | Full tool support, session resume, streaming; one-time BYOK setup |
| [Crush](https://github.com/charmbracelet/crush) | ✅ Verified | Provider config (see setup above) | Full tool support, session resume, streaming, headless `crush run` |
| [Cline](https://github.com/cline/cline) | ✅ Verified | Config (see setup above) | Full tool support, file read/write/edit, bash, session resume, all models |
| [Continue](https://github.com/continuedev/continue) | 🔲 Untested | — | Should work — standard Anthropic API |
| [Aider](https://github.com/paul-gauthier/aider) | ✅ Verified | Env vars (see setup above) | File editing, streaming; `--no-stream` broken (litellm bug) |

Tested an agent or built a plugin? [Open an issue](https://github.com/rynfar/meridian/issues) and we'll add it.

## Architecture

Meridian is built as a modular proxy with clean separation of concerns:

```
src/proxy/
├── server.ts              ← HTTP orchestration (routes, SSE streaming, concurrency)
├── adapter.ts             ← AgentAdapter interface (extensibility point)
├── adapters/
│   ├── detect.ts          ← Agent detection from request headers
│   ├── opencode.ts        ← OpenCode adapter
│   ├── crush.ts           ← Crush (Charm) adapter
│   └── droid.ts           ← Droid (Factory AI) adapter
├── query.ts               ← SDK query options builder
├── errors.ts              ← Error classification
├── models.ts              ← Model mapping (sonnet/opus/haiku)
├── tools.ts               ← Tool blocking lists
├── messages.ts            ← Content normalization
├── session/
│   ├── lineage.ts         ← Per-message hashing, mutation classification (pure)
│   ├── fingerprint.ts     ← Conversation fingerprinting
│   └── cache.ts           ← LRU session caches
├── sessionStore.ts        ← Cross-proxy file-based session persistence
├── agentDefs.ts           ← Subagent definition extraction
└── passthroughTools.ts    ← Tool forwarding mode
```

### Session Management

Sessions map agent conversations to Claude SDK sessions. Meridian classifies every incoming request:

| Classification | What Happened | Action |
|---------------|---------------|--------|
| **Continuation** | New messages appended | Resume SDK session |
| **Compaction** | Agent summarized old messages | Resume (suffix preserved) |
| **Undo** | User rolled back messages | Fork at rollback point |
| **Diverged** | Completely different conversation | Start fresh |

Sessions are stored in-memory (LRU) and persisted to `~/.cache/meridian/sessions.json` for cross-proxy resume.

### Adding a New Agent

Implement the `AgentAdapter` interface in `src/proxy/adapters/`:

```typescript
interface AgentAdapter {
  // Required
  getSessionId(c: Context): string | undefined
  extractWorkingDirectory(body: any): string | undefined
  normalizeContent(content: any): string
  getBlockedBuiltinTools(): readonly string[]
  getAgentIncompatibleTools(): readonly string[]
  getMcpServerName(): string
  getAllowedMcpTools(): readonly string[]

  // Optional
  buildSdkAgents?(body: any, mcpToolNames: readonly string[]): Record<string, any>
  buildSdkHooks?(body: any, sdkAgents: Record<string, any>): any
  buildSystemContextAddendum?(body: any, sdkAgents: Record<string, any>): string
  usesPassthrough?(): boolean  // overrides CLAUDE_PROXY_PASSTHROUGH per-agent
}
```

Agent detection is automatic from the `User-Agent` header:

| User-Agent prefix | Adapter |
|---|---|
| `Charm-Crush/` | Crush |
| `factory-cli/` | Droid |
| *(anything else)* | OpenCode (default) |

See [`adapters/detect.ts`](src/proxy/adapters/detect.ts) and [`adapters/opencode.ts`](src/proxy/adapters/opencode.ts) for reference.

## Configuration

| Variable | Alias | Default | Description |
|----------|-------|---------|-------------|
| `MERIDIAN_PORT` | `CLAUDE_PROXY_PORT` | `3456` | Port to listen on |
| `MERIDIAN_HOST` | `CLAUDE_PROXY_HOST` | `127.0.0.1` | Host to bind to |
| `MERIDIAN_PASSTHROUGH` | `CLAUDE_PROXY_PASSTHROUGH` | unset | Forward tool calls to client instead of executing |
| `MERIDIAN_MAX_CONCURRENT` | `CLAUDE_PROXY_MAX_CONCURRENT` | `10` | Maximum concurrent SDK sessions |
| `MERIDIAN_MAX_SESSIONS` | `CLAUDE_PROXY_MAX_SESSIONS` | `1000` | In-memory LRU session cache size |
| `MERIDIAN_MAX_STORED_SESSIONS` | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `10000` | File-based session store capacity |
| `MERIDIAN_WORKDIR` | `CLAUDE_PROXY_WORKDIR` | `cwd()` | Default working directory for SDK |
| `MERIDIAN_IDLE_TIMEOUT_SECONDS` | `CLAUDE_PROXY_IDLE_TIMEOUT_SECONDS` | `120` | HTTP keep-alive timeout |
| `MERIDIAN_TELEMETRY_SIZE` | `CLAUDE_PROXY_TELEMETRY_SIZE` | `1000` | Telemetry ring buffer size |
| `MERIDIAN_NO_FILE_CHANGES` | `CLAUDE_PROXY_NO_FILE_CHANGES` | unset | Disable "Files changed" summary in responses |

## Programmatic API

Meridian can be used as a library for building agent plugins and integrations.

```typescript
import { startProxyServer } from "@rynfar/meridian"

// Start a proxy instance
const instance = await startProxyServer({
  port: 3456,
  host: "127.0.0.1",
  silent: true,  // suppress console output
})

// instance.config  — resolved ProxyConfig
// instance.server  — underlying http.Server

// Shut down cleanly
await instance.close()
```

### Session Header Contract

For reliable session tracking, agents should send a session identifier via HTTP header. Without it, the proxy falls back to fingerprint-based matching (hashing the first user message + working directory), which is less reliable.

| Header | Purpose |
|--------|---------|
| `x-opencode-session` | Maps agent conversations to Claude SDK sessions for resume, undo, and compaction |

The proxy uses this header to maintain conversation continuity across requests. Plugin authors should inject it on every request to `/v1/messages`.

### Plugin Architecture

Meridian is the proxy. Plugins live in the agent's ecosystem.

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  Agent        │  HTTP   │  Meridian    │   SDK   │  Claude Max  │
│  (OpenCode,   │────────▶│  Proxy       │────────▶│              │
│   Crush, etc) │◀────────│              │◀────────│              │
└──────────────┘         └──────────────┘         └──────────────┘
       │
       │ plugin injects headers,
       │ manages proxy lifecycle
       │
┌──────────────┐
│  Agent Plugin │
│  (optional)   │
└──────────────┘
```

A plugin's job is to:
1. Start/stop a Meridian instance (`startProxyServer` / `instance.close()`)
2. Inject session headers into outgoing requests
3. Check proxy health (`GET /health`)

See [`examples/opencode-plugin/`](examples/opencode-plugin/) for a reference implementation.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page (HTML) or status JSON (`Accept: application/json`) |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /messages` | Alias for `/v1/messages` |
| `GET /health` | Auth status, subscription type, mode |
| `GET /telemetry` | Performance dashboard |
| `GET /telemetry/requests` | Recent request metrics (JSON) |
| `GET /telemetry/summary` | Aggregate statistics (JSON) |
| `GET /telemetry/logs` | Diagnostic logs (JSON) |

## Docker

```bash
docker run -v ~/.claude:/home/claude/.claude -p 3456:3456 meridian
```

Or with docker-compose:

```bash
docker compose up -d
```

## Testing

```bash
npm test          # 522 unit/integration tests (bun test)
npm run build     # Build with bun + tsc
```

Three test tiers:

| Tier | What | Speed |
|------|------|-------|
| Unit | Pure functions, no mocks | Fast |
| Integration | HTTP layer with mocked SDK | Fast |
| E2E | Real proxy + real Claude Max ([`E2E.md`](E2E.md)) | Manual |

## FAQ

**Is this allowed by Anthropic's terms?**
Meridian uses the official Claude Code SDK — the same SDK Anthropic publishes and maintains for programmatic access. It authenticates through your existing Claude Max session using OAuth, not API keys. Nothing is modified, reverse-engineered, or bypassed.

**How is this different from using an API key?**
API keys are billed per token. Your Max subscription is a flat monthly fee with higher rate limits. Meridian lets you use that subscription from any compatible tool.

**Does it work with Claude Pro?**
It works with any Claude subscription that supports the Claude Code SDK. Max is recommended for the best rate limits.

**What happens if my session expires?**
The SDK handles token refresh automatically. If it can't refresh, Meridian returns a clear error telling you to run `claude login`.

## Contributing

Issues and PRs welcome. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for module structure and dependency rules, [`CLAUDE.md`](CLAUDE.md) for coding guidelines, and [`E2E.md`](E2E.md) for end-to-end test procedures.

## License

MIT
