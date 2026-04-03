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

Meridian turns your Claude Max subscription into a local Anthropic API. Any tool that speaks the Anthropic or OpenAI protocol — OpenCode, Crush, Cline, Aider, Open WebUI — connects to Meridian and gets Claude, powered by your existing subscription through the official Claude Code SDK.

> [!NOTE]
> **Renamed from `opencode-claude-max-proxy`.** If you're upgrading, see [`MIGRATION.md`](MIGRATION.md) for the checklist. Your existing sessions, env vars, and agent configs all continue to work.

## Quick Start

```bash
# 1. Install
npm install -g @rynfar/meridian

# 2. Authenticate (one time)
claude login

# 3. Configure OpenCode plugin (one time — OpenCode users only)
meridian setup

# 4. Start
meridian
```

Meridian runs on `http://127.0.0.1:3456`. Point any Anthropic-compatible tool at it:

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

The API key value doesn't matter — Meridian authenticates through your Claude Max session, not API keys.

## Why Meridian?

You're paying for Claude Max. It includes programmatic access through the Claude Code SDK. But your favorite coding tools expect an Anthropic API endpoint and an API key.

Meridian bridges that gap. It runs locally, accepts standard Anthropic API requests, and routes them through the SDK using your Max subscription.

<p align="center">
  <img src="assets/how-it-works.svg" alt="How Meridian works" width="920"/>
</p>

## Features

- **Standard Anthropic API** — drop-in compatible with any tool that supports a custom `base_url`
- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` for tools that only speak the OpenAI protocol (Open WebUI, Continue, etc.) — no LiteLLM needed
- **Session management** — conversations persist across requests, survive compaction and undo, resume after proxy restarts
- **Streaming** — full SSE streaming with MCP tool filtering
- **Concurrent sessions** — run parent and subagent requests in parallel
- **Subagent model selection** — primary agents get 1M context; subagents get 200k, preserving rate-limit budget
- **Auto token refresh** — expired OAuth tokens are refreshed automatically; requests continue without interruption
- **Passthrough mode** — forward tool calls to the client instead of executing internally
- **Multimodal** — images, documents, and file attachments pass through to Claude
- **Telemetry dashboard** — real-time performance metrics at `/telemetry`

## Agent Setup

### OpenCode

**Step 1: Run `meridian setup` (required, one time)**

```bash
meridian setup
```

This adds the Meridian plugin to your OpenCode global config (`~/.config/opencode/opencode.json`). The plugin enables:

- **Session tracking** — reliable conversation continuity across requests
- **Subagent model selection** — primary agents use `sonnet[1m]`; subagents automatically use `sonnet` (200k), preserving your 1M context rate-limit budget

If the plugin is missing, Meridian warns at startup and reports `"plugin": "not-configured"` in the health endpoint.

**Step 2: Start**

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Or set these in your shell profile so they're always active:

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

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

```bash
crush run --model meridian/claude-sonnet-4-6 "refactor this function"
crush --model meridian/claude-opus-4-6       # interactive TUI
```

Crush is automatically detected from its `Charm-Crush/` User-Agent — no plugin needed.

### Droid (Factory AI)

Add Meridian as a custom model provider in `~/.factory/settings.json`:

```json
{
  "customModels": [
    { "model": "claude-sonnet-4-6",       "name": "Sonnet 4.6 (Meridian)", "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-opus-4-6",         "name": "Opus 4.6 (Meridian)",   "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" },
    { "model": "claude-haiku-4-5-20251001", "name": "Haiku 4.5 (Meridian)", "provider": "anthropic", "baseUrl": "http://127.0.0.1:3456", "apiKey": "x" }
  ]
}
```

Then pick any `custom:claude-*` model in the Droid TUI. No plugin needed — Droid is automatically detected.

### Cline

**1. Authenticate:**

```bash
cline auth --provider anthropic --apikey "dummy" --modelid "claude-sonnet-4-6"
```

**2. Set the proxy URL** in `~/.cline/data/globalState.json`:

```json
{
  "anthropicBaseUrl": "http://127.0.0.1:3456",
  "actModeApiProvider": "anthropic",
  "actModeApiModelId": "claude-sonnet-4-6"
}
```

**3. Run:**

```bash
cline --yolo "refactor the login function"
```

No plugin needed — Cline uses the standard Anthropic SDK.

### Aider

```bash
ANTHROPIC_API_KEY=x ANTHROPIC_BASE_URL=http://127.0.0.1:3456 \
  aider --model anthropic/claude-sonnet-4-5-20250929
