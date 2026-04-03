# End-to-End Testing

Live tests against the real proxy + Claude Max SDK. These verify the full request cycle that unit tests (mocked SDK) cannot cover.

**Prerequisites:** Claude Max subscription, `claude auth status` shows `loggedIn: true`, `opencode` installed.

> **Droid tests (D1–D10)** additionally require `droid` installed (`droid --version` ≥ 0.89.0) and a Factory AI account for BYOK configuration.

## Quick Start

```bash
# 1. Build and start the proxy
npm run build
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts &

# 2. Wait for ready
curl -s http://127.0.0.1:3456/health | jq .status   # → "healthy"

# 3. Run tests (pick a section below)
# 4. Kill proxy when done
kill $(lsof -ti :3456)
```

## Test Index

| ID | Section | What It Proves | Verified |
|----|---------|----------------|----------|
| E1 | [Basic Request/Response](#e1-basic-requestresponse) | Proxy starts, routes to SDK, returns valid Anthropic response | 2026-03-24 |
| E2 | [Streaming SSE](#e2-streaming-sse) | SSE event format correct, events arrive in order | 2026-03-24 |
| E3 | [Tool Use Loop](#e3-tool-use-loop) | MCP tools (read/write/bash) execute through SDK | 2026-03-24 |
| E4 | [Session Continuation](#e4-session-continuation) | Same session header → `lineage=continuation`, SDK session reused | 2026-03-24 |
| E5 | [Undo with Rollback](#e5-undo-with-rollback) | Shorter/diverged suffix → `lineage=undo`, rollback UUID emitted | 2026-03-24 |
| E6 | [Compaction](#e6-compaction) | Summarized prefix + preserved suffix → `lineage=compaction` | 2026-03-24 |
| E7 | [Diverged Detection](#e7-diverged-detection) | Completely unrelated messages → `lineage=new`, fresh session | 2026-03-24 |
| E8 | [Cross-Proxy Resume](#e8-cross-proxy-resume) | Kill proxy → restart → session resumes from file store | 2026-03-24 |
| E9 | [Fingerprint Fallback](#e9-fingerprint-fallback) | No session header → fingerprint-based session lookup works | 2026-03-24 |
| E10 | [Coding Task (opencode)](#e10-coding-task-via-opencode) | Full round-trip: opencode → proxy → SDK → tool use → file modified | 2026-03-24 |
| E11 | [Telemetry](#e11-telemetry) | Dashboard HTML, `/requests`, `/summary`, `/logs` return data | 2026-03-24 |
| E12 | [Health Check](#e12-health-check) | `/health` returns auth status and mode | 2026-03-24 |
| E13 | [Concurrent Requests](#e13-concurrent-requests) | Parallel requests don't deadlock; active count increments | 2026-03-24 |
| E14 | [Model Routing](#e14-model-routing) | haiku/sonnet/opus model strings map correctly in proxy logs | 2026-03-24 |
| E15 | [Non-Streaming](#e15-non-streaming) | `stream:false` → JSON response with Content-Type, session header | 2026-03-24 |
| E16 | [Error Handling](#e16-error-handling) | Malformed JSON, missing fields, bad endpoints → structured errors | 2026-03-24 |
| E17 | [Passthrough Mode](#e17-passthrough-mode) | `CLAUDE_PROXY_PASSTHROUGH=1` → tool_use forwarded, not executed | 2026-03-24 |
| E18 | [Multimodal Content](#e18-multimodal-content) | Image blocks preserved, structured message path used | 2026-03-24 |
| E19 | [Subagent / Task Tool](#e19-subagent--task-tool) | Task tool agent definitions extracted, request processes correctly | 2026-03-24 |
| E20 | [Env Stripping](#e20-env-stripping) | ANTHROPIC_* vars don't leak to SDK subprocess | 2026-03-24 |
| E21 | [Session Store Pruning](#e21-session-store-pruning) | File store respects count cap, oldest entries evicted | 2026-03-24 |
| D1 | [Droid: Basic Response](#d1-droid-basic-response) | Proxy accepts Droid User-Agent, routes via droid adapter, returns valid response | 2026-03-29 |
| D2 | [Droid: MCP Server Name](#d2-droid-mcp-server-name) | Tools use `mcp__droid__` prefix, not `mcp__opencode__` | 2026-03-29 |
| D3 | [Droid: OpenCode Backward Compat](#d3-droid-opencode-backward-compat) | Requests without Droid UA still use opencode adapter | 2026-03-29 |
| D4 | [Droid: CWD from system-reminder](#d4-droid-cwd-from-system-reminder) | Working directory extracted from `<system-reminder>` block | 2026-03-29 |
| D5 | [Droid: Fingerprint Session Resume](#d5-droid-fingerprint-session-resume) | Session continues via fingerprint (no session header needed) | 2026-03-29 |
| D6 | [Droid: Real Binary Basic](#d6-droid-real-binary-basic) | Live `droid exec` → proxy → Claude Max returns correct response | 2026-03-29 |
| D7 | [Droid: Real Binary Tool Use](#d7-droid-real-binary-tool-use) | Live `droid exec` reads file via `mcp__droid__read` | 2026-03-29 |
| D8 | [Droid: exec Session Isolation](#d8-droid-exec-session-isolation) | Each `droid exec` call is a fresh session (expected — no history passed) | 2026-03-29 |
| D9 | [Droid: Streaming SSE](#d9-droid-streaming-sse) | SSE stream correct format with Droid User-Agent | 2026-03-29 |
| D10 | [Droid: OpenCode Session Unaffected](#d10-droid-opencode-session-unaffected) | OpenCode header-based session tracking still works alongside Droid | 2026-03-29 |
| C1 | [Crush: Basic Response](#c1-crush-basic-response) | Proxy accepts Charm-Crush/ User-Agent, routes via crush adapter, returns valid response | 2026-03-29 |
| C2 | [Crush: Session Continuation](#c2-crush-session-continuation) | `crush run --continue` resumes via fingerprint; `lineage=continuation` in proxy log | 2026-03-29 |
| C3 | [Crush: Tool Use (Read)](#c3-crush-tool-use-read) | `ls`/`view`/`grep` tool round-trip: Crush executes, sends tool_result, proxy resumes | 2026-03-29 |
| C4 | [Crush: Model Routing](#c4-crush-model-routing) | sonnet-4-6→sonnet[1m], opus-4-6→opus[1m], haiku→haiku for Max users | 2026-03-29 |
| C5 | [Crush: Backward Compat](#c5-crush-backward-compat) | OpenCode and Droid sessions unaffected when Crush requests coexist | 2026-03-29 |
| CL1 | [Cline: Basic Response](#cl1-cline-basic-response) | Proxy accepts Cline requests via anthropicBaseUrl, returns valid response | 2026-03-29 |
| CL2 | [Cline: File Read](#cl2-cline-file-read) | Cline reads a file via tool_use/tool_result passthrough loop | 2026-03-29 |
| CL3 | [Cline: File Write](#cl3-cline-file-write) | Cline writes a file to disk in --yolo mode | 2026-03-29 |
| CL4 | [Cline: Bash Execution](#cl4-cline-bash-execution) | Cline runs bash commands through passthrough | 2026-03-29 |
| CL5 | [Cline: File Edit](#cl5-cline-file-edit) | Cline edits an existing file (bug fix) | 2026-03-29 |
| CL6 | [Cline: Session Continuation](#cl6-cline-session-continuation) | `-T taskId` resumes session; `lineage=continuation` in proxy log | 2026-03-29 |
| CL7 | [Cline: Model Routing](#cl7-cline-model-routing) | sonnet-4-6→sonnet[1m], opus-4-6→opus[1m], haiku→haiku | 2026-03-29 |
| CL8 | [Cline: Multi-Agent Coexistence](#cl8-cline-multi-agent-coexistence) | Cline + Crush + OpenCode on same port simultaneously | 2026-03-29 |
| FC1 | [File Changes: Write (non-stream)](#fc1-file-changes-write-non-stream) | PostToolUse hook tracks write, appends "Files changed" to non-stream response | 2026-03-30 |
| FC2 | [File Changes: Write (stream)](#fc2-file-changes-write-stream) | PostToolUse hook tracks write, emits file change text block in SSE stream | 2026-03-30 |
| FC3 | [File Changes: Edit](#fc3-file-changes-edit) | Edit operations tracked as "edited" in summary | 2026-03-30 |
| FC4 | [File Changes: Read-only (no summary)](#fc4-file-changes-read-only-no-summary) | Read-only operations produce no "Files changed" section | 2026-03-30 |
| FC5 | [File Changes: Multiple ops](#fc5-file-changes-multiple-ops) | Multiple writes + edits listed in a single summary | 2026-03-30 |
| FC6 | [File Changes: Multiple ops (stream)](#fc6-file-changes-multiple-ops-stream) | Multiple file changes emitted as a text block in SSE stream | 2026-03-30 |
| E22 | [OAuth Token Refresh](#e22-oauth-token-refresh) | Expired access token auto-refreshed inline; request succeeds without manual `claude login` | 2026-04-02 |
| E23 | [Subagent Model Selection](#e23-subagent-model-selection) | `x-opencode-agent-mode: subagent` header selects base model; primary gets 1M; proxy log shows `agent=subagent` | 2026-04-02 |
| E24 | [Default Non-Streaming](#e24-default-non-streaming) | Omitting `stream` field returns JSON (not SSE), matching Anthropic API spec | - |
| E25 | [OpenAI Compat: Non-Streaming](#e25-openai-compat-non-streaming) | `/v1/chat/completions` returns valid OpenAI completion shape | - |
| E26 | [OpenAI Compat: Streaming](#e26-openai-compat-streaming) | `/v1/chat/completions` with `stream: true` returns OpenAI SSE chunks | - |
| E27 | [OpenAI Compat: Models](#e27-openai-compat-models) | `GET /v1/models` returns Claude model list in OpenAI format | - |
| E28 | [SDK Param Passthrough](#e28-sdk-param-passthrough) | Live proxy accepts effort/thinking/task_budget/beta fields without breaking responses | 2026-04-03 |
| E29 | [Context Usage Endpoint](#e29-context-usage-endpoint) | `/v1/sessions/:claudeSessionId/context-usage` returns live token usage for a completed request | 2026-04-03 |
| E30 | [Context Usage via Fingerprint + Restart](#e30-context-usage-via-fingerprint--restart) | Context usage lookup works for headerless sessions and survives proxy restart via shared store | 2026-04-03 |

---

## Conventions

**Model selection.** Tests use `claude-haiku-4-5-20251001` by default — it's the cheapest Claude Max tier and sufficient for verifying proxy behavior. Only use sonnet or opus when the test genuinely requires stronger reasoning (E3, E10: real coding tasks via opencode) or is explicitly testing model routing (E14, C4).

**Proxy log verification.** Most tests check proxy stderr for structured log lines:
```
[PROXY] <uuid> model=<m> stream=<bool> tools=<n> lineage=<type> session=<id|new> active=<n>/<max> msgCount=<n>
```

Extract these with:
```bash
cat /tmp/proxy-e2e.log | strings | grep "\[PROXY\]" | tail -5
```

**Session header.** All curl tests use `x-opencode-session` to control session identity. This is the header the OpenCode adapter reads.

**Cleanup.** Each test section is independent. Kill the proxy and clear the session store between sections if you need isolation:
```bash
kill $(lsof -ti :3456) 2>/dev/null
rm -f ~/.cache/meridian/sessions.json
```

---

## E1: Basic Request/Response

**Verifies:** Proxy accepts Anthropic API format, routes to SDK, returns valid JSON response.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-basic-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Respond with exactly: E2E_OK"}]
  }'
```

**Pass criteria:**
- Response has `"type": "message"`, `"role": "assistant"`
- Content includes a text block
- `stop_reason` is `"end_turn"`
- Proxy log shows `lineage=new session=new`

---

## E2: Streaming SSE

**Verifies:** SSE event stream has correct format, events arrive in proper order.

```bash
curl -sN http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-stream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role": "user", "content": "Say hello in one word"}]
  }' | head -30
```

**Pass criteria:**
- First event is `event: message_start` with a `message` object
- At least one `event: content_block_start` with `type: "text"`
- At least one `event: content_block_delta` with `type: "text_delta"`
- Final events include `event: message_stop`
- No `mcp__opencode__*` tool blocks leak through

---

## E3: Tool Use Loop

**Verifies:** SDK MCP tools execute and produce correct results.

```bash
# Setup
echo "CANARY_12345" > /tmp/e2e-canary.txt

# Test via opencode (tools are registered by opencode, not by curl)
cd /tmp && opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "What are the contents of /tmp/e2e-canary.txt?" 2>/dev/null

# Cleanup
rm /tmp/e2e-canary.txt
```

**Pass criteria:**
- Response text includes `CANARY_12345`
- Proxy log shows `tools=76` (or similar — opencode registers its full tool set)

### Variant: Write + Read

```bash
rm -f /tmp/e2e-write-test.txt
cd /tmp && opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "Write 'WRITE_OK' to /tmp/e2e-write-test.txt then read it back and confirm." 2>/dev/null

# Verify on disk
cat /tmp/e2e-write-test.txt   # → WRITE_OK
rm /tmp/e2e-write-test.txt
```

---

## E4: Session Continuation

**Verifies:** Appending messages with the same session header resumes the SDK session.

```bash
# Turn 1: Create session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: DELTA_99"}]
  }' > /dev/null

# Turn 2: Continue (prefix preserved, new message appended)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: DELTA_99"},
      {"role": "assistant", "content": [{"type":"text","text":"Noted: DELTA_99."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }'
```

**Pass criteria:**
- Turn 2 proxy log: `lineage=continuation session=<8-char-id>` (not `new`)
- Response mentions `DELTA_99`

---

## E5: Undo with Rollback

**Verifies:** When the message suffix changes (user edited/undid), proxy detects undo and emits rollback UUID.

**Prerequisite:** Run E4 first (builds a 3+ message session with `e2e-cont-001`).

```bash
# Send same prefix but DIFFERENT last message (undo turn 2, ask something else)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-cont-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: DELTA_99"},
      {"role": "assistant", "content": [{"type":"text","text":"Noted: DELTA_99."}]},
      {"role": "user", "content": "Actually, forget that. Tell me a joke."}
    ]
  }'
```

**Pass criteria:**
- Proxy log: `lineage=undo session=<same-id> rollback=<uuid>`
- `Undo detected` message in proxy stderr
- Response is valid (not an error)

---

## E6: Compaction

**Verifies:** When the agent summarizes early messages but preserves recent ones, proxy detects compaction and resumes.

```bash
# Step 1: Seed a 7-message conversation (≥6 required for compaction detection)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Message one"},
      {"role": "assistant", "content": "Reply one"},
      {"role": "user", "content": "Message two"},
      {"role": "assistant", "content": "Reply two"},
      {"role": "user", "content": "Message three"},
      {"role": "assistant", "content": "Reply three"},
      {"role": "user", "content": "Message four"}
    ]
  }' > /dev/null

# Step 2: Simulate compaction — early messages replaced, recent suffix preserved
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "[Summary of earlier conversation]"},
      {"role": "assistant", "content": "[Summary of replies]"},
      {"role": "user", "content": "Message three"},
      {"role": "assistant", "content": "Reply three"},
      {"role": "user", "content": "Message four"},
      {"role": "assistant", "content": "Reply four"},
      {"role": "user", "content": "Continuing after compaction"}
    ]
  }'
```

**Pass criteria:**
- Step 2 proxy log: `lineage=compaction session=<same-id>` (not `new`)
- `Compaction detected` message in proxy stderr
- Response is valid (session was resumed, not restarted)

**Key constants:** `MIN_SUFFIX_FOR_COMPACTION = 2`, `MIN_STORED_FOR_COMPACTION = 6` (in `session/lineage.ts`)

---

## E7: Diverged Detection

**Verifies:** Completely unrelated messages with the same session header start a fresh session.

**Prerequisite:** Run E6 first (session `e2e-compact-001` exists).

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-compact-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Completely unrelated topic about quantum physics"},
      {"role": "assistant", "content": "Quantum physics is fascinating"},
      {"role": "user", "content": "Tell me about entanglement"}
    ]
  }'
```

**Pass criteria:**
- Proxy log: `lineage=new session=new` (old session discarded)

---

## E8: Cross-Proxy Resume

**Verifies:** Sessions survive proxy restart via the shared file store (`~/.cache/meridian/sessions.json`).

```bash
# Step 1: Create a session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-persist-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: PHOENIX_42"}]
  }' > /dev/null

# Verify stored in file
cat ~/.cache/meridian/sessions.json | python3 -m json.tool | grep -A3 "e2e-persist"

# Step 2: Kill and restart proxy (in-memory caches wiped)
kill $(lsof -ti :3456); sleep 2
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
sleep 5  # Wait for startup

# Step 3: Resume the session
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-persist-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: PHOENIX_42"},
      {"role": "assistant", "content": [{"type":"text","text":"Got it — PHOENIX_42."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }'
```

**Pass criteria:**
- Step 3 proxy log: `lineage=continuation session=<same-8-char-id>` (not `new`)
- Response mentions `PHOENIX_42`
- SDK session was genuinely resumed (not a fresh start with flat text replay)

---

## E9: Fingerprint Fallback

**Verifies:** When no `x-opencode-session` header is sent, sessions are matched by fingerprint (hash of first user message + working directory).

```bash
# Turn 1: No session header
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Unique fingerprint test message 98765"}]
  }' > /dev/null

# Turn 2: Same first message, no header — should match by fingerprint
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Unique fingerprint test message 98765"},
      {"role": "assistant", "content": "Acknowledged."},
      {"role": "user", "content": "Continue the conversation"}
    ]
  }'
```

**Pass criteria:**
- Turn 1 proxy log: `lineage=new`
- Turn 2 proxy log: `lineage=continuation` (fingerprint matched, not `new`)

---

## E10: Coding Task via opencode

**Verifies:** Full opencode → proxy → SDK → tool execution → file modification loop.

```bash
# Setup
mkdir -p /tmp/e2e-coding-test
cat > /tmp/e2e-coding-test/buggy.js << 'EOF'
function add(a, b) {
  return a - b  // BUG: should be +
}
module.exports = { add }
EOF

# Run
cd /tmp/e2e-coding-test && opencode run --model anthropic/claude-sonnet-4-5 \
  "There's a bug in buggy.js. Find and fix it." 2>/dev/null

# Verify
cat /tmp/e2e-coding-test/buggy.js   # Should show "a + b"

# Cleanup
rm -rf /tmp/e2e-coding-test
```

**Pass criteria:**
- `buggy.js` now contains `a + b` (not `a - b`)
- Proxy log shows tool execution (multiple `[PROXY]` lines for the session)

### Variant: Multi-turn via opencode

```bash
SESSION_OUT=$(opencode run --model anthropic/claude-sonnet-4-5 --format json \
  "Remember the code ALPHA_42. Just confirm." 2>/dev/null)
SESSION_ID=$(echo "$SESSION_OUT" | grep -o '"sessionID":"[^"]*"' | head -1 | cut -d'"' -f4)

opencode run --model anthropic/claude-sonnet-4-5 --session "$SESSION_ID" --format json \
  "What was the code?" 2>/dev/null
```

**Pass criteria:**
- Second response includes `ALPHA_42`

---

## E11: Telemetry

**Verifies:** Telemetry dashboard and API endpoints return data after requests.

```bash
# Dashboard HTML
curl -s http://127.0.0.1:3456/telemetry | head -3
# → <!DOCTYPE html> ...

# Recent requests
curl -s http://127.0.0.1:3456/telemetry/requests?limit=5 | python3 -m json.tool | head -20

# Aggregate summary
curl -s http://127.0.0.1:3456/telemetry/summary | python3 -m json.tool

# Diagnostic logs
curl -s http://127.0.0.1:3456/telemetry/logs?limit=5 | python3 -m json.tool | head -20
```

**Pass criteria:**
- `/telemetry` returns HTML with `<title>Meridian`
- `/telemetry/requests` returns an array of request metrics with `requestId`, `model`, `lineageType`
- `/telemetry/summary` returns `totalRequests > 0`, `errorCount`, percentile latencies
- `/telemetry/logs` returns an array with `level`, `category`, `message` fields

---

## E12: Health Check

**Verifies:** `/health` endpoint returns auth and mode status.

```bash
curl -s http://127.0.0.1:3456/health | python3 -m json.tool
```

**Pass criteria:**
- `status: "healthy"`
- `auth.loggedIn: true`
- `auth.subscriptionType: "max"`
- `mode: "internal"` (or `"passthrough"` if `CLAUDE_PROXY_PASSTHROUGH` is set)

---

## E13: Concurrent Requests

**Verifies:** Multiple simultaneous requests are queued, not dropped or deadlocked.

```bash
# Fire 3 requests in parallel
for i in 1 2 3; do
  curl -s http://127.0.0.1:3456/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: dummy" \
    -H "x-opencode-session: e2e-concurrent-$i" \
    -d "{
      \"model\": \"claude-haiku-4-5-20251001\",
      \"max_tokens\": 30,
      \"stream\": false,
      \"messages\": [{\"role\": \"user\", \"content\": \"Say $i\"}]
    }" &
done
wait
```

**Pass criteria:**
- All 3 responses return valid JSON with `"type": "message"`
- Proxy log shows `active=` counts incrementing (e.g. `active=1/10`, `active=2/10`, `active=3/10`)
- No errors or deadlocks

---

## E14: Model Routing

**Verifies:** Different model strings map to the correct SDK model.

```bash
# Haiku
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20250929","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null

# Opus
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-opus-4-20250514","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null

# Sonnet (default)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{"model":"claude-sonnet-4-5-20250514","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"Hi"}]}' > /dev/null
```

**Pass criteria:**
- Proxy log shows `model=haiku` for the first request
- Proxy log shows `model=opus` (or `model=opus[1m]`) for the second
- Proxy log shows `model=sonnet[1m]` for the third

---

## E15: Non-Streaming

**Verifies:** `stream: false` returns a complete JSON response with correct headers.

```bash
curl -s -D /tmp/e2e-headers.txt http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-nonstream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Say exactly: NONSTREAM_OK"}]
  }'
cat /tmp/e2e-headers.txt
rm /tmp/e2e-headers.txt
```

**Pass criteria:**
- Response body: `"type": "message"`, `"stop_reason": "end_turn"`
- Response header: `Content-Type: application/json`
- Response header: `x-claude-session-id: <uuid>` present
- Content includes text block

---

## E16: Error Handling

**Verifies:** Invalid requests return structured error responses, not crashes.

```bash
# Malformed JSON
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d 'not json'

# Missing messages
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: dummy" \
  -d '{"model":"claude-haiku-4-5-20251001","stream":false}'

# Unknown endpoint
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/nonexistent

# Wrong HTTP method
curl -s -w "\n%{http_code}" http://127.0.0.1:3456/v1/messages
```

**Pass criteria:**
- Malformed JSON → HTTP 500, `{"type":"error","error":{"type":"api_error",...}}`
- Missing messages → HTTP 400, `{"type":"error","error":{"type":"invalid_request_error","message":"messages: Field required"}}`
- Unknown endpoint → HTTP 404, `{"error":{"type":"not_found",...}}`
- GET on POST endpoint → HTTP 404, `{"error":{"type":"not_found",...}}`
- Proxy does NOT crash on any of these

---

## E17: Passthrough Mode

**Verifies:** With `CLAUDE_PROXY_PASSTHROUGH=1`, the SDK returns tool_use blocks to the client instead of executing them internally.

**Requires proxy restart with env var:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3456 CLAUDE_PROXY_PASSTHROUGH=1 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
# Wait for ready...
```

### Non-streaming

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-passthrough-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "Read the file /tmp/test.txt"}],
    "tools": [
      {
        "name": "Read",
        "description": "Read a file from disk",
        "input_schema": {
          "type": "object",
          "properties": {"file_path": {"type": "string"}},
          "required": ["file_path"]
        }
      }
    ]
  }'
```

**Pass criteria:**
- `"stop_reason": "tool_use"` — SDK didn't execute the tool
- Content includes a `tool_use` block with `"name": "Read"` and correct `input`
- Tool name is clean (no `mcp__passthrough__` prefix)
- `/health` shows `"mode": "passthrough"`

### Streaming

```bash
curl -sN http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-passthrough-stream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": true,
    "messages": [{"role": "user", "content": "Read the file /tmp/test.txt"}],
    "tools": [{"name":"Read","description":"Read a file","input_schema":{"type":"object","properties":{"file_path":{"type":"string"}},"required":["file_path"]}}]
  }' | grep -E "tool_use|stop_reason"
```

**Pass criteria:**
- Stream contains `content_block_start` with `type: "tool_use"`, `name: "Read"`
- `message_delta` has `stop_reason: "tool_use"`

**After testing, restart proxy in normal mode:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
```

---

## E18: Multimodal Content

**Verifies:** Image content blocks are preserved and passed through the structured message path.

```bash
# 1x1 red PNG pixel
IMG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-multimodal-001" \
  -d "{
    \"model\": \"claude-haiku-4-5-20251001\",
    \"max_tokens\": 100,
    \"stream\": false,
    \"messages\": [{
      \"role\": \"user\",
      \"content\": [
        {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$IMG_B64\"}},
        {\"type\": \"text\", \"text\": \"What color is this image? Reply with just the color name.\"}
      ]
    }]
  }"
```

**Pass criteria:**
- Response contains a text block with a color name
- Proxy log shows `msgs=user[image,text]` — image content type was detected
- No errors about unsupported content types

---

## E19: Subagent / Task Tool

**Verifies:** When the request includes a Task tool with agent descriptions, the proxy extracts agent definitions and processes the request through the agent routing path.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-task-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 100,
    "stream": false,
    "messages": [{"role": "user", "content": "Just say hello"}],
    "tools": [
      {
        "name": "Task",
        "description": "Launch a sub-agent. Available agents:\n- coder: Writes code\n- reviewer: Reviews code\n- explorer: Explores codebase",
        "input_schema": {
          "type": "object",
          "properties": {
            "description": {"type": "string"},
            "subagent_type": {"type": "string"}
          },
          "required": ["description"]
        }
      },
      {
        "name": "Read",
        "description": "Read a file",
        "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}}
      }
    ]
  }'
```

**Pass criteria:**
- Response is `"type": "message"` (no error)
- Proxy log shows `tools=2` — both tools were seen
- No crash from agent definition parsing

---

## E20: Env Stripping

**Verifies:** The proxy strips `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` from the environment before spawning SDK subprocesses, preventing the SDK from looping back through the proxy.

```bash
ANTHROPIC_API_KEY=should-be-stripped ANTHROPIC_BASE_URL=http://should-be-stripped:9999 \
  curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-envstrip-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say OK"}]
  }'
```

**Pass criteria:**
- Response is a valid message with text content (request succeeded)
- If env vars leaked, the SDK would try to call `http://should-be-stripped:9999` and fail

**Note:** This test verifies the client-side env doesn't matter (the proxy runs in its own process). The actual env stripping happens inside `server.ts` before spawning the SDK. All prior tests implicitly prove this works (they'd fail if the SDK looped back), but this makes the verification explicit.

---

## E21: Session Store Pruning

**Verifies:** The file-based session store (`~/.cache/meridian/sessions.json`) evicts the oldest entries when the count exceeds `CLAUDE_PROXY_MAX_STORED_SESSIONS`.

**Requires proxy restart with env var:**
```bash
kill $(lsof -ti :3456) 2>/dev/null; sleep 1
rm -f ~/.cache/meridian/sessions.json
CLAUDE_PROXY_PORT=3456 CLAUDE_PROXY_MAX_STORED_SESSIONS=3 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
# Wait for ready...
```

```bash
# Create 5 sessions
for i in 1 2 3 4 5; do
  curl -s http://127.0.0.1:3456/v1/messages \
    -H "Content-Type: application/json" \
    -H "x-api-key: dummy" \
    -H "x-opencode-session: e2e-prune-$i" \
    -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":10,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Session $i\"}]}" > /dev/null
  sleep 1  # ensure distinct timestamps for deterministic eviction
done

# Verify the store is bounded
cat ~/.cache/meridian/sessions.json | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(f'Entries: {len(d)} (should be <= 3)')
"
```

**Pass criteria:**
- File store contains at most 3 entries
- Oldest sessions (lowest `lastUsedAt`) were evicted

**After testing, restart proxy in normal mode (no cap).**

---

## E22: OAuth Token Refresh

**Verifies:** When the Claude Code OAuth access token has expired, the proxy detects the 401, refreshes the token automatically, and retries the request — the caller sees a normal successful response.

**Platform note:** The credential store is platform-specific. Run on the platform you want to verify:
- **macOS** — credentials in Keychain (`/usr/bin/security`)
- **Linux** — credentials in `~/.claude/.credentials.json`

### macOS

```bash
# 1. Snapshot current expiry
python3 -c "
import subprocess, json
creds = json.loads(subprocess.check_output(
    ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials',
     '-a', __import__('os').getlogin(), '-w']).decode())
print('Current expiresAt:', creds['claudeAiOauth']['expiresAt'])
"

# 2. Artificially expire the token
CREDS=$(security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w)
EXPIRED=$(echo "$CREDS" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
d['claudeAiOauth']['expiresAt'] = 0   # epoch — definitely expired
print(json.dumps(d, indent=2))
")
security add-generic-password -U -s "Claude Code-credentials" -a "$(whoami)" -w "$EXPIRED"
echo "Token expired (expiresAt set to 0)"

# 3. Make a request — proxy should refresh inline and succeed
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-token-refresh-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: REFRESH_OK"}]
  }'

# 4. Verify token was refreshed
python3 -c "
import subprocess, json
creds = json.loads(subprocess.check_output(
    ['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials',
     '-a', __import__('os').getlogin(), '-w']).decode())
exp = creds['claudeAiOauth']['expiresAt']
import time
print(f'New expiresAt: {exp} ({"VALID" if exp > time.time()*1000 else "STILL EXPIRED"})')
"
```

### Linux

```bash
# 1. Snapshot current expiry
python3 -c "
import json, os
creds = json.loads(open(os.path.expanduser('~/.claude/.credentials.json')).read())
print('Current expiresAt:', creds['claudeAiOauth']['expiresAt'])
"

# 2. Artificially expire the token
python3 -c "
import json, os
path = os.path.expanduser('~/.claude/.credentials.json')
d = json.loads(open(path).read())
d['claudeAiOauth']['expiresAt'] = 0
open(path, 'w').write(json.dumps(d, indent=2))
print('Token expired')
"

# 3. Make a request
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-token-refresh-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: REFRESH_OK"}]
  }'

# 4. Verify token was refreshed
python3 -c "
import json, os, time
path = os.path.expanduser('~/.claude/.credentials.json')
d = json.loads(open(path).read())
exp = d['claudeAiOauth']['expiresAt']
print(f'New expiresAt: {exp} ({\"VALID\" if exp > time.time()*1000 else \"STILL EXPIRED\"})')
"
```

**Pass criteria:**
- Response: `"type": "message"` with text containing `REFRESH_OK` — request succeeded despite starting with an expired token
- Proxy log: `[PROXY] <id> OAuth token expired — refreshed, retrying` appears before the successful response log line
- Step 4 expiresAt: `VALID` (in the future — token was refreshed and written back)
- No `authentication_error` in the response

**What's being tested:** The `isExpiredTokenError()` detection in `errors.ts`, the `refreshOAuthToken()` cross-platform credential read/write in `tokenRefresh.ts`, and the inline retry loop in `server.ts`.

### Bonus: manual refresh endpoint

While the proxy is running with a valid token, you can also verify the `/auth/refresh` endpoint directly:

```bash
curl -s -X POST http://127.0.0.1:3456/auth/refresh
# → {"success":true,"message":"OAuth token refreshed successfully"}
```

**Pass criteria:** `success: true` and the `expiresAt` in the credential store is updated to a new future timestamp.

---

## E23: Subagent Model Selection

**Verifies:** When the `x-opencode-agent-mode: subagent` header is present, the proxy selects the base model (200k) instead of the 1M variant, conserving rate limit budget for the primary agent. The `meridian-agent-mode.ts` plugin sets this header automatically based on the agent's runtime `mode` field.

### Part A — header routing (curl, no plugin needed)

```bash
# Primary agent → sonnet[1m]
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-agent-mode: primary" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"hi"}]}' > /dev/null
# Proxy log: model=sonnet[1m] ... agent=primary

# Subagent → sonnet (base)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-agent-mode: subagent" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":10,"stream":false,"messages":[{"role":"user","content":"hi"}]}' > /dev/null
# Proxy log: model=sonnet ... agent=subagent
```

**Pass criteria (Part A):**
- Primary request proxy log: `model=sonnet[1m] ... agent=primary`
- Subagent request proxy log: `model=sonnet ... agent=subagent` — base model, no `[1m]`
- No header → `model=sonnet[1m]` (default primary behaviour)

### Part B — plugin integration (requires OpenCode)

**Setup:**
```bash
# 1. Copy the plugin into your project
cp /path/to/meridian/examples/opencode-plugin/meridian-agent-mode.ts ./meridian-agent-mode.ts

# 2. Add to opencode.json
# { "plugin": ["./claude-max-headers.ts", "./meridian-agent-mode.ts"] }

# 3. Create a named agent (e.g. ~/.config/opencode/agents/researcher.md)
# The agent's frontmatter mode determines primary vs subagent
```

**Test:**
```bash
# Run a task that uses the Task tool to spawn the researcher agent
opencode run --model anthropic/claude-sonnet-4-6 \
  "Use the researcher agent to find out what day it is, then summarise."
```

**Pass criteria (Part B):**
- Primary session log line: `model=sonnet[1m] agent=primary`
- Subagent session log line: `model=sonnet agent=subagent`
- Both requests succeed — no errors
- Two distinct proxy log entries visible (parent + subagent turn)

**What's being tested:** `mapModelToClaudeModel()` `agentMode` parameter in `models.ts`, `x-opencode-agent-mode` header reading in `server.ts`, and the `meridian-agent-mode.ts` plugin's use of `(incoming.agent as any).mode` to detect subagents without any API calls.

---

## E24: Default Non-Streaming

**Verifies:** When the `stream` field is omitted from the request body, the proxy returns a single JSON response (`application/json`), not an SSE stream — matching the Anthropic API spec default.

```bash
curl -s -D /tmp/e2e-headers.txt http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 10,
    "messages": [{"role": "user", "content": "Say OK"}]
  }'
grep -i content-type /tmp/e2e-headers.txt
rm /tmp/e2e-headers.txt
```

**Pass criteria:**
- Response header: `Content-Type: application/json` (not `text/event-stream`)
- Response body: `"type": "message"`, `"role": "assistant"`, valid `content` array
- Response is a single JSON object, not SSE events
- Proxy log: `stream=false`

**What's being tested:** The `body.stream ?? false` default in `server.ts`. Prior to this fix, omitting `stream` defaulted to `true` (SSE), which broke SDK clients calling `messages.create()` without an explicit `stream` parameter.

---

## E25: OpenAI Compat: Non-Streaming

**Verifies:** `POST /v1/chat/completions` accepts an OpenAI-format request and returns a valid OpenAI completion JSON object.

```bash
curl -s http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- `"object": "chat.completion"`
- `id` starts with `chatcmpl-`
- `choices[0].message.role` is `"assistant"`
- `choices[0].message.content` contains a response
- `choices[0].finish_reason` is `"stop"`
- `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens` are numbers
- Proxy log: `stream=false` (non-streaming path used internally)

**What's being tested:** `translateOpenAiToAnthropic()` and `translateAnthropicToOpenAi()` in `openai.ts`, internal routing via `app.fetch()` to `/v1/messages`.

---

## E26: OpenAI Compat: Streaming

**Verifies:** `POST /v1/chat/completions` with `stream: true` returns OpenAI SSE chunks in the correct format.

```bash
curl -sN http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 20,
    "stream": true,
    "messages": [{"role": "user", "content": "Say: hello"}]
  }'
```

**Pass criteria:**
- Response `Content-Type: text/event-stream`
- First data chunk has `"object": "chat.completion.chunk"` and `choices[0].delta.role == "assistant"`
- At least one chunk has non-empty `choices[0].delta.content`
- A chunk has `choices[0].finish_reason == "stop"`
- Stream ends with `data: [DONE]`
- All chunks share the same `id` starting with `chatcmpl-`
- Proxy log: `stream=true`

**What's being tested:** `translateAnthropicSseEvent()` in `openai.ts`, SSE stream translation in `server.ts`.

---

## E27: OpenAI Compat: Models

**Verifies:** `GET /v1/models` returns available Claude models in OpenAI format with correct context windows for the subscription tier.

```bash
curl -s http://127.0.0.1:3456/v1/models | python3 -m json.tool
```

**Pass criteria:**
- `"object": "list"`
- `data` array contains `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-haiku-4-5-20251001`
- Each model has `object: "model"`, `owned_by: "anthropic"`, `context_window > 0`
- For Max subscription: sonnet and opus have `context_window: 1000000`
- Haiku always has `context_window: 200000`

**What's being tested:** `buildModelList()` in `openai.ts`, `GET /v1/models` route in `server.ts`.

---

## E28: SDK Param Passthrough

**Verifies:** The live proxy accepts the new SDK passthrough fields (`effort`, `thinking`, `task_budget`, `anthropic-beta`) and still completes a normal Claude request. Exact option mapping is asserted by the integration tests in `src/__tests__/proxy-sdk-params.test.ts` and `src/__tests__/query-passthrough.test.ts`; this live test proves the real HTTP → proxy → SDK path does not reject or break on these fields.

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-sdk-params-001" \
  -H "x-opencode-effort: high" \
  -H "x-opencode-task-budget: 2000" \
  -H "anthropic-beta: interleaved-thinking-2025-05-14" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 120,
    "stream": false,
    "thinking": {"type": "enabled", "budgetTokens": 1024},
    "task_budget": {"total": 1000},
    "messages": [{"role": "user", "content": "Reply with exactly: SDK_PARAMS_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- Response is a valid Anthropic-format assistant message
- Response is **not** a structured error
- Proxy stderr shows a normal request log line (`model=... stream=false ...`)
- Proxy stderr shows a `usage:` line after the request

### Variant: malformed thinking override falls back cleanly

```bash
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-sdk-params-002" \
  -H "x-opencode-thinking: not-valid-json{{{" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 120,
    "stream": false,
    "thinking": {"type": "enabled", "budgetTokens": 1024},
    "messages": [{"role": "user", "content": "Reply with exactly: THINKING_FALLBACK_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- Response succeeds with a normal assistant message (HTTP 200)
- Proxy stderr contains `ignoring malformed x-opencode-thinking header`
- Request still completes normally instead of failing with a 4xx/5xx

---

## E29: Context Usage Endpoint

**Verifies:** A completed request stores token usage under the Claude SDK session ID returned by the proxy, and `/v1/sessions/:claudeSessionId/context-usage` returns it.

```bash
# 1. Make a request and capture response headers + body
curl -sD /tmp/e2e-context-usage.headers \
  -o /tmp/e2e-context-usage.body \
  http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-context-usage-001" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 80,
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with exactly: CONTEXT_USAGE_OK"}]
  }'

# 2. Extract the Claude session ID the proxy returned
CLAUDE_SESSION_ID=$(awk 'BEGIN{IGNORECASE=1} /^X-Claude-Session-ID:/ {print $2}' /tmp/e2e-context-usage.headers | tr -d '\r')
echo "$CLAUDE_SESSION_ID"

# 3. Query the usage endpoint
curl -s http://127.0.0.1:3456/v1/sessions/$CLAUDE_SESSION_ID/context-usage | python3 -m json.tool
```

**Pass criteria:**
- `CLAUDE_SESSION_ID` is non-empty
- Endpoint returns HTTP 200
- JSON contains `session_id` equal to the extracted Claude session ID
- JSON contains `context_usage.input_tokens` and `context_usage.output_tokens`
- Proxy stderr for the original request contains a `usage:` line

---

## E30: Context Usage via Fingerprint + Restart

**Verifies:** The context-usage endpoint also works for sessions created **without** `x-opencode-session` (fingerprint fallback) and still works after restarting the proxy (shared session store persistence).

```bash
# 1. Make a headerless request and capture the returned Claude session ID
curl -sD /tmp/e2e-context-fp.headers \
  -o /tmp/e2e-context-fp.body \
  http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -d '{
    "model": "claude-sonnet-4-5-20250514",
    "max_tokens": 80,
    "stream": false,
    "messages": [{"role": "user", "content": "Reply with exactly: FP_CONTEXT_USAGE_OK"}]
  }'

CLAUDE_SESSION_ID=$(awk 'BEGIN{IGNORECASE=1} /^X-Claude-Session-ID:/ {print $2}' /tmp/e2e-context-fp.headers | tr -d '\r')
echo "$CLAUDE_SESSION_ID"

# 2. Query usage immediately (proves fingerprint-backed sessions are discoverable)
curl -s http://127.0.0.1:3456/v1/sessions/$CLAUDE_SESSION_ID/context-usage | python3 -m json.tool

# 3. Restart the proxy WITHOUT deleting ~/.cache/meridian/sessions.json
kill $(lsof -ti :3456) 2>/dev/null
sleep 2
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &
sleep 5

# 4. Query usage again after restart (proves shared-store persistence)
curl -s http://127.0.0.1:3456/v1/sessions/$CLAUDE_SESSION_ID/context-usage | python3 -m json.tool
```

**Pass criteria:**
- Step 2 returns HTTP 200 for a request that had **no** `x-opencode-session` header
- Step 4 also returns HTTP 200 after restart
- Both responses contain `session_id` equal to the extracted Claude session ID
- Both responses contain `context_usage.input_tokens` and `context_usage.output_tokens`
- No need to replay the original request after restart — the lookup should work from persisted session data alone

---

## Adding New E2E Tests

When extending this document:

1. **Assign an ID** — use the next sequential `E##` number in the index.
2. **Add to the index table** at the top with the date verified.
3. **Include the exact curl/opencode command** — tests must be copy-pasteable.
4. **Define pass criteria** — what to check in the response AND in the proxy log.
5. **Note prerequisites** — if the test depends on a prior test's session state, say so.
6. **Note env vars** — if the test requires a proxy restart with special env vars (E17, E21), say so explicitly.
7. **Keep tests independent where possible** — use unique session IDs (`e2e-<test>-<nnn>`).

### Session ID Convention

Use `e2e-<feature>-<nnn>` format: `e2e-cont-001`, `e2e-compact-001`, `e2e-persist-001`.

### Checking Proxy Logs

The proxy writes structured log lines to stderr. When running as a background process:
```bash
CLAUDE_PROXY_PORT=3456 bun run ./bin/cli.ts > /tmp/proxy-e2e.log 2>&1 &

# Read logs (binary-safe — the log may contain emoji)
cat /tmp/proxy-e2e.log | strings | grep "\[PROXY\]"
cat /tmp/proxy-e2e.log | strings | grep -E "Compaction|Undo|diverged"
```

### Tests That Require Proxy Restart

Some tests need specific env vars. Group these at the end of a run to minimize restarts:

| Test | Env Var | Value |
|------|---------|-------|
| E17 | `CLAUDE_PROXY_PASSTHROUGH` | `1` |
| E21 | `CLAUDE_PROXY_MAX_STORED_SESSIONS` | `3` |

### Relationship to Unit/Integration Tests

```
Unit tests (bun test)          → Pure functions, no SDK, no network
Integration tests (bun test)   → HTTP layer with mocked SDK (fast, deterministic)
E2E tests (this document)      → Real proxy + real SDK + real Claude Max (slow, non-deterministic)
```

Unit and integration tests run in CI. E2E tests run manually before releases or after major refactors. They require an active Claude Max subscription.

### Coverage Map

Which proxy modules each E2E test exercises:

| Module | Tests |
|--------|-------|
| `server.ts` (orchestration) | All |
| `session/lineage.ts` | E4, E5, E6, E7, E8, E9 |
| `session/cache.ts` | E4, E5, E6, E7, E8, E9, E29, E30 |
| `session/fingerprint.ts` | E9, E30 |
| `sessionStore.ts` | E8, E21, E30 |
| `query.ts` | All (builds SDK options), especially E28 |
| `adapter.ts` + `adapters/opencode.ts` | All E-tests, D3, D10 |
| `adapters/droid.ts` | D1, D2, D4, D5, D6, D7, D8, D9 |
| `adapters/crush.ts` | C1, C2, C3, C4, C5 |
| `adapters/detect.ts` | D1, D2, D3, D6, D7, D9, D10, C1, C5 |
| *(default adapter — no Cline adapter needed)* | CL1–CL8 |
| `errors.ts` | E16, E22 |
| `tokenRefresh.ts` | E22 |
| `models.ts` | E14, E23 |
| `messages.ts` | E4, E5, E6 (content normalization for hashing) |
| `tools.ts` | E3, E17, E19 |
| `agentDefs.ts` | E19 |
| `agentMatch.ts` | E19 (fuzzy matching in PreToolUse hook) |
| `passthroughTools.ts` | E17 |
| `mcpTools.ts` | E3, E10 |
| `fileChanges.ts` | FC1, FC2, FC3, FC4, FC5, FC6 |
| `telemetry/` | E11 |

---

## Droid (Factory AI) Tests

These tests verify the Droid adapter added in the Droid support release. They require `droid` CLI installed and a Factory AI account.

### Droid BYOK Setup

Droid connects to the proxy via its BYOK (Bring Your Own Key) feature. Configure once before running D6–D8:

```bash
# 1. Back up Droid settings
cp ~/.factory/settings.json ~/.factory/settings.json.backup

# 2. Register all model tiers pointing at the proxy
# Model names drive mapModelToClaudeModel():
#   "4-6" in name → 1M context for Max users
#   "haiku" in name → haiku tier (no 1M)
#   "4-5" in name → base tier (no 1M)
python3 -c "
import json
with open('$HOME/.factory/settings.json') as f:
    s = json.load(f)
s['customModels'] = [
    {'model':'claude-sonnet-4-6',          'name':'Sonnet 4.6 (1M — Meridian)', 'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-opus-4-6',            'name':'Opus 4.6 (1M — Meridian)',   'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-haiku-4-5-20251001',  'name':'Haiku 4.5 (Meridian)',       'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
    {'model':'claude-sonnet-4-5-20250929', 'name':'Sonnet 4.5 (Meridian)',      'provider':'anthropic','baseUrl':'http://127.0.0.1:3457','apiKey':'sk-proxy'},
]
with open('$HOME/.factory/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
"

# 3. Verify Droid sees the model
droid exec --model "custom:claude-haiku-4-5-20251001" --list-tools 2>&1 | head -3
# → Available tools for claude-sonnet-4-5-20250514

# After all Droid tests, restore:
# cp ~/.factory/settings.json.backup ~/.factory/settings.json
```

### Droid Proxy Quick Start

Use port 3457 to avoid conflicts with any existing proxy service on 3456:

```bash
# Note: if you have an existing proxy service with CLAUDE_PROXY_PASSTHROUGH=1
# (e.g., a launchd service), use a different port
CLAUDE_PROXY_DEBUG=1 CLAUDE_PROXY_PORT=3457 bun run ./bin/cli.ts > /tmp/proxy-droid-e2e.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
# → {"status":"healthy","mode":"internal",...}

# Check logs
cat /tmp/proxy-droid-e2e.log | grep "\[PROXY\]"
```

---

## D1: Droid Basic Response

**Verifies:** Proxy detects `factory-cli/` User-Agent, selects droid adapter, returns valid Anthropic-format response.

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Respond with exactly: DROID_E2E_OK"}]
  }' | python3 -m json.tool
```

**Pass criteria:**
- `"type": "message"`, `"role": "assistant"`
- Content includes text block with `DROID_E2E_OK`
- `"stop_reason": "end_turn"`
- Proxy log: `lineage=new session=new` (no prior session)

---

## D2: Droid MCP Server Name

**Verifies:** When Droid requests a tool execution, the proxy uses `mcp__droid__*` tool names (not `mcp__opencode__*`). Confirmed by observing the tool name in the response content block.

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "List the current directory. Use the Bash tool."}],
    "tools": [
      {"name": "Bash", "description": "Run a shell command", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}
    ]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
for block in d['content']:
    if block['type'] == 'tool_use':
        print('Tool name in response:', block['name'])
"
```

**Pass criteria:**
- Tool block name is `mcp__droid__bash` (internal SDK MCP name — confirms droid adapter selected)
- NOT `mcp__opencode__bash`

**What's happening:** The Droid adapter sets `getMcpServerName() = "droid"`, so the SDK registers MCP tools as `mcp__droid__*`. The proxy strips these prefixes before returning to Droid, but the pre-strip name confirms adapter selection.

---

## D3: Droid OpenCode Backward Compat

**Verifies:** Requests without Droid User-Agent still use the OpenCode adapter. All existing OpenCode behavior preserved.

```bash
# No User-Agent → OpenCode adapter
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d3-compat-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OC_COMPAT_OK"}]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][0]['text'])"

# With opencode User-Agent → still OpenCode adapter
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: opencode/1.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "stream": false,
    "messages": [{"role": "user", "content": "Say: OC_UA_OK"}]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][0]['text'])"
```

**Pass criteria:**
- Both responses return valid messages
- No errors
- Proxy log: `lineage=new session=new` for both (both are first requests with those sessions)

---

## D4: Droid CWD from system-reminder

**Verifies:** Proxy extracts the working directory from Droid's `<system-reminder>` block in the first user message content, not from a `system` field (which OpenCode uses).

```bash
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "<system-reminder>\nUser system info\n% pwd\n/Users/dev/my-project\n% ls\nsrc\n</system-reminder>"},
        {"type": "text", "text": "Say: CWD_EXTRACTED_OK"}
      ]
    }]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'])"
```

**Pass criteria:**
- Response contains `CWD_EXTRACTED_OK`
- Proxy log: `msgs=user[text,text]` — multiple content blocks received

**What's happening internally:** `droidAdapter.extractWorkingDirectory()` matches `% pwd\n<path>` inside `<system-reminder>` and returns `/Users/dev/my-project` as the `cwd` passed to the SDK. Different first messages will fingerprint to different sessions.

---

## D5: Droid Fingerprint Session Resume

**Verifies:** Without a session header, Droid sessions are resumed via fingerprint (hash of first user message + CWD). Same first message = same fingerprint = resumed session.

```bash
# Turn 1: Establish session
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "<system-reminder>\n% pwd\n/Users/dev/my-project\n</system-reminder>"},
        {"type": "text", "text": "Remember the code: DROID_FINGERPRINT_88"}
      ]
    }]
  }' > /dev/null

# Turn 2: Same first message → fingerprint resume
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 80,
    "stream": false,
    "messages": [
      {"role": "user", "content": [
        {"type": "text", "text": "<system-reminder>\n% pwd\n/Users/dev/my-project\n</system-reminder>"},
        {"type": "text", "text": "Remember the code: DROID_FINGERPRINT_88"}
      ]},
      {"role": "assistant", "content": [{"type": "text", "text": "Got it — DROID_FINGERPRINT_88."}]},
      {"role": "user", "content": [{"type": "text", "text": "What was the code?"}]}
    ]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'][:80])"
```

**Pass criteria:**
- Turn 2 proxy log: `lineage=continuation session=<8-char-id>` — fingerprint matched, session resumed
- Response includes `DROID_FINGERPRINT_88`

---

## D6: Droid Real Binary Basic

**Prerequisites:** Droid BYOK configured (see [Droid BYOK Setup](#droid-byok-setup)). Proxy running on port 3457.

**Verifies:** Live `droid exec` binary successfully routes through the proxy and receives a valid Claude Max response.

```bash
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "Reply with exactly: REAL_DROID_OK. Nothing else."
```

**Pass criteria:**
- Output: `REAL_DROID_OK` (printed to stdout by droid)
- Proxy log: `model=sonnet stream=true tools=<n> lineage=new session=new` — request received and processed
- No `"isByok": false` errors — authentication via BYOK succeeded
- No 402 Payment Required errors

---

## D7: Droid Real Binary Tool Use

**Prerequisites:** Droid BYOK configured, proxy on port 3457.

**Verifies:** Live `droid exec` can read a file using the `mcp__droid__read` MCP tool registered by the droid adapter.

```bash
# Setup canary file
echo "DROID_CANARY_E2E_42" > /tmp/droid-canary.txt

# Droid reads it via proxy
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --auto medium \
  --cwd /tmp \
  "Read the file /tmp/droid-canary.txt and tell me what it contains. Just the content, nothing else."

# Verify
rm /tmp/droid-canary.txt
```

**Pass criteria:**
- Output: `DROID_CANARY_E2E_42` (droid read the file successfully)
- Proxy log shows `tools=<n>` for the request — Droid sent its tool definitions
- Multi-turn exchange visible in proxy logs (tool call + result + final response)

---

## D8: Droid exec Session Isolation

**Verifies:** Each `droid exec` invocation is a fresh independent session. This is expected behavior — `droid exec` does not pass previous conversation history (unlike interactive TUI mode). Session continuity in interactive mode works via fingerprint resume (D5).

```bash
# Turn 1 — set a secret
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "Remember the code: DROID_SECRET_99. Just say 'noted'."

# Turn 2 — separate exec, no shared history
droid exec \
  --model "custom:claude-haiku-4-5-20251001" \
  --skip-permissions-unsafe \
  --cwd /tmp \
  "What was the secret code?"
```

**Pass criteria:**
- Turn 1 output: `noted` (or similar)
- Turn 2 output: model says it has no record of any secret code — **this is correct behavior**
- Proxy log: both show `lineage=new session=new` — each exec is a fresh session
- No errors or crashes

**Why this is correct:** `droid exec` is a one-shot command that sends only the current prompt as the message. It does not replay prior conversation history. For multi-turn continuity in interactive mode, fingerprint-based resume (D5) kicks in because Droid sends the full message history including the same first-message content.

---

## D9: Droid Streaming SSE

**Verifies:** When Droid requests streaming, the proxy returns correct SSE format with proper event ordering.

```bash
curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": true,
    "messages": [{"role": "user", "content": "Say: STREAM_DROID_OK"}]
  }' | head -25
```

**Pass criteria:**
- First event: `event: message_start` with a valid `message` object
- At least one `event: content_block_delta` with `type: "text_delta"` containing the response text
- Final event: `event: message_stop`
- No `mcp__droid__*` tool blocks leak to the client
- Proxy log: `stream=true`

---

## D10: Droid OpenCode Session Unaffected

**Verifies:** Adding Droid support does not break OpenCode session tracking. The `x-opencode-session` header is still used by the OpenCode adapter for session continuity.

```bash
# OpenCode Turn 1
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d10-oc-backcompat-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 50,
    "stream": false,
    "messages": [{"role": "user", "content": "Remember: OPENCODE_BACKCOMPAT_55"}]
  }' > /dev/null

# OpenCode Turn 2 — same session header → continuation
curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: d10-oc-backcompat-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 80,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Remember: OPENCODE_BACKCOMPAT_55"},
      {"role": "assistant", "content": [{"type": "text", "text": "Got it."}]},
      {"role": "user", "content": "What was the code?"}
    ]
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['content'][-1]['text'][:80])"
```

**Pass criteria:**
- Response includes `OPENCODE_BACKCOMPAT_55`
- Proxy log Turn 2: `lineage=continuation session=<id>` — OpenCode header session resumed correctly
- Droid requests in D1–D9 did not corrupt the OpenCode session cache

---

## Droid Cleanup

```bash
# Restore Droid settings (if BYOK was configured)
cp ~/.factory/settings.json.backup ~/.factory/settings.json 2>/dev/null

# Kill the test proxy
kill $(lsof -ti :3457) 2>/dev/null
```

---

## Crush (Charm) Tests

These tests verify the Crush adapter. Crush connects via a provider entry in `~/.config/crush/crush.json` — no BYOK or special auth needed, just a base_url pointing at the proxy.

### Crush Provider Setup

Add the `meridian` provider to `~/.config/crush/crush.json`:

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
        {
          "id": "claude-sonnet-4-6",
          "name": "Claude Sonnet 4.6 (1M)",
          "context_window": 1000000,
          "default_max_tokens": 64000,
          "can_reason": true,
          "supports_attachments": true
        },
        {
          "id": "claude-opus-4-6",
          "name": "Claude Opus 4.6 (1M)",
          "context_window": 1000000,
          "default_max_tokens": 32768,
          "can_reason": true,
          "supports_attachments": true
        },
        {
          "id": "claude-haiku-4-5-20251001",
          "name": "Claude Haiku 4.5",
          "context_window": 200000,
          "default_max_tokens": 16384,
          "can_reason": true,
          "supports_attachments": true
        }
      ]
    }
  }
}
```

Verify Crush sees the models:
```bash
crush models | grep meridian
# → meridian/claude-haiku-4-5-20251001
# → meridian/claude-opus-4-6
# → meridian/claude-haiku-4-5-20251001
```

---

## C1: Crush Basic Response

**Verifies:** Proxy detects `Charm-Crush/` User-Agent, selects crush adapter, returns valid response.

```bash
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --quiet \
  "Respond with exactly: CRUSH_E2E_OK"
```

**Pass criteria:**
- Output: `CRUSH_E2E_OK`
- Proxy log: `model=sonnet[1m] stream=true tools=19 lineage=new session=new`
- Note: first request may show `rate-limited on [1m], retrying with sonnet` — this is expected, the proxy auto-falls back

---

## C2: Crush Session Continuation

**Verifies:** `crush run --continue` resumes the most recent Crush session via fingerprint-based cache lookup.

```bash
# Turn 1: establish session
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --quiet \
  "Remember the code: CRUSH_CONT_99. Reply with 'stored'."

# Turn 2: continue that session
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --continue \
  --quiet \
  "What was the code I asked you to remember?"
```

**Pass criteria:**
- Turn 1 output: `stored` (or equivalent)
- Turn 2 output: includes `CRUSH_CONT_99`
- Proxy log Turn 2: `lineage=continuation session=<id>` — fingerprint matched, not a new session

---

## C3: Crush Tool Use (Read)

**Verifies:** Crush's tool execution loop works through the proxy. Crush sends a tool call, the proxy returns it (passthrough mode), Crush executes it, sends the result back, and Claude responds with the content.

```bash
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/your/project \
  --quiet \
  "Use the ls tool to list the files in the current directory and show me the output"
```

**Pass criteria:**
- Output shows directory listing (actual files, not hallucinated)
- Proxy log: two entries for the same session — first `lineage=new` (initial turn), then `lineage=continuation` (after tool result returned) — confirms the multi-turn tool loop worked
- `msgs=` on the second log entry shows `tool_use` and `tool_result` in the message chain

**Note:** In `crush run` (headless) mode, all tool operations execute automatically without prompting — there is no interactive terminal to ask for approval. This includes writes, edits, and bash commands.

---

## C3b: Crush Tool Use (Write)

**Verifies:** Write tool executes automatically in `crush run` headless mode — no approval prompt needed.

```bash
crush run \
  --model meridian/claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --quiet \
  "Write the text 'CRUSH_WRITE_OK' to /tmp/crush-write-test.txt"

cat /tmp/crush-write-test.txt   # → CRUSH_WRITE_OK
rm /tmp/crush-write-test.txt
```

**Pass criteria:**
- File exists on disk with correct content
- Proxy log shows multi-turn: `tool_use` then `tool_result` then final text

---

## C4: Crush Model Routing

**Verifies:** Model names in `crush.json` map to the correct Claude Max tiers.

```bash
# Sonnet 4.6 → sonnet[1m]
crush run --model meridian/claude-sonnet-4-6 --quiet "Say: SONNET_OK" 2>/dev/null
# Proxy log: model=sonnet[1m]

# Opus 4.6 → opus[1m]
crush run --model meridian/claude-opus-4-6 --quiet "Say: OPUS_OK" 2>/dev/null
# Proxy log: model=opus[1m]

# Haiku 4.5 → haiku
crush run --model meridian/claude-haiku-4-5-20251001 --quiet "Say: HAIKU_OK" 2>/dev/null
# Proxy log: model=haiku
```

**Pass criteria:**
- Each model routes to the expected tier in proxy logs
- Sonnet 4.6 and Opus 4.6 both show `[1m]` (extended context) for Max subscribers
- Haiku shows `model=haiku` (no extended context)

---

## C5: Crush Backward Compat

**Verifies:** Crush requests coexist with OpenCode and Droid sessions on the same proxy port. No cross-contamination between adapters.

```bash
# Fire all three agents in sequence
crush run --model meridian/claude-haiku-4-5-20251001 --quiet "Say: CRUSH_COEXIST" 2>/dev/null

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: c5-oc-001" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":20,"stream":false,"messages":[{"role":"user","content":"Say: OC_COEXIST"}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'])"

curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "User-Agent: factory-cli/0.89.0" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":20,"stream":false,"messages":[{"role":"user","content":"Say: DROID_COEXIST"}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'])"
```

**Pass criteria:**
- All three respond correctly without interfering with each other
- Proxy logs show `model=haiku` for Crush, normal models for others
- OpenCode session `c5-oc-001` is tracked independently (header-based)
- Droid and Crush both use fingerprint-based tracking independently

---

## Cline Tests

Cline connects via its `anthropicBaseUrl` config key. No adapter needed — it uses the standard Anthropic SDK and falls through to the default (OpenCode) adapter. Passthrough mode handles tool execution correctly.

### Cline Setup

**1. Authenticate with the Anthropic provider:**

```bash
cline auth --provider anthropic --apikey "dummy" --modelid "claude-sonnet-4-6"
```

**2. Set the proxy base URL** in `~/.cline/data/globalState.json`:

```json
{
  "anthropicBaseUrl": "http://127.0.0.1:3456"
}
```

Verify Cline can reach the proxy:
```bash
cline --yolo --model claude-haiku-4-5-20251001 --timeout 20 --json "Say: OK" 2>/dev/null | grep completion_result
```

---

## CL1: Cline Basic Response

**Verifies:** Proxy accepts Cline requests routed via `anthropicBaseUrl`, returns valid response.

```bash
cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 20 \
  --json \
  "Reply with exactly: CLINE_E2E_OK" 2>/dev/null | grep completion_result
```

**Pass criteria:**
- Output includes `CLINE_E2E_OK`
- Proxy log: `model=haiku stream=true tools=11 lineage=new`
- No authentication errors

---

## CL2: Cline File Read

**Verifies:** Cline's tool_use/tool_result passthrough loop works for reading files.

```bash
echo "CLINE_CANARY_123" > /tmp/cline-canary.txt

cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Read /tmp/cline-canary.txt and tell me its exact contents" 2>/dev/null | grep completion_result

rm /tmp/cline-canary.txt
```

**Pass criteria:**
- Output includes `CLINE_CANARY_123`
- Proxy log shows multi-turn: `lineage=continuation` with `tool_use` → `tool_result` in message chain

---

## CL3: Cline File Write

**Verifies:** Cline writes files to disk through the passthrough tool loop.

```bash
rm -f /tmp/cline-write-test.txt

cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Write 'CLINE_WRITE_OK' to /tmp/cline-write-test.txt" 2>/dev/null | grep completion_result

cat /tmp/cline-write-test.txt   # → CLINE_WRITE_OK
rm /tmp/cline-write-test.txt
```

**Pass criteria:**
- File exists on disk with correct content
- Proxy log shows tool_use → tool_result continuation

---

## CL4: Cline Bash Execution

**Verifies:** Bash commands execute through the passthrough loop.

```bash
cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Run 'echo CLINE_BASH_OK' using bash and show the output" 2>/dev/null | grep completion_result
```

**Pass criteria:**
- Output includes `CLINE_BASH_OK`

---

## CL5: Cline File Edit

**Verifies:** Cline edits existing files correctly.

```bash
echo 'function add(a, b) { return a - b }' > /tmp/cline-edit-test.js

cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 45 \
  --json \
  "Fix the bug in /tmp/cline-edit-test.js — it subtracts instead of adding" 2>/dev/null | grep completion_result

cat /tmp/cline-edit-test.js   # → should contain a + b
rm /tmp/cline-edit-test.js
```

**Pass criteria:**
- File on disk shows `a + b` (not `a - b`)
- Proxy log shows read → edit tool chain

---

## CL6: Cline Session Continuation

**Verifies:** Resuming a session with `-T taskId` maintains conversation context through the proxy.

```bash
# Turn 1: create session
OUTPUT=$(cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 30 \
  --json \
  "Remember the code: CLINE_RECALL_55. Say 'noted'." 2>/dev/null)
TASK_ID=$(echo "$OUTPUT" | head -1 | python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('taskId',''))" 2>/dev/null)
echo "Task ID: $TASK_ID"

# Turn 2: resume with task ID
cline --yolo \
  --model claude-haiku-4-5-20251001 \
  --cwd /path/to/project \
  --timeout 30 \
  -T "$TASK_ID" \
  --json \
  "What was the code?" 2>/dev/null | grep completion_result
```

**Pass criteria:**
- Turn 2 output includes `CLINE_RECALL_55`
- Proxy log Turn 2: `lineage=continuation session=<id>`

---

## CL7: Cline Model Routing

**Verifies:** Model names map to correct Claude Max tiers.

```bash
cline --yolo --model claude-sonnet-4-6 --timeout 20 --json "Say: OK" 2>/dev/null > /dev/null
# Proxy log: model=sonnet[1m]

cline --yolo --model claude-opus-4-6 --timeout 20 --json "Say: OK" 2>/dev/null > /dev/null
# Proxy log: model=opus[1m]

cline --yolo --model claude-haiku-4-5-20251001 --timeout 20 --json "Say: OK" 2>/dev/null > /dev/null
# Proxy log: model=haiku
```

**Pass criteria:**
- `claude-sonnet-4-6` → `model=sonnet[1m]`
- `claude-opus-4-6` → `model=opus[1m]`
- `claude-haiku-4-5-20251001` → `model=haiku`

---

## CL8: Cline Multi-Agent Coexistence

**Verifies:** Cline, Crush, and OpenCode all work on the same proxy port simultaneously.

```bash
# Cline
cline --yolo --model claude-haiku-4-5-20251001 --timeout 20 --json "Say: CLINE_COEXIST" 2>/dev/null | grep completion_result

# Crush
crush run --model meridian/claude-haiku-4-5-20251001 --quiet "Say: CRUSH_COEXIST" 2>/dev/null

# OpenCode (curl)
curl -s http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: cl8-oc-001" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":20,"stream":false,"messages":[{"role":"user","content":"Say: OC_COEXIST"}]}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['content'][0]['text'])"
```

**Pass criteria:**
- All three respond correctly
- No cross-contamination between sessions
- Proxy handles all three without errors

---

## File Change Visibility Tests

These tests verify the PostToolUse hook that tracks file write/edit operations and appends a "Files changed" summary to responses. This feature is **internal mode only** — passthrough mode forwards tools to the client, so the proxy never sees tool execution results.

**Requires:** Proxy running in internal mode (no `MERIDIAN_PASSTHROUGH` env var). Use a separate port if your default service runs in passthrough mode.

```bash
kill $(lsof -ti :3457) 2>/dev/null; sleep 1
CLAUDE_PROXY_PORT=3457 bun run ./bin/cli.ts > /tmp/proxy-fc-e2e.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3457/health | python3 -m json.tool
# → mode: "internal"
```

---

## FC1: File Changes Write (non-stream)

**Verifies:** PostToolUse hook captures a write operation and appends "Files changed" summary to non-streaming response.

```bash
rm -f /tmp/e2e-fc-write.txt

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-write-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 300,
    "stream": false,
    "messages": [{"role": "user", "content": "Write the text FILECHANGE_OK to /tmp/e2e-fc-write.txt. Just write it, nothing else."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
full = '\n'.join(texts)
print(full)
"

cat /tmp/e2e-fc-write.txt   # → FILECHANGE_OK
rm /tmp/e2e-fc-write.txt
```

**Pass criteria:**
- File `/tmp/e2e-fc-write.txt` exists on disk with content `FILECHANGE_OK`
- Response text includes `Files changed:` followed by `- wrote /tmp/e2e-fc-write.txt`
- `"type": "message"` in response (valid Anthropic format)

---

## FC2: File Changes Write (stream)

**Verifies:** PostToolUse hook captures a write operation and emits a file change text block in the SSE stream, before `message_stop`.

```bash
rm -f /tmp/e2e-fc-stream.txt

curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-stream-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 300,
    "stream": true,
    "messages": [{"role": "user", "content": "Write the text STREAMFC_OK to /tmp/e2e-fc-stream.txt. Just write it."}]
  }' | tee /tmp/fc-stream-raw.txt | grep -E "text_delta.*Files changed"

cat /tmp/e2e-fc-stream.txt   # → STREAMFC_OK
rm -f /tmp/e2e-fc-stream.txt /tmp/fc-stream-raw.txt
```

**Pass criteria:**
- File exists on disk with `STREAMFC_OK`
- SSE stream contains a `text_delta` event with `Files changed:\n- wrote /tmp/e2e-fc-stream.txt`
- The file change block comes BEFORE `message_stop` in the event stream
- Block index is monotonically increasing (no index collision)

---

## FC3: File Changes Edit

**Verifies:** Edit operations are tracked as "edited" (not "wrote") in the file change summary.

```bash
echo "function greet() { return 'hello' }" > /tmp/e2e-fc-edit.js

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-edit-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 300,
    "stream": false,
    "messages": [{"role": "user", "content": "Edit /tmp/e2e-fc-edit.js to change hello to world. Do not rewrite the whole file, just edit it."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
print('\n'.join(texts))
"

cat /tmp/e2e-fc-edit.js   # → function greet() { return 'world' }
rm /tmp/e2e-fc-edit.js
```

**Pass criteria:**
- File on disk contains `'world'` instead of `'hello'`
- Response text includes `Files changed:` followed by `- edited /tmp/e2e-fc-edit.js`
- Not `- wrote` — the operation must be `edited`

---

## FC4: File Changes Read-only (no summary)

**Verifies:** Read-only tool operations (read, glob, grep) do NOT produce a "Files changed" section in the response.

```bash
echo "READ_ONLY_CONTENT" > /tmp/e2e-fc-readonly.txt

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-readonly-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 200,
    "stream": false,
    "messages": [{"role": "user", "content": "Read the file /tmp/e2e-fc-readonly.txt and tell me what it contains. Do not modify it."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
full = '\n'.join(texts)
has_fc = 'Files changed' in full
print(f'Contains Files changed: {has_fc} (should be False)')
print(f'Contains READ_ONLY_CONTENT: {\"READ_ONLY_CONTENT\" in full}')
"

rm /tmp/e2e-fc-readonly.txt
```

**Pass criteria:**
- Response text includes `READ_ONLY_CONTENT` (file was read)
- Response text does NOT contain `Files changed:` — no write/edit occurred
- No extra text block appended

---

## FC5: File Changes Multiple ops

**Verifies:** Multiple file operations (write + edit) within one turn are all tracked and listed in the summary.

```bash
rm -f /tmp/e2e-fc-multi-a.txt
echo "original content" > /tmp/e2e-fc-multi-b.txt

curl -s http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-multi-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 400,
    "stream": false,
    "messages": [{"role": "user", "content": "Do two things: 1) Write MULTI_A to /tmp/e2e-fc-multi-a.txt. 2) Edit /tmp/e2e-fc-multi-b.txt to change \"original\" to \"modified\". Do both."}]
  }' | python3 -c "
import json, sys
d = json.load(sys.stdin)
texts = [b['text'] for b in d['content'] if b['type'] == 'text']
full = '\n'.join(texts)
idx = full.find('Files changed:')
if idx >= 0:
    print(full[idx:])
else:
    print('NO FILES CHANGED SECTION FOUND')
"

cat /tmp/e2e-fc-multi-a.txt   # → MULTI_A
cat /tmp/e2e-fc-multi-b.txt   # → modified content
rm -f /tmp/e2e-fc-multi-a.txt /tmp/e2e-fc-multi-b.txt
```

**Pass criteria:**
- Both files modified on disk
- Summary includes both: `- wrote /tmp/e2e-fc-multi-a.txt` and `- edited /tmp/e2e-fc-multi-b.txt`
- Deduplication works — each path+operation listed once even if the model called the tool multiple times

---

## FC6: File Changes Multiple ops (stream)

**Verifies:** Multiple file changes in streaming mode are emitted as a single text block before `message_stop`.

```bash
rm -f /tmp/e2e-fc-stream-multi-a.txt /tmp/e2e-fc-stream-multi-b.txt

curl -sN http://127.0.0.1:3457/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: dummy" \
  -H "x-opencode-session: e2e-fc-stream-multi-001" \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 400,
    "stream": true,
    "messages": [{"role": "user", "content": "Write FOO to /tmp/e2e-fc-stream-multi-a.txt and BAR to /tmp/e2e-fc-stream-multi-b.txt"}]
  }' | grep "text_delta" | grep "Files changed"

cat /tmp/e2e-fc-stream-multi-a.txt   # → FOO
cat /tmp/e2e-fc-stream-multi-b.txt   # → BAR
rm -f /tmp/e2e-fc-stream-multi-a.txt /tmp/e2e-fc-stream-multi-b.txt
```

**Pass criteria:**
- Both files exist on disk with correct content
- A `text_delta` event contains `Files changed:\n- wrote /tmp/e2e-fc-stream-multi-a.txt\n- wrote /tmp/e2e-fc-stream-multi-b.txt`
- Only one file change text block (not one per file)

---

## FC Cleanup

```bash
kill $(lsof -ti :3457) 2>/dev/null
rm -f /tmp/proxy-fc-e2e.log
```
