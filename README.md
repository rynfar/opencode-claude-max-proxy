# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

Use your **Claude Max subscription** with OpenCode.

## The Problem

Anthropic doesn't allow Claude Max subscribers to use their subscription with third-party tools like OpenCode. If you want to use Claude in OpenCode, you have to pay for API access separately - even though you're already paying for "unlimited" Claude.

Your options are:
1. Use Claude's official apps only (limited to their UI)
2. Pay again for API access on top of your Max subscription
3. **Use this proxy**

## The Solution

This proxy bridges the gap using Anthropic's own tools:

```
OpenCode → Proxy (localhost:3456) → Claude Agent SDK → Your Claude Max Subscription
```

The [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) is Anthropic's **official npm package** that lets developers build with Claude using their Max subscription. This proxy simply translates OpenCode's API requests into SDK calls.

**Your Max subscription. Anthropic's official SDK. Zero additional cost.**

## Is This Allowed?

**Yes.** Here's why:

| Concern | Reality |
|---------|---------|
| "Bypassing restrictions" | No. We use Anthropic's public SDK exactly as documented |
| "Violating TOS" | No. The SDK is designed for programmatic Claude access |
| "Unauthorized access" | No. You authenticate with `claude login` using your own account |
| "Reverse engineering" | No. We call `query()` from their npm package, that's it |

The Claude Agent SDK exists specifically to let Max subscribers use Claude programmatically. We're just translating the request format so OpenCode can use it.

**~200 lines of TypeScript. No hacks. No magic. Just format translation.**

## Features

| Feature | Description |
|---------|-------------|
| **Zero API costs** | Uses your Claude Max subscription, not per-token billing |
| **Full compatibility** | Works with any Anthropic model in OpenCode |
| **Streaming support** | Real-time SSE streaming just like the real API |
| **Auto-start** | Optional launchd service for macOS |
| **Simple setup** | Two commands to get running |

## Prerequisites

1. **Claude Max subscription** - [Subscribe here](https://claude.ai/settings/subscription)

2. **Claude CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```

3. **Bun** runtime:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

## Installation

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install
```

## Usage

### Start the Proxy

```bash
bun run proxy
```

### Run OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Select any `anthropic/claude-*` model (opus, sonnet, haiku).

### One-liner

```bash
bun run proxy & ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

## Auto-start on macOS

Set up the proxy to run automatically on login:

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
        <string>$(which bun)</string>
        <string>run</string>
        <string>proxy</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

Then add an alias to `~/.zshrc`:

```bash
echo "alias oc='ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode'" >> ~/.zshrc
source ~/.zshrc
```

Now just run `oc` to start OpenCode with Claude Max.

## Model Mapping

| OpenCode Model | Claude SDK |
|----------------|------------|
| `anthropic/claude-opus-*` | opus |
| `anthropic/claude-sonnet-*` | sonnet |
| `anthropic/claude-haiku-*` | haiku |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | 3456 | Proxy server port |
| `CLAUDE_PROXY_HOST` | 127.0.0.1 | Proxy server host |
| `CLAUDE_PROXY_WORKDIR` | (process cwd) | Base working directory used by MCP file/shell tools |

## How It Works

1. **OpenCode** sends a request to `http://127.0.0.1:3456/messages` (thinking it's the Anthropic API)
2. **Proxy** receives the request and extracts the messages
3. **Proxy** calls `query()` from the Claude Agent SDK with your prompt
4. **Claude Agent SDK** authenticates using your Claude CLI login (tied to your Max subscription)
5. **Claude** processes the request using your subscription
6. **Proxy** streams the response back in Anthropic SSE format
7. **OpenCode** receives the response as if it came from the real API

The proxy is ~200 lines of TypeScript. No magic, no hacks.

## FAQ

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set, but we never actually use it. The Claude Agent SDK handles authentication through your Claude CLI login. Any non-empty string works.

### Does this work with other tools besides OpenCode?

Yes! Any tool that uses the Anthropic API format can use this proxy. Just point `ANTHROPIC_BASE_URL` to `http://127.0.0.1:3456`.

### What about rate limits?

Your Claude Max subscription has its own usage limits. This proxy doesn't add any additional limits.

### Is my data sent anywhere else?

No. The proxy runs locally on your machine. Your requests go directly to Claude through the official SDK.

## Troubleshooting

### "Authentication failed"

Run `claude login` to authenticate with the Claude CLI.

### "Connection refused"

Make sure the proxy is running: `bun run proxy`

### Proxy keeps dying

Use the launchd service (see Auto-start section) which automatically restarts the proxy.

## License

MIT

## Credits

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.
