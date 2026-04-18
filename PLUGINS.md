# Meridian Plugin Authoring Guide

Plugins let you customize Meridian's request/response behavior without modifying core code. Drop a `.ts` or `.js` file in `~/.config/meridian/plugins/` and restart Meridian.

## Quick Start

1. Create the plugins directory:
   ```bash
   mkdir -p ~/.config/meridian/plugins
   ```

2. Create a plugin file (e.g., `~/.config/meridian/plugins/my-plugin.ts`):
   ```ts
   export default {
     name: "my-plugin",
     version: "1.0.0",
     description: "What this plugin does",

     onRequest(ctx) {
       // Modify the request context and return it
       return { ...ctx, model: "custom-model" }
     },
   }
   ```

3. Restart Meridian or call `POST /plugins/reload`

4. Check `http://localhost:3456/plugins` to verify your plugin loaded

## Transform Interface

Plugins export a `Transform` object with optional hooks:

```ts
interface Transform {
  name: string              // Required: unique plugin name
  description?: string      // Shown in /plugins UI
  version?: string          // Semver version string
  adapters?: string[]       // Restrict to specific adapters (omit = all)

  // v1 hooks
  onRequest?(ctx: RequestContext): RequestContext
  onResponse?(ctx: ResponseContext): ResponseContext
  onTelemetry?(ctx: TelemetryContext): void
}
```

### onRequest

Called before the request is sent to the Claude SDK. Receives the full request context and returns a modified copy.

**Key fields you can modify:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Claude model name |
| `messages` | `any[]` | Conversation messages |
| `systemContext` | `string?` | System prompt text |
| `tools` | `any[]?` | Client tool definitions |
| `stream` | `boolean` | Streaming preference |
| `blockedTools` | `string[]` | SDK tools to block |
| `passthrough` | `boolean?` | Enable passthrough mode |
| `supportsThinking` | `boolean` | Forward thinking blocks |
| `metadata` | `Record<string, unknown>` | Plugin-to-plugin state |

**Example — add a system prompt addendum:**
```ts
onRequest(ctx) {
  return {
    ...ctx,
    systemContext: (ctx.systemContext || "") + "\nAlways respond in Spanish.",
  }
}
```

### onResponse

Called after the SDK responds. Modify response content before it's sent to the client.

```ts
onResponse(ctx) {
  return {
    ...ctx,
    content: ctx.content.filter(block => block.type !== "thinking"),
  }
}
```

### onTelemetry

Observe-only hook for logging/metrics. Return value is ignored.

```ts
onTelemetry(ctx) {
  console.log(`Request ${ctx.requestId}: ${ctx.inputTokens}in/${ctx.outputTokens}out`)
}
```

## Adapter Scoping

Restrict a plugin to specific adapters:

```ts
export default {
  name: "opencode-only",
  adapters: ["opencode"],
  onRequest(ctx) { /* only runs for OpenCode requests */ },
}
```

Available adapters: `opencode`, `crush`, `droid`, `pi`, `forgecode`, `passthrough`

## Plugin Configuration

Control ordering and enable/disable via `~/.config/meridian/plugins.json`:

```json
{
  "plugins": [
    { "path": "system-prompt-redirect.ts", "enabled": true },
    { "path": "custom-logger.ts", "enabled": false }
  ]
}
```

- Array order = execution order in the pipeline
- `enabled: false` disables without deleting the file
- Plugins not in `plugins.json` are appended at the end, enabled by default

## The Metadata Bag

Pass state between hooks using the `metadata` field:

```ts
onRequest(ctx) {
  return { ...ctx, metadata: { ...ctx.metadata, startTime: Date.now() } }
},
onResponse(ctx) {
  const elapsed = Date.now() - (ctx.metadata.startTime as number)
  console.log(`Request took ${elapsed}ms`)
  return ctx
}
```

## Error Handling

If a plugin throws, it is skipped and the next plugin runs. The proxy never crashes due to a plugin error. Check the `/plugins` UI for error details.

## Testing Plugins

Test a transform in isolation:

```ts
import { createRequestContext, runTransformHook } from "@rynfar/meridian/transform"

const myPlugin = { name: "test", onRequest: (ctx) => ({ ...ctx, model: "custom" }) }

const ctx = createRequestContext({
  adapter: "opencode",
  body: {},
  headers: new Headers(),
  model: "sonnet",
  messages: [],
  stream: false,
  workingDirectory: "/tmp",
})

const result = runTransformHook([myPlugin], "onRequest", ctx, "opencode")
console.assert(result.model === "custom")
```

## Plugin Management UI

Visit `http://localhost:3456/plugins` to:
- See all discovered plugins and their status
- View which hooks each plugin registers
- View adapter scope
- Reload plugins without restarting

## Roadmap

**Planned hooks:**
- `onSession` — override session resume/undo/diverged decisions
- `onToolUse` — intercept, block, or modify tool calls before SDK execution
- `onToolResult` — observe or transform tool results after execution
- `onError` — custom error handling, logging, retry decisions

**Planned capabilities:**
- Plugin npm packages — install via `npm install meridian-plugin-*`
- Plugin templates — `meridian plugin init` scaffolding
- Hot reload — pick up changes without restart
- Plugin marketplace — community-curated directory