```

> **Note:** `--no-stream` is incompatible due to a litellm parsing issue — use the default streaming mode.

### OpenAI-compatible tools (Open WebUI, Continue, etc.)

Meridian speaks the OpenAI protocol natively — no LiteLLM or translation proxy needed.

**`POST /v1/chat/completions`** — accepts OpenAI chat format, returns OpenAI completion format (streaming and non-streaming)

**`GET /v1/models`** — returns available Claude models in OpenAI format

Point any OpenAI-compatible tool at `http://127.0.0.1:3456` with any API key value:

```bash
# Open WebUI: set OpenAI API base to http://127.0.0.1:3456, API key to any value
# Continue: set apiBase to http://127.0.0.1:3456 with provider: openai
# Any OpenAI SDK: set base_url="http://127.0.0.1:3456", api_key="dummy"
```

> **Note:** Multi-turn conversations work by packing prior turns into the system prompt. Each request is a fresh SDK session — OpenAI clients replay full history themselves and don't use Meridian's session resumption.

### Any Anthropic-compatible tool

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

## Tested Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [OpenCode](https://github.com/anomalyco/opencode) | ✅ Verified | Requires `meridian setup` — full tool support, session resume, streaming, subagents |
| [Droid (Factory AI)](https://factory.ai/product/ide) | ✅ Verified | BYOK config (see above) — full tool support, session resume, streaming |
| [Crush](https://github.com/charmbracelet/crush) | ✅ Verified | Provider config (see above) — full tool support, session resume, headless `crush run` |
| [Cline](https://github.com/cline/cline) | ✅ Verified | Config (see above) — full tool support, file read/write/edit, bash, session resume |
| [Aider](https://github.com/paul-gauthier/aider) | ✅ Verified | Env vars — file editing, streaming; `--no-stream` broken (litellm bug) |
| [Open WebUI](https://github.com/open-webui/open-webui) | ✅ Verified | OpenAI-compatible endpoints — set base URL to `http://127.0.0.1:3456` |
| [Continue](https://github.com/continuedev/continue) | 🔲 Untested | OpenAI-compatible endpoints should work — set `apiBase` to `http://127.0.0.1:3456` |

Tested an agent or built a plugin? [Open an issue](https://github.com/rynfar/meridian/issues) and we'll add it.

## Architecture

```
src/proxy/
├── server.ts              ← HTTP orchestration (routes, SSE streaming, concurrency)
├── adapter.ts             ← AgentAdapter interface
├── adapters/
│   ├── detect.ts          ← Agent detection from request headers
│   ├── opencode.ts        ← OpenCode adapter
│   ├── crush.ts           ← Crush adapter
│   ├── droid.ts           ← Droid adapter
│   └── passthrough.ts     ← LiteLLM passthrough adapter
├── query.ts               ← SDK query options builder
├── errors.ts              ← Error classification
├── models.ts              ← Model mapping (sonnet/opus/haiku, agentMode)
├── tokenRefresh.ts        ← Cross-platform OAuth token refresh
├── openai.ts              ← OpenAI ↔ Anthropic format translation (pure)
├── setup.ts               ← OpenCode plugin configuration
├── session/
│   ├── lineage.ts         ← Per-message hashing, mutation classification (pure)
│   ├── fingerprint.ts     ← Conversation fingerprinting
│   └── cache.ts           ← LRU session caches
├── sessionStore.ts        ← Cross-proxy file-based session persistence
└── passthroughTools.ts    ← Tool forwarding mode
plugin/
└── meridian.ts            ← OpenCode plugin (session headers + agent mode)
```

### Session Management

Every incoming request is classified:

| Classification | What Happened | Action |
|---------------|---------------|--------|
| **Continuation** | New messages appended | Resume SDK session |
| **Compaction** | Agent summarized old messages | Resume (suffix preserved) |
| **Undo** | User rolled back messages | Fork at rollback point |
| **Diverged** | Completely different conversation | Start fresh |

Sessions are stored in-memory (LRU) and persisted to `~/.cache/meridian/sessions.json` for cross-proxy resume.

### Agent Detection

Agents are identified from request headers automatically:

| User-Agent prefix | Adapter |
|---|---|
| `Charm-Crush/` | Crush |
| `factory-cli/` | Droid |
| *(anything else)* | OpenCode (default) |

### Adding a New Agent

Implement the `AgentAdapter` interface in `src/proxy/adapters/`. See [`adapters/opencode.ts`](src/proxy/adapters/opencode.ts) for a reference.

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
| `MERIDIAN_SONNET_MODEL` | `CLAUDE_PROXY_SONNET_MODEL` | `sonnet[1m]`* | Force sonnet tier: `sonnet` (200k) or `sonnet[1m]` (1M). Set to `sonnet` if you hit 1M context rate limits |

*`sonnet[1m]` requires Max subscription with Extra Usage enabled. Falls back to `sonnet` automatically if not available.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page |
| `POST /v1/messages` | Anthropic Messages API |
| `POST /messages` | Alias for `/v1/messages` |
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `GET /v1/models` | OpenAI-compatible model list |
| `GET /health` | Auth status, mode, plugin status |
| `POST /auth/refresh` | Manually refresh the OAuth token |
| `GET /telemetry` | Performance dashboard |
| `GET /telemetry/requests` | Recent request metrics (JSON) |
| `GET /telemetry/summary` | Aggregate statistics (JSON) |
| `GET /telemetry/logs` | Diagnostic logs (JSON) |

Health response example:

```json
{
  "status": "healthy",
  "auth": { "loggedIn": true, "email": "you@example.com", "subscriptionType": "max" },
  "mode": "internal",
  "plugin": { "opencode": "configured" }
}
```

`plugin.opencode` is `"configured"` when `meridian setup` has been run, `"not-configured"` otherwise.

## CLI Commands

| Command | Description |
|---------|-------------|
| `meridian` | Start the proxy server |
| `meridian setup` | Configure the OpenCode plugin in `~/.config/opencode/opencode.json` |
| `meridian refresh-token` | Manually refresh the Claude OAuth token (exits 0/1) |

## Programmatic API

```typescript
import { startProxyServer } from "@rynfar/meridian"

const instance = await startProxyServer({
  port: 3456,
  host: "127.0.0.1",
  silent: true,
})

// instance.server — underlying http.Server
await instance.close()
```

## Docker

```bash
docker run -v ~/.claude:/home/claude/.claude -p 3456:3456 meridian
```

## Testing

```bash
npm test       # unit + integration tests
npm run build  # build with bun + tsc
```

| Tier | What | Speed |
|------|------|-------|
| Unit | Pure functions, no mocks | Fast |
| Integration | HTTP layer with mocked SDK | Fast |
| E2E | Real proxy + real Claude Max ([`E2E.md`](E2E.md)) | Manual |

## FAQ

**Is this allowed by Anthropic's terms?**
Meridian uses the official Claude Code SDK — the same SDK Anthropic publishes for programmatic access. It authenticates through your existing Claude Max session using OAuth.

**How is this different from using an API key?**
API keys are billed per token. Claude Max is a flat monthly fee. Meridian lets you use that subscription from any compatible tool.

**What happens if my OAuth token expires?**
Tokens expire roughly every 8 hours. Meridian detects the expiry, refreshes the token automatically, and retries the request — so requests continue transparently. If the refresh fails (e.g. the refresh token has expired after weeks of inactivity), Meridian returns a clear error telling you to run `claude login`.

**Can I trigger a token refresh manually?**

```bash
# CLI — works whether the proxy is running or not
meridian refresh-token

# HTTP — while the proxy is running
curl -X POST http://127.0.0.1:3456/auth/refresh
```

**I'm hitting rate limits on 1M context. What do I do?**
Set `MERIDIAN_SONNET_MODEL=sonnet` to use the 200k model for all requests. If you're using OpenCode with the Meridian plugin, subagents already use 200k automatically — only the primary agent uses 1M.

**Why does the health endpoint show `"plugin": "not-configured"`?**
You haven't run `meridian setup`. Without the plugin, OpenCode requests won't have session tracking or subagent model selection. Run `meridian setup` and restart OpenCode.

## Contributing

Issues and PRs welcome. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for module structure and dependency rules, [`CLAUDE.md`](CLAUDE.md) for coding guidelines, and [`E2E.md`](E2E.md) for end-to-end test procedures.

## License

MIT
