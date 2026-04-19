<p align="center">
  <img src="assets/banner.svg" alt="Meridian" width="800"/>
</p>

<p align="center">
  <a href="https://github.com/rynfar/meridian/releases"><img src="https://img.shields.io/github/v/release/rynfar/meridian?style=flat-square&color=6366f1&label=release" alt="Release"></a>
  <a href="https://www.npmjs.com/package/@rynfar/meridian"><img src="https://img.shields.io/npm/v/@rynfar/meridian?style=flat-square&color=8b5cf6&label=npm" alt="npm"></a>
  <a href="#"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-a78bfa?style=flat-square" alt="Platform"></a>
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-c4b5fd?style=flat-square" alt="License"></a>
  <a href="https://discord.gg/7vNVFYBz"><img src="https://img.shields.io/badge/discord-join-5865F2?style=flat-square&logo=discord&logoColor=white" alt="Discord"></a>
</p>

---

Meridian bridges the Claude Code SDK to the standard Anthropic API. No OAuth interception. No binary patches. No hacks. Just pure, documented SDK calls. Any tool that speaks the Anthropic or OpenAI protocol — OpenCode, ForgeCode, Crush, Cline, Aider, Pi, Droid, Open WebUI — connects to Meridian and gets Claude, with session management, streaming, and prompt caching handled natively by the SDK.

> [!NOTE]
> ### How Meridian works with Anthropic
>
> Meridian is built entirely on the [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk). Every request flows through `query()` — the same documented function Anthropic provides for programmatic access. No OAuth tokens are extracted, no binaries are patched, nothing is reverse-engineered.
>
> Because we use the SDK, Anthropic remains in full control of prompt caching, context window management, compaction, rate limiting, and authentication. Meridian doesn't bypass these mechanisms — it depends on them. Max subscription tokens flow through the correct channel, governed by the same guardrails Anthropic built into Claude Code.
>
> What Meridian adds is a **presentation and interoperability layer**. We translate Claude Code's output into the standard Anthropic API format so developers can connect the editors, terminals, and workflows they prefer. The SDK does the work; Meridian formats the result.
>
> **Our philosophy is simple: work within the SDK's constraints, not around them.** The generous limits on Claude Max exist because Anthropic can optimize and manage usage through Claude Code. Meridian respects that by building only on the tools Anthropic provides — no shortcuts, no workarounds that create friction. We believe this is how developers keep the freedom to choose their own frontends while keeping the platform sustainable for everyone.

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

The API key value is a placeholder — Meridian authenticates through the Claude Code SDK, not API keys. Most Anthropic-compatible tools require this field to be set, but any value works.

### NixOS / Nix Flake

Meridian provides a Nix flake for declarative installation.

**Add to your flake inputs:**

```nix
{
  inputs.meridian.url = "github:rynfar/meridian";
}
```

**Install the package** (via overlay or directly):

```nix
# Option A: overlay
nixpkgs.overlays = [ meridian.overlays.default ];
environment.systemPackages = [ pkgs.meridian ];

# Option B: direct reference
environment.systemPackages = [ meridian.packages.${system}.meridian ];
```

**OpenCode plugin** -- the plugin file is included at `${pkgs.meridian}/lib/meridian/plugin/meridian.ts`. Since this path lives in the Nix store, you need to make it available to OpenCode:

If you generate your OpenCode config from Nix (e.g. via Home Manager), interpolate the path directly:

```nix
# home-manager example
xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
  plugin = [ "${pkgs.meridian}/lib/meridian/plugin/meridian.ts" ];
};
```

If you don't manage your OpenCode config through Nix, symlink the plugin to a stable path and reference that instead:

```nix
# configuration.nix or home-manager
environment.etc."meridian/plugin/meridian.ts".source =
  "${pkgs.meridian}/lib/meridian/plugin/meridian.ts";
```

Then in `~/.config/opencode/opencode.json`:

```json
{ "plugin": ["/etc/meridian/plugin/meridian.ts"] }
```

