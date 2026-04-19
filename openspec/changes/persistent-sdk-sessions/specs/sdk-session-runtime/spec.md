## ADDED Requirements

### Requirement: SessionRuntime holds one live SDK query per logical session

The system SHALL maintain a `SessionRuntime` per logical session (keyed by `profileSessionId`) that owns exactly one live `@anthropic-ai/claude-agent-sdk` `query()` with an AsyncIterable input queue for the session's lifetime, enabling prompt-cache reuse across turns by avoiding re-entry into the SDK's `resume` serialization path.

#### Scenario: First turn for a new session creates a runtime
- **WHEN** a POST /v1/messages request arrives for a `profileSessionId` with no entry in the live-query map and no existing Claude SDK session in `sessionStore`
- **THEN** the system SHALL construct a new `SessionRuntime` with an AsyncIterable input queue
- **AND** the system SHALL start `query({ prompt: inputQueue, options })` without the `resume` option
- **AND** the system SHALL push the request's user message into the input queue
- **AND** the system SHALL hold the runtime alive after the turn completes

#### Scenario: Second turn on a warm session reuses the runtime
- **WHEN** a POST /v1/messages request arrives for a `profileSessionId` that already has a live `SessionRuntime` in the map
- **THEN** the system SHALL NOT call `query()` again
- **AND** the system SHALL push the request's user message into the existing runtime's input queue
- **AND** the Anthropic request emitted by the SDK for this turn SHALL include `cacheReadInputTokens > 0` covering the shared prefix with the prior turn

#### Scenario: Subprocess crash is transparently recovered on the next turn
- **WHEN** the SDK subprocess for a live runtime dies unexpectedly between turns
- **THEN** the system SHALL detect the crash (via iterator throw or stderr signal) and remove the dead runtime from the live-query map
- **AND** the next request for the same `profileSessionId` SHALL trigger cold reattach (start a new `query({ resume: claudeSessionId })` and hold it alive)

### Requirement: Streaming-input mode with per-turn boundary detection

The system SHALL use the SDK's streaming-input mode (`prompt: AsyncIterable<SDKUserMessage>`) and SHALL detect per-turn boundaries from `SDKResultMessage` events (empirically verified — see `spike-notes.md`) so the HTTP handler can finish one turn without the underlying `Query` terminating.

#### Scenario: Turn boundary is observed and the HTTP response completes
- **WHEN** the model finishes a turn (model emits its final assistant message or the SDK otherwise signals turn end)
- **THEN** the system SHALL observe an event with `type === "result"` on the query's output stream
- **AND** the system SHALL close the HTTP response / SSE stream for that request
- **AND** the `Query` SHALL remain alive and consumable for the next turn

#### Scenario: Turn iterator survives early consumer exit
- **WHEN** the consumer of `SessionRuntime.consumeTurn()` stops reading after the `result` event
- **THEN** the underlying SDK query iterator SHALL NOT be invalidated
- **AND** a subsequent call to `consumeTurn()` SHALL read new events beginning with the next turn's `system(init)` message

#### Scenario: Two consecutive turns on the same runtime each complete cleanly
- **WHEN** two sequential requests arrive on the same session and each pushes a user message into the queue
- **THEN** the first request's HTTP response SHALL end at the first turn terminator
- **AND** the second request's HTTP response SHALL end at the second turn terminator
- **AND** no assistant content from the second turn SHALL leak into the first response, and vice versa

### Requirement: Per-session mutex serializes turns

The system SHALL prevent concurrent turns from being pushed into a single `SessionRuntime`'s input queue by serializing through a per-session mutex, because the AsyncIterable queue is single-writer.

#### Scenario: Concurrent requests for the same session are serialized
- **WHEN** two requests for the same `profileSessionId` arrive before the first one completes
- **THEN** the system SHALL acquire the runtime's mutex for the first request and process it to completion
- **AND** the system SHALL wait for the mutex before processing the second request
- **AND** the system SHALL NOT interleave assistant output between the two requests

