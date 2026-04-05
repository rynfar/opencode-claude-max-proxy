# CLAUDE.md

Project guidelines for AI agents working in this codebase.

## What This Is

A proxy that bridges OpenCode (Anthropic API format) to Claude Max (Agent SDK). See `ARCHITECTURE.md` for the full module map and dependency rules.

## Commands

```bash
npm test          # Run all tests (bun test)
npm run build     # Build with tsup
npm start         # Start the proxy server
```

## Code Rules

### Module Boundaries

- **Do not add code to `server.ts` that belongs in a leaf module.** If it's pure logic (no HTTP, no Hono), extract it.
- **`session/lineage.ts` must stay pure.** No side effects, no I/O, no imports from cache or server.
- **Leaf modules (`errors.ts`, `models.ts`, `tools.ts`, `messages.ts`) must not import from `server.ts` or `session/`.** Dependencies flow downward only.
- **No circular dependencies.**

### Agent-Specific Logic

OpenCode-specific behavior is documented in `ARCHITECTURE.md` under "Agent-Specific Logic". When modifying these areas:

- Add a `NOTE:` comment marking the code as agent-specific
- Do not spread agent-specific logic into new modules
- Future work will use an adapter pattern — see `DEFERRED.md`

### Testing

- Every extracted module must have unit tests
- Pure functions get direct unit tests (no mocks)
- Integration tests go through the HTTP layer with mocked SDK
- **All tests must pass before any change is considered complete**
- New test files go in `src/__tests__/`
- **E2E tests** are documented in [`E2E.md`](./E2E.md) — run manually before releases or after major refactors (requires Claude Max subscription)

### Style

- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- No empty catch blocks
- Match existing patterns — check neighboring code before writing
- Keep `server.ts` as thin as possible — it should orchestrate, not compute

## Architecture Quick Reference

```
server.ts          → HTTP routes, SSE streaming, concurrency (orchestration only)
adapter.ts         → AgentAdapter interface (extensibility point)
adapters/
  opencode.ts      → OpenCode-specific: headers, CWD, tool config
query.ts           → buildQueryOptions (shared stream/non-stream SDK call builder)
errors.ts          → classifyError (pure)
models.ts          → mapModelToClaudeModel, resolveClaudeExecutableAsync
tools.ts           → BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME
messages.ts        → normalizeContent, getLastUserMessage (pure)
fileChanges.ts     → PostToolUse hook: file write/edit tracking + summary formatting (pure)
session/
  lineage.ts       → Hashing, lineage verification (PURE — no I/O)
  fingerprint.ts   → extractClientCwd, getConversationFingerprint
  cache.ts         → LRU caches, lookupSession, storeSession (stateful)
```

## Stable API Contract

External plugins depend on these interfaces. **Do not change without project owner approval.**

| Interface | Location | Used by |
|-----------|----------|---------|
| `startProxyServer(config)` → `ProxyInstance` | `server.ts` | Plugins that spawn proxy instances |
| `ProxyInstance.close()` | `types.ts` | Plugins for graceful shutdown |
| `ProxyConfig` type | `types.ts` | Plugin configuration |
| `x-opencode-session` header | `adapters/opencode.ts` | Session tracking from agent plugins |
| `x-meridian-profile` header | `server.ts`, `profiles.ts` | Per-request profile selection |
| `GET /health` response shape | `server.ts` | Plugin health checks |
| `POST /v1/messages` request/response format | `server.ts` | All agents (Anthropic API contract) |
| `GET /profiles/list` response shape | `server.ts` | Profile management UI and CLI |
| `POST /profiles/active` request/response | `server.ts` | Profile switching from CLI and UI |

If you need to modify any of these, open an issue first — breaking changes affect downstream plugin authors.

## Git

- Commit format: `type: brief description`
- Types: feat, fix, refactor, perf, test, docs, chore
- No AI attribution lines