> **Important:** Do not use `meridian setup` on NixOS. It writes an absolute Nix store path (e.g. `/nix/store/...-meridian-1.x.x/lib/...`) into your OpenCode config, which will break on the next `nixos-rebuild switch` or `home-manager switch` when the store path changes. Use one of the approaches above instead.

**Home Manager service** -- run Meridian as a user systemd service:

```nix
# flake.nix
{
  inputs.meridian.url = "github:rynfar/meridian";
}

# home-manager config
{
  imports = [ meridian.homeManagerModules.default ];

  services.meridian = {
    enable = true;
    settings = {
      port = 3456;
      host = "127.0.0.1";
      # passthrough = true;
      # defaultAgent = "opencode";
      # sonnetModel = "sonnet";
    };
    # Extra env vars not covered by settings
    # environment = {
    #   MERIDIAN_MAX_CONCURRENT = "20";
    # };
  };
}
```

The service starts automatically on login. Manage it with `systemctl --user {start,stop,restart,status} meridian`.

The plugin path is also available as `config.services.meridian.opencode.pluginPath` for use in your OpenCode config:

```nix
xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
  plugin = [ config.services.meridian.opencode.pluginPath ];
};
```

## Why Meridian?

The Claude Code SDK provides programmatic access to Claude. But your favorite coding tools expect an Anthropic API endpoint. Meridian bridges that gap — it runs locally, accepts standard API requests, and routes them through the SDK. Claude Code does the heavy lifting; Meridian translates the output.

<p align="center">
  <img src="assets/how-it-works.svg" alt="How Meridian works" width="920"/>
</p>

## Features