#### Scenario: Mutex queue overflow returns HTTP 429
- **WHEN** a request for a `profileSessionId` waits on the mutex longer than the configured queue-wait cap (default 30 s)
- **THEN** the system SHALL abort the wait and return HTTP 429 to the client

### Requirement: Cold-reattach via SDK resume on restart or eviction

The system SHALL transparently reattach to an existing Claude SDK session when a request arrives for a `profileSessionId` whose session is known in `sessionStore` but absent from the in-memory live-query map (process restart, idle eviction, or crash cleanup).

#### Scenario: Cold reattach after process restart
- **WHEN** the proxy starts and receives a request for a `profileSessionId` whose Claude SDK session id exists on disk but the live-query map is empty
- **THEN** the system SHALL start a new `query({ prompt: inputQueue, options: { resume: claudeSessionId, ...rest } })`
- **AND** the system SHALL push the request's user message into the queue
- **AND** the system SHALL hold the resulting runtime alive for subsequent turns

#### Scenario: Cold reattach after idle eviction
- **WHEN** a runtime was evicted for idle and a request later arrives for the same `profileSessionId`
- **THEN** the system SHALL perform cold reattach identically to the restart case (one cache miss acceptable on this reattach turn; subsequent turns SHALL cache-hit)

### Requirement: Options drift triggers in-place update or controlled reopen

The system SHALL classify every per-request option as either *in-place-updatable* or *reopen-required*. In-place options SHALL be applied to the live `Query` via SDK control methods. Reopen-required options, when their hash changes between turns, SHALL cause the current runtime to `close()` and a new runtime to start via cold reattach.

#### Scenario: Model change applied in place
- **WHEN** a request for an existing runtime requests a different `model` than the previous turn
- **THEN** the system SHALL call `liveQuery.setModel(newModel)` before pushing the user message
- **AND** the system SHALL NOT close the existing runtime

#### Scenario: System prompt change forces reopen
- **WHEN** a request for an existing runtime carries a different `systemPrompt` than the runtime's snapshot (detected by options hash mismatch)
- **THEN** the system SHALL call `liveQuery.close()`
- **AND** the system SHALL remove the runtime from the live-query map
- **AND** the system SHALL start a new runtime via cold reattach with the new options
- **AND** the Anthropic request for this turn MAY miss the prompt cache; subsequent turns SHALL cache-hit

#### Scenario: Effort and thinking change applied in place
- **WHEN** a request changes `effort` or `thinking` settings
- **THEN** the system SHALL call `liveQuery.applyFlagSettings({...})` before pushing the user message
- **AND** the system SHALL NOT close the existing runtime

### Requirement: Undo / fork always reopens with fork options

When a request signals an undo or fork operation (existing lineage classification: undo / diverged-from-rollback-point), the system SHALL close the existing runtime and open a new one with `forkSession: true, resumeSessionAt: <uuid>` to match today's forking semantics.

#### Scenario: Undo against a warm runtime
- **WHEN** a request arrives with undo semantics for a `profileSessionId` that has a live runtime
- **THEN** the system SHALL call `liveQuery.close()` on the current runtime
- **AND** the system SHALL start a new `query({ prompt: inputQueue, options: { resume: claudeSessionId, forkSession: true, resumeSessionAt: undoRollbackUuid, ...rest } })`
- **AND** the system SHALL push the request's user message into the new runtime's input queue
- **AND** the session cache SHALL be updated to reflect the forked session id returned by the SDK

### Requirement: LRU eviction bounds live-query memory

The system SHALL enforce an LRU eviction policy on the live-query map with two tunable limits: an idle timeout (default 15 min) and a hard cap on concurrent live queries (default 32). On eviction, `liveQuery.close()` SHALL be called; the session SHALL remain resumable from disk.

