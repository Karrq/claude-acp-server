# Design

## Goal and approach

Stream Anthropic SSE events to the client in real-time as ACP notifications arrive, while preserving the multi-turn request/response cycle at tool-batch boundaries. Each turn's SSE stream ends with `stop_reason: "tool_use"` + `message_stop` when all pending tool calls complete. The client sends a `tool_result` continuation to get the next turn's stream.

The approach: stop awaiting `backend.prompt()` before streaming. Instead, fire off the prompt, stream SSE events as notifications arrive, and use the TurnBuffer's existing chunk boundary detection to signal when to end each SSE stream.

## Decisions made

### 1. Stream within each chunk, split across chunks

Each Anthropic API "turn" (request/response cycle) corresponds to one TurnBuffer chunk. Within a chunk, SSE events stream in real-time. At the chunk boundary (all pending tools completed), `message_delta` and `message_stop` are emitted and the HTTP response ends. The continuation request opens a new SSE stream for the next chunk.

**Reasoning:** This preserves the Anthropic Messages API contract. Clients expect `stop_reason: "tool_use"` to mean "send me tool_result to continue." The multi-request cycle stays intact.

### 2. TurnBuffer signals chunk boundaries; facade coordinates streaming

The TurnBuffer keeps its chunk-boundary detection (pendingToolIds tracking). A new mechanism lets the facade know when a boundary is hit so it can finalize the current SSE stream. The facade uses the translator's `createStreamCollector()` to convert notifications to SSE events incrementally, forwarding each to the `streamObserver`.

**Reasoning:** The TurnBuffer already has the right boundary logic. The translator's `createStreamCollector()` already supports incremental `pushNotification()` returning SSE events. The facade is the natural coordinator between these two.

### 3. backend.prompt() runs in the background

`handleInitialPrompt()` starts `backend.prompt()` without awaiting it. The promise is stored so errors can be caught. The `onNotification` callback feeds the TurnBuffer, which feeds the stream collector, which feeds the `streamObserver`. When a chunk boundary is hit, the facade ends the current HTTP response. The prompt continues running. Continuation requests pick up the next chunk's stream mid-flight via `waitForNextChunk()`.

**Reasoning:** This is the core change that unblocks streaming. The prompt may still be running when the continuation arrives, which is fine - `waitForNextChunk()` already handles waiting for the next chunk.

### 4. handleMessages() return type stays the same

`FinalizedAnthropicTurn` is still returned. For the streaming path, the events have already been sent via `streamObserver`, so the return value is used only for the non-streaming path and for metadata (sessionId, requestId). The `message` and `streamEvents` fields are populated from the collector's `finish()` call at chunk boundary.

**Reasoning:** Minimal interface change. The non-streaming path (no `streamObserver`) can still batch and return the full turn. The server only uses the return value for non-streaming JSON responses.

### 5. Continuation requests stream in real-time too

If the backend is still running when a continuation arrives, the facade creates a new collector and streams the next chunk's notifications as they arrive. If the backend already finished, all notifications for that chunk are already in the buffer and are replayed immediately (fast path, same as today).

**Reasoning:** Continuations should stream for the same reason the initial request should. The TurnBuffer's `waitForNextChunk()` already handles both cases (data ready vs. waiting for data).

## Excluded approaches

### Streaming all turns through a single SSE connection
One long-lived SSE stream that spans all tool-use turns, with synthetic delimiters between turns. Rejected because it breaks the Anthropic API contract: clients expect each `tool_use` stop to end the response, then send a new request with `tool_result`.

### Modifying the BackendManager to support streaming differently
The backend manager already delivers notifications incrementally via callbacks. No changes needed there.

## Tradeoffs accepted

- **Prompt error handling becomes async.** If `backend.prompt()` rejects after some events have already been streamed, the SSE stream may end abruptly. This is acceptable because: (a) it matches how real Anthropic streaming behaves on errors, and (b) the alternative (awaiting the full prompt) is the exact problem we're solving.

- **Collector state lives in the facade during streaming.** The facade holds a reference to the active stream collector between notifications. This is per-session state that didn't exist before. Acceptable because sessions are already stateful (TurnBuffer, backend session).

## Key constraints

- The Anthropic SSE event sequence must be valid: `message_start` first, then `content_block_start`/`delta`/`stop` sequences, ending with `message_delta` + `message_stop`.
- `message_start` must be emitted before any content events. The collector's `start()` method handles this.
- Tool result caching (`/tmp/claude-acp-tool-results/`) must still happen as tool calls complete. This is a side effect in the collector's `pushNotification()` which fires naturally in the streaming model.
- The non-streaming path (no `streamObserver`) must continue to work as a batch operation.