- **Standard Anthropic API** — drop-in compatible with any tool that supports a custom `base_url`
- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` for tools that only speak the OpenAI protocol (Open WebUI, Continue, etc.) — no LiteLLM needed, including `image_url` support for data URLs
- **Session management** — conversations persist across requests, survive compaction and undo, resume after proxy restarts
- **Streaming** — full SSE streaming with MCP tool filtering
- **Concurrent sessions** — run parent and subagent requests in parallel
- **Subagent model selection** — primary agents get 1M context; subagents get 200k, preserving rate-limit budget
- **Auto token refresh** — expired OAuth tokens are refreshed automatically; requests continue without interruption
- **Passthrough mode** — forward tool calls to the client instead of executing internally
- **Multimodal** — images, documents, file attachments, and multimodal tool results pass through to Claude
- **Multi-profile** — switch between Claude accounts instantly, no restart needed
- **Telemetry dashboard** — real-time performance metrics at `/telemetry`, including token usage and prompt cache efficiency ([`MONITORING.md`](MONITORING.md))
- **Telemetry persistence** — opt-in SQLite storage for telemetry data that survives proxy restarts, with configurable retention
- **Prometheus metrics** — `GET /metrics` endpoint for scraping request counters and duration histograms
- **SDK feature toggles** *(experimental)* — unlock Claude Code features (memory, dreaming, CLAUDE.md) for any connected agent

## SDK Feature Toggles (Experimental)

Meridian can expose Claude Code features to any connected agent. Capabilities like auto-memory, dreaming, and CLAUDE.md — normally exclusive to Claude Code — become available to OpenCode, Crush, Droid, and any other harness routed through Meridian. Each agent keeps its own toolchain while gaining access to these additional features.

Configure per-adapter at **`/settings`** in the Meridian web UI. Changes take effect on the next request — no restart needed. Config is persisted to `~/.config/meridian/sdk-features.json`.

### Available features

| Setting | Options | Description |
|---|---|---|
| **Claude Code Prompt** | on / off | Include the SDK's built-in system prompt (tool usage rules, safety guidelines, coding best practices) |
| **Client Prompt** | on / off | Include the system prompt sent by the connecting agent (e.g. OpenCode or Crush instructions) |
| **CLAUDE.md** | off / project / full | Load instruction files — `off`: none, `project`: `./CLAUDE.md` only, `full`: `~/.claude/CLAUDE.md` + `./CLAUDE.md` |
| **Memory** | on / off | Auto-memory: read and write memories across sessions |
| **Auto-Dream** | on / off | Background memory consolidation between sessions |
| **Thinking** | disabled / adaptive / enabled | Extended thinking mode for complex reasoning |
| **Thinking Passthrough** | on / off | Forward thinking blocks to the client for display |
| **Shared Memory** | on / off | Share memory directory with Claude Code (`~/.claude`) instead of isolated storage |

### System prompts

The system prompt controls are independent — any combination works:

- **Both enabled** (recommended): Claude Code instructions come first, followed by your agent's specific instructions. This gives Claude the full context it needs for features like memory and tool use to work correctly.
- **Claude Code only**: Just the base Claude Code prompt without agent-specific instructions.
- **Client only**: Just your agent's prompt, passed through as a raw string.
- **Neither**: No system prompt at all — Claude operates with just the user message.

> **Note:** For features like memory and dreaming to work well, the Claude Code system prompt should be enabled — it contains the instructions Claude needs to read and write memories correctly.

## Passthrough Mode and Tool Calling

The core question is **who executes the tools** — the SDK or the client?

- **Passthrough mode** (default for OpenCode) — Claude generates tool calls, but Meridian captures them and sends them back to the client for execution. The client runs the tool using its own implementation, with its own sandboxing, file tracking, and UI, then sends the result in the next request. This is how OpenCode, oh-my-opencagent (OMO), and most coding agents work — they have their own read/write/bash tools and need to stay in control of what runs on the user's machine.
- **Internal mode** — Claude Code handles everything. The SDK executes tools directly on the host, runs its full agent loop, and returns the final result. This is for clients that are purely chat interfaces (Open WebUI, simple API consumers) with no tool execution of their own.

Most users don't need to configure anything — the adapter sets the right mode automatically. To override:

```bash
MERIDIAN_PASSTHROUGH=1 meridian   # force passthrough
MERIDIAN_PASSTHROUGH=0 meridian   # force internal
```

### How tool calling works in passthrough

1. The client sends a request with tool definitions (read, write, edit, bash, glob, grep)
2. Meridian registers these as MCP tools so the SDK can generate proper `tool_use` blocks
3. The SDK produces a tool call → Meridian captures it and returns it to the client
4. The client executes the tool locally and sends the result back

For large tool sets (>15 tools), non-core tools are automatically deferred via the SDK's ToolSearch mechanism. Core tools (read, write, edit, bash, glob, grep) are always loaded eagerly. The deferral threshold is configurable with `MERIDIAN_DEFER_TOOL_THRESHOLD`.

### Known limitations

- **Single tool round-trip per request** — in passthrough mode, the SDK is configured with `maxTurns=2` (or 3 for deferred tools). Multi-step agentic loops where Claude needs several consecutive tool calls require the client to re-send after each round.
- **Blocked tools** — 13 built-in SDK tools (Read, Write, Bash, etc.) are blocked to prevent conflicts with the client's own tools. 15 additional Claude Code-only tools (CronCreate, EnterWorktree, Agent, etc.) are blocked because they require capabilities that external clients don't support.
- **Subagent extraction** — Meridian parses the client's Task tool description to extract subagent names and build SDK AgentDefinitions. If the client's agent framework uses a non-standard format, subagent routing may not work automatically.

## Multi-Profile Support

Meridian can route requests to different Claude accounts. Each **profile** is a named auth context — a separate Claude login with its own OAuth tokens. Switch between personal and work accounts, or share a single Meridian instance across teams.

### Adding profiles

```bash
# Add your personal account
meridian profile add personal
# → Opens browser for Claude login

# Add your work account (sign out of claude.ai first, then sign into the work account)
meridian profile add work
```

> **⚠ Important:** Claude's OAuth reuses your browser session. Before adding a second account, sign out of claude.ai and sign into the other account first.

### Switching profiles

```bash
# CLI (while proxy is running)
meridian profile switch work

# Per-request header (any agent)
curl -H "x-meridian-profile: work" ...
```

You can also switch profiles from the web UI at `http://127.0.0.1:3456/profiles` — a dropdown appears in the nav bar on all pages when profiles are configured.

### Profile commands