#### Scenario: Idle eviction after timeout
- **WHEN** a runtime's `lastActivity` is older than `persistentSessionIdleMs` and no mutex is held
- **THEN** the system SHALL call `liveQuery.close()`
- **AND** the system SHALL remove the runtime from the live-query map
- **AND** the entry in `sessionStore` SHALL be preserved so the next request can cold-reattach

#### Scenario: Hard cap eviction when creating a new runtime
- **WHEN** a new runtime is about to be created and the live-query map is at `persistentSessionMaxLive`
- **THEN** the system SHALL evict the least-recently-active runtime (closing its query) before creating the new one

### Requirement: Passthrough tool execution uses a deferred MCP handler per runtime

The system SHALL execute passthrough (client-executed) tools via a deferred-handler MCP pattern validated in spike §1d Scenario D. For each tool_use the model emits, the per-runtime MCP handler SHALL create a pending entry in `SessionRuntime.pendingExecutions` (keyed by `tool_use_id`) and return a promise. The SDK blocks on that promise. Meridian's SSE layer SHALL forward the tool_use to the client and close the client's HTTP stream with `stop_reason: "tool_use"`. When the client's next HTTP request arrives carrying `tool_result` blocks, the system SHALL resolve the matching pending entries with the tool_result content; the SDK receives the real content as the tool's native return value and continues processing. The system SHALL NOT use a PreToolUse hook that returns `{decision: "block"}` — that mechanism was proven to pollute conversation state with synthetic "blocked" narrative.

#### Scenario: Single passthrough tool completes cleanly across turns
- **WHEN** the model emits a tool_use in a passthrough session
- **THEN** the MCP handler SHALL register a pending entry keyed by the tool_use id and return a promise
- **AND** the SSE layer SHALL forward the tool_use content_blocks to the client, then emit `message_delta { stop_reason: "tool_use" }` and `message_stop` and close the SSE stream
- **AND** on the client's next HTTP request with a user message containing a matching `tool_result`, the system SHALL resolve the pending promise with the tool_result content
- **AND** the SDK SHALL continue the turn and emit the final assistant response with the real tool content reflected in history
- **AND** a subsequent follow-up turn SHALL cache-read the full prior prefix (`cacheReadInputTokens > 0`)

#### Scenario: Multi-tool parallel passthrough completes sequentially
- **WHEN** the model emits multiple tool_use blocks in a single assistant message
- **THEN** the MCP handlers SHALL be invoked sequentially, each creating its own pending entry
- **AND** the system SHALL resolve pending entries in the order the SDK invokes them as tool_result blocks arrive from the client
- **AND** the SDK SHALL produce a final assistant response that combines all tool outputs

#### Scenario: Pending handler rejection does not corrupt the runtime
- **WHEN** a pending handler's promise is rejected (idle timeout, explicit cancellation, or graceful shutdown)
- **THEN** the SDK SHALL receive an error tool_result and continue turn processing
- **AND** the runtime SHALL remain usable for subsequent turns, OR the runtime SHALL be cleanly evicted as part of a timeout policy
- **AND** the client's subsequent request SHALL either find a healthy runtime or a cold-reattach path

#### Scenario: Tool-surface change across turns reopens the runtime
- **WHEN** a request's tool set differs from the runtime's snapshot (detected by options hash mismatch)
- **THEN** the system SHALL close the runtime and cold-reattach with a fresh passthrough MCP bound to the new tool surface

### Requirement: Feature flag gates persistent mode

The system SHALL expose `ProxyConfig.persistentSessions: boolean` with a default of `false`. When `false`, the system SHALL use the existing `query({ resume })` per-request path unchanged. When `true`, the system SHALL use `SessionRuntime` for every non-undo request.

#### Scenario: Flag off preserves existing behavior
- **WHEN** `ProxyConfig.persistentSessions` is `false`
- **THEN** the system SHALL call `query({ resume: resumeSessionId, ... })` per request exactly as it does today
- **AND** no `SessionRuntime` SHALL be constructed
- **AND** all existing tests SHALL pass unchanged