| Command | Description |
|---------|-------------|
| `meridian profile add <name>` | Add a profile and authenticate via browser |
| `meridian profile list` | List profiles and auth status |
| `meridian profile switch <name>` | Switch the active profile (requires running proxy) |
| `meridian profile login <name>` | Re-authenticate an expired profile |
| `meridian profile remove <name>` | Remove a profile and its credentials |

### How it works

Each profile stores its credentials in an isolated `CLAUDE_CONFIG_DIR` under `~/.config/meridian/profiles/<name>/`. When a request arrives, Meridian resolves the profile in priority order:

1. `x-meridian-profile` request header (per-request override)
2. Active profile (set via `meridian profile switch` or the web UI)
3. First configured profile

Session state is scoped per profile — switching accounts won't cross-contaminate conversation history.

### Environment variable configuration

For advanced setups (CI, Docker), profiles can also be provided via environment variable:

```bash
export MERIDIAN_PROFILES='[{"id":"personal","claudeConfigDir":"/path/to/config1"},{"id":"work","claudeConfigDir":"/path/to/config2"}]'
export MERIDIAN_DEFAULT_PROFILE=personal
meridian
```

When `MERIDIAN_PROFILES` is set, it takes precedence over disk-configured profiles. When unset, Meridian auto-discovers profiles from `~/.config/meridian/profiles.json` on each request.

## Agent Setup

### OpenCode

**Step 1: Run `meridian setup` (required, one time)**

```bash
meridian setup
```

This adds the Meridian plugin to your OpenCode global config (`~/.config/opencode/opencode.json`). The plugin enables:

- **Session tracking** — reliable conversation continuity across requests
- **Safe model defaults** — Opus uses 1M context (included with Max subscription); Sonnet uses 200k to avoid Extra Usage charges ([details](#configuration))
- **Subagent model selection** — subagents automatically use `sonnet`/`opus` (200k), preserving rate-limit budget

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

#### oh-my-opencagent (OMO)

[oh-my-opencagent](https://github.com/nicobailey/oh-my-opencagent) adds multi-agent orchestration on top of OpenCode. It works transparently through Meridian with no extra configuration — OMO uses the same OpenCode headers and tool format, so Meridian detects it automatically.

Meridian parses OMO's Task tool descriptions to extract subagent names (explore, code-review, etc.) and builds SDK AgentDefinitions so Claude can route to the correct agent. Internal orchestration markers (`<!-- OMO_INTERNAL_INITIATOR -->`, `[SYSTEM DIRECTIVE: OH-MY-OPENCODE ...]`) are stripped automatically to prevent context leakage.

OMO requires **passthrough mode** (the default for OpenCode) — subagent delegation flows through tool calls that must be forwarded back to the client.

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
  aider --model anthropic/claude-sonnet-4-6
```

> **Note:** `--no-stream` is incompatible due to a litellm parsing issue — use the default streaming mode.

### OpenAI-compatible tools (Open WebUI, Continue, etc.)

Meridian speaks the OpenAI protocol natively — no LiteLLM or translation proxy needed.

**`POST /v1/chat/completions`** — accepts OpenAI chat format, returns OpenAI completion format (streaming and non-streaming)

- `image_url` parts are supported when provided as **data URLs** (`data:image/...;base64,...`)
- multimodal tool flows where a tool returns `tool_result.content = [text, image]` are preserved through the structured multimodal path instead of being flattened to text

**`GET /v1/models`** — returns available Claude models in OpenAI format

Point any OpenAI-compatible tool at `http://127.0.0.1:3456` with any API key value:

```bash
# Open WebUI: set OpenAI API base to http://127.0.0.1:3456, API key to any value
# Continue: set apiBase to http://127.0.0.1:3456 with provider: openai
# Any OpenAI SDK: set base_url="http://127.0.0.1:3456", api_key="dummy"
```

> **Note:** Multi-turn conversations work by packing prior turns into the system prompt. Each request is a fresh SDK session — OpenAI clients replay full history themselves and don't use Meridian's session resumption.

### ForgeCode

Add a custom provider to `~/forge/.forge.toml`:

```toml
[[providers]]
id            = "meridian"
url           = "http://127.0.0.1:3456/v1/messages"
models        = "http://127.0.0.1:3456/v1/models"
api_key_vars  = "MERIDIAN_FORGE_KEY"
response_type = "Anthropic"
auth_methods  = ["api_key"]

[session]
provider_id = "meridian"
model_id    = "claude-opus-4-6"
```

Set the API key env var. Any value works unless you've enabled authentication with `MERIDIAN_API_KEY`, in which case use your auth key here:

```bash
export MERIDIAN_FORGE_KEY=x
```

Then log in and select the model:

```bash
forge provider login meridian    # enter any value when prompted
forge config set provider meridian --model claude-opus-4-6
```

Start Meridian with the ForgeCode adapter:

```bash
MERIDIAN_DEFAULT_AGENT=forgecode meridian
```

ForgeCode uses reqwest's default User-Agent, so automatic detection isn't possible. The `MERIDIAN_DEFAULT_AGENT` env var tells Meridian to use the ForgeCode adapter for all unrecognized requests. If you run other agents alongside ForgeCode, use the `x-meridian-agent: forgecode` header instead (add `[providers.headers]` to your `.forge.toml`).

### Pi

Pi uses the `@mariozechner/pi-ai` library which supports a configurable `baseUrl` on the model. Add a provider-level override in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "http://127.0.0.1:3456",
      "apiKey": "x",
      "headers": {
        "x-meridian-agent": "pi"
      }
    }
  }
}
```

Pi mimics Claude Code's User-Agent, so automatic detection isn't possible. The `x-meridian-agent: pi` header in the config above tells Meridian to use the Pi adapter. Alternatively, if Pi is your only agent, you can set `MERIDIAN_DEFAULT_AGENT=pi` as an env var instead.

### Any Anthropic-compatible tool

```bash
export ANTHROPIC_API_KEY=x
export ANTHROPIC_BASE_URL=http://127.0.0.1:3456
```

## Tested Agents

| Agent | Status | Notes |
|-------|--------|-------|
| [OpenCode](https://github.com/anomalyco/opencode) | ✅ Verified | Requires `meridian setup` — full tool support, session resume, streaming, subagents |
| [ForgeCode](https://forgecode.dev) | ✅ Verified | Provider config (see above) — passthrough tool execution, session resume, streaming |
| [Droid (Factory AI)](https://factory.ai/product/ide) | ✅ Verified | BYOK config (see above) — full tool support, session resume, streaming |
| [Crush](https://github.com/charmbracelet/crush) | ✅ Verified | Provider config (see above) — full tool support, session resume, headless `crush run` |
| [Cline](https://github.com/cline/cline) | ✅ Verified | Config (see above) — full tool support, file read/write/edit, bash, session resume |
| [Aider](https://github.com/paul-gauthier/aider) | ✅ Verified | Env vars — file editing, streaming; `--no-stream` broken (litellm bug) |
| [Open WebUI](https://github.com/open-webui/open-webui) | ✅ Verified | OpenAI-compatible endpoints — set base URL to `http://127.0.0.1:3456` |
| [Pi](https://github.com/mariozechner/pi-coding-agent) | ✅ Verified | models.json config (see above) — requires `MERIDIAN_DEFAULT_AGENT=pi` |
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
│   ├── forgecode.ts       ← ForgeCode adapter
│   ├── crush.ts           ← Crush adapter
│   ├── droid.ts           ← Droid adapter
│   ├── pi.ts              ← Pi adapter
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
├── profiles.ts            ← Multi-profile: resolve, list, switch auth contexts
├── profileCli.ts          ← CLI commands for profile management
├── sessionStore.ts        ← Cross-proxy file-based session persistence
└── passthroughTools.ts    ← Tool forwarding mode
telemetry/
├── ...
├── profileBar.ts          ← Shared profile switcher bar
└── profilePage.ts         ← Profile management page
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

| Signal | Adapter |
|---|---|
| `x-meridian-agent` header | Explicit override (any adapter) |
| `x-opencode-session` or `x-session-affinity` header | OpenCode |
| `opencode/` User-Agent | OpenCode |
| `factory-cli/` User-Agent | Droid |
| `Charm-Crush/` User-Agent | Crush |
| `litellm/` UA or `x-litellm-*` headers | LiteLLM passthrough |
| *(anything else)* | `MERIDIAN_DEFAULT_AGENT` env var, or OpenCode |

### Adding a New Agent

Implement the `AgentAdapter` interface in `src/proxy/adapters/`. See [`adapters/opencode.ts`](src/proxy/adapters/opencode.ts) for a reference.

## API Key Authentication

By default, Meridian binds to `127.0.0.1` and requires no authentication — anyone on localhost can use it. If you expose Meridian over a network (Tailscale, LAN, Docker with port mapping), you can enable API key authentication to prevent unauthorized access.

```bash
MERIDIAN_API_KEY=your-secret-key meridian
```

When set:
- All API routes (`/v1/messages`, `/v1/chat/completions`, etc.) and admin routes (`/telemetry`, `/metrics`, `/profiles`) require a matching key
- `/` and `/health` remain open (monitoring tools need unauthenticated health checks)
- Keys are accepted via `x-api-key` header or `Authorization: Bearer` header

Clients just set their `ANTHROPIC_API_KEY` to the shared secret — since most tools already send this header, no workflow changes are needed:

```bash
ANTHROPIC_API_KEY=your-secret-key ANTHROPIC_BASE_URL=http://meridian-host:3456 opencode
```

## Configuration

| Variable | Alias | Default | Description |
|----------|-------|---------|-------------|
| `MERIDIAN_API_KEY` | — | unset | Shared secret for API key authentication. When set, all API and admin routes require a matching `x-api-key` or `Authorization: Bearer` header. `/` and `/health` remain open. |
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
| `MERIDIAN_SONNET_MODEL` | `CLAUDE_PROXY_SONNET_MODEL` | `sonnet` | Sonnet context tier: `sonnet` (200k, default) or `sonnet[1m]` (1M, requires Extra Usage†) |
| `MERIDIAN_DEFAULT_AGENT` | — | `opencode` | Default adapter for unrecognized agents: `opencode`, `forgecode`, `pi`, `crush`, `droid`, `passthrough`. Requires restart. |
| `MERIDIAN_PROFILES` | — | unset | JSON array of profile configs (overrides disk discovery). See [Multi-Profile Support](#multi-profile-support). |
| `MERIDIAN_DEFER_TOOL_THRESHOLD` | — | `15` | Number of tools before non-core tools are deferred via ToolSearch. Set to `0` to disable. |
| `MERIDIAN_TELEMETRY_PERSIST` | — | unset | Enable SQLite telemetry persistence. Data survives proxy restarts. |
| `MERIDIAN_TELEMETRY_DB` | — | `~/.config/meridian/telemetry.db` | SQLite database path (when persistence is enabled) |
| `MERIDIAN_TELEMETRY_RETENTION_DAYS` | — | `7` | Days to retain telemetry data before cleanup |
| `MERIDIAN_DEFAULT_PROFILE` | — | *(first profile)* | Default profile ID when no header is sent |

†Sonnet 1M requires Extra Usage on all plans including Max ([docs](https://code.claude.com/docs/en/model-config#extended-context)). Opus 1M is included with Max/Team/Enterprise at no extra cost.

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
| `GET /metrics` | Prometheus exposition format metrics |
| `GET /profiles` | Profile management page |
| `GET /profiles/list` | List profiles with auth status (JSON) |
| `POST /profiles/active` | Switch the active profile |

Health response example:

```json
{
  "status": "healthy",
  "version": "1.34.1",
  "auth": { "loggedIn": true, "email": "you@example.com", "subscriptionType": "max" },
  "mode": "internal",
  "plugin": { "opencode": "configured" }
}
```

`plugin.opencode` is `"configured"` when `meridian setup` has been run, `"not-configured"` otherwise.

## Plugins

Extend Meridian's behavior with composable plugins — no core modifications needed.

**Quick start:** Drop a `.ts` or `.js` file in `~/.config/meridian/plugins/` and restart.

```ts
// ~/.config/meridian/plugins/my-plugin.ts
export default {
  name: "my-plugin",
  onRequest(ctx) {
    // modify request context
    return { ...ctx, systemContext: ctx.systemContext + "\nBe concise." }
  },
}
```

- **Manage plugins** at `http://localhost:3456/plugins`
- **Reload without restart:** `POST /plugins/reload`
- **Full guide:** See [PLUGINS.md](PLUGINS.md)

## CLI Commands

| Command | Description |
|---------|-------------|
| `meridian` | Start the proxy server |
| `meridian setup` | Configure the OpenCode plugin in `~/.config/opencode/opencode.json` |
| `meridian profile add <name>` | Add a profile and authenticate via browser |
| `meridian profile list` | List all profiles and their auth status |
| `meridian profile switch <name>` | Switch the active profile (requires running proxy) |
| `meridian profile login <name>` | Re-authenticate an expired profile |
| `meridian profile remove <name>` | Remove a profile and its credentials |
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

Claude Code authentication requires a browser, which isn't available inside containers. Authenticate on your local machine first, then mount the credentials into Docker.

### Single account

```bash
# 1. Authenticate locally (one time)
claude login

# 2. Run with mounted credentials
docker run -v ~/.claude:/home/claude/.claude -p 3456:3456 meridian
```

Meridian refreshes OAuth tokens automatically — once the credentials are mounted, no further browser access is needed.

### Multiple profiles in Docker

Authenticate each profile locally, then pass them to Docker via the `MERIDIAN_PROFILES` environment variable:

```bash
# 1. Authenticate each account locally
meridian profile add personal
meridian profile add work    # sign out of claude.ai first, sign into work account

# 2. Run Docker with profile configs pointing to mounted credential directories
docker run \
  -v ~/.config/meridian/profiles/personal:/profiles/personal \
  -v ~/.config/meridian/profiles/work:/profiles/work \
  -e 'MERIDIAN_PROFILES=[{"id":"personal","claudeConfigDir":"/profiles/personal"},{"id":"work","claudeConfigDir":"/profiles/work"}]' \
  -e MERIDIAN_DEFAULT_PROFILE=personal \
  -p 3456:3456 meridian
```

Switch profiles at runtime via the `x-meridian-profile` header or `meridian profile switch` (see [Multi-Profile Support](#multi-profile-support)).

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
Meridian uses the official Claude Code SDK — the same SDK Anthropic publishes and documents for programmatic access. It does not intercept credentials, modify binaries, or bypass any authentication. All requests flow through the SDK's own authentication and rate-limiting mechanisms.

**How is this different from using an API key?**
API keys provide direct API access billed per token. Claude Max includes programmatic access through the Claude Code SDK. Meridian translates SDK responses into the standard Anthropic API format, allowing compatible tools to connect through Claude Code.

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
Meridian defaults Sonnet to 200k context because Sonnet 1M is always billed as Extra Usage on Max plans — even when regular usage isn't exhausted. This is [Anthropic's intended billing model](https://code.claude.com/docs/en/model-config#extended-context), not a bug. Set `MERIDIAN_SONNET_MODEL=sonnet[1m]` to opt in if you have Extra Usage enabled and understand the billing implications. Opus defaults to 1M context, which is included with Max/Team/Enterprise subscriptions at no extra cost. Note: there is a [known upstream bug](https://github.com/anthropics/claude-code/issues/39841) where Claude Code incorrectly gates Opus 1M behind Extra Usage on Max — this is Anthropic's to fix.

**Why does the health endpoint show `"plugin": "not-configured"`?**
You haven't run `meridian setup`. Without the plugin, OpenCode requests won't have session tracking or subagent model selection. Run `meridian setup` and restart OpenCode.

## Contributing

Issues and PRs welcome. Join the [Discord](https://discord.gg/7vNVFYBz) to discuss ideas before opening issues. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for module structure and dependency rules, [`CLAUDE.md`](CLAUDE.md) for coding guidelines, [`E2E.md`](E2E.md) for end-to-end test procedures, and [`MONITORING.md`](MONITORING.md) for understanding token usage and prompt cache health.

## License

MIT