#### Scenario: Flag on routes requests through SessionRuntime
- **WHEN** `ProxyConfig.persistentSessions` is `true`
- **THEN** every non-undo request for a given `profileSessionId` SHALL be handled by the session's `SessionRuntime`
- **AND** the external HTTP contract (request/response shape, headers) SHALL be unchanged

### Requirement: Graceful shutdown closes all live queries and rejects pending handlers

The system SHALL ensure that `ProxyInstance.close()` closes every live `Query`, rejects every pending deferred-handler promise, and awaits subprocess termination before returning. Shutdown SHALL NOT leak Claude subprocesses or hang on blocked MCP handlers.

#### Scenario: ProxyInstance.close() closes live runtimes and rejects pending handlers
- **WHEN** `ProxyInstance.close()` is called while N runtimes are live and K pending deferred handlers are registered
- **THEN** the system SHALL reject each pending handler's promise with a shutdown error so the SDK unblocks
- **AND** the system SHALL call `liveQuery.close()` on each runtime
- **AND** the system SHALL wait for each subprocess to terminate (bounded by a shutdown timeout, default 10 s)
- **AND** the live-query map SHALL be empty when `close()` resolves

### Requirement: User content is cache_control-stripped before pushing into input queue

The system SHALL strip all `cache_control` properties (including nested properties inside `tool_result` content blocks) from every user content object before pushing into a `SessionRuntime.inputQueue`. Anthropic caps cache_control breakpoints at 4 per request, and clients such as Pi attach `cache_control: {type: "ephemeral"}` to every user turn — in persistent mode these would accumulate in SDK in-memory history and cause the SDK's outbound Anthropic request to exceed the cap after 4+ turns.

#### Scenario: Plain user text with cache_control is sanitized
- **WHEN** a request's last user message content is an array containing `{type: "text", text: "...", cache_control: {...}}` blocks
- **THEN** the system SHALL strip the `cache_control` property from every block before pushing into the input queue
- **AND** the pushed `SDKUserMessage.message.content` SHALL contain no `cache_control` properties

#### Scenario: tool_result content with nested cache_control is sanitized
- **WHEN** a request's last user message content is an array containing `tool_result` blocks whose inner `content` arrays include cache_control properties
- **THEN** the system SHALL strip `cache_control` recursively at every nesting depth before pushing

### Requirement: Cache-trace observability tags mode

The system SHALL emit cache-trace events with a `mode` field of either `persistent` or `resume` so the cache-hit delta between modes is measurable per adapter.

#### Scenario: Persistent-mode request emits mode=persistent in trace
- **WHEN** a request is handled via a `SessionRuntime` (flag on, warm or cold-reattached runtime)
- **THEN** the emitted cache-trace event SHALL include `mode: "persistent"` alongside the existing token fields

#### Scenario: Resume-mode request emits mode=resume in trace
- **WHEN** a request is handled via the existing `query({ resume })` path (flag off)
- **THEN** the emitted cache-trace event SHALL include `mode: "resume"`

### Requirement: Spike prerequisite gates the server refactor

The system changes behind the feature flag SHALL NOT be merged until a standalone spike proves that turn 2 of a streaming-input SDK session returns `cacheReadInputTokens > 0`. Spike results SHALL be captured in a spike-notes artifact under the change directory.

#### Scenario: Spike passes and refactor proceeds
- **WHEN** the spike reports `cacheReadInputTokens > 0` on turn 2 with the intended options profile
- **THEN** the server-wiring task becomes unblocked
- **AND** a `spike-notes.md` SHALL exist in the change directory capturing the cache metrics per turn

#### Scenario: Spike fails and the change is revisited
- **WHEN** the spike reports `cacheReadInputTokens == 0` on turn 2
- **THEN** the change SHALL NOT proceed to server wiring
- **AND** the design SHALL be revisited (fallback: outbound Anthropic interceptor or structured-prompt approach)
