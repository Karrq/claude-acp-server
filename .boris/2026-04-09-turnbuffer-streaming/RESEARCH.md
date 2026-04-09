# Research

## Current Architecture

### Data flow: request to SSE response

1. Client sends `POST /v1/messages` with `stream: true`
2. `AnthropicHttpServer.handle()` (`src/logic/anthropic-api/server.ts:89-138`) creates an `AbortController` and calls `facade.handleMessages()` with a `streamObserver`
3. `AnthropicAcpFacade.handleMessages()` (`src/logic/anthropic-api/facade.ts:64-119`) routes to either `handleInitialPrompt()` or `handleContinuation()`
4. `handleInitialPrompt()` calls `backend.prompt()` with an `onNotification` callback that pushes into the `TurnBuffer`
5. **Crucially:** `backend.prompt()` is `await`ed to completion before anything is returned. The `TurnBuffer` receives all notifications during the prompt, then `buffer.finalize(response)` is called
6. Only after finalization does the facade call `buffer.waitForNextChunk()` to get the first chunk
7. The chunk's notifications are translated into Anthropic SSE events via `translateChunk()` -> `translator.fromPromptResult()`
8. Those events are sent to the `streamObserver` which writes them to the HTTP response

### The blocking point

In `src/logic/anthropic-api/facade.ts:150-159`:
```typescript
const response = await this.backend.prompt({
  sessionId,
  request: promptRequest,
  signal,
  onNotification: (notification) => {
    buffer.pushNotification(notification);
  },
});
buffer.finalize(response);
```

The `await` means the entire prompt execution (which may involve multiple tool calls, thinking, and text generation) completes before any SSE events reach the client.

### TurnBuffer's chunk model

`TurnBuffer` (`src/logic/anthropic-api/turn-buffer.ts`) splits notifications into "chunks" at tool-batch boundaries:
- Each `tool_call` notification adds to `pendingToolIds`
- Each `tool_call_update` with `status === "completed"` or `"failed"` removes from `pendingToolIds`
- When `pendingToolIds` reaches 0 and there are pending notifications, a chunk is flushed with `stopReason: "tool_use"`
- On `finalize()`, remaining notifications flush as a final chunk with `stopReason: "end_turn"`

The TurnBuffer already has an async iteration API: `waitForNextChunk()` returns a `Promise<TurnChunk | null>` that resolves when a chunk is ready or the buffer is finalized. This was designed for continuation requests but is not used for real-time streaming.

### Continuation flow (tool_result requests)

When the client sends a follow-up request containing only `tool_result` blocks:
- `isToolResultContinuation()` detects it (`src/logic/anthropic-api/facade.ts:33-41`)
- `handleContinuation()` serves the next chunk from the TurnBuffer without calling `backend.prompt()` again
- This is fast because the data is already buffered

### The translator's dual interface

`AnthropicPromptTranslator` (`src/logic/anthropic-api/translator.ts`) has two ways to produce Anthropic events:

1. **`createStreamCollector()`** - Returns an object with `start()`, `pushNotification()`, and `finish()` methods. Designed for incremental use: each `pushNotification()` returns the SSE events generated from that notification. This is the streaming-ready interface.

2. **`fromPromptResult()`** - Batch interface. Takes all notifications at once, creates a collector, replays everything, and returns a finalized turn. This is what `translateChunk()` currently uses.

### SSE transport layer

`AnthropicHttpServer` (`src/logic/anthropic-api/server.ts:110-138`):
- Opens SSE with `openSse(response)` when `onReady` fires
- Writes events with `writeSseEvent(response, event.type, event)` on each `onEvent`
- Runs a 2-second heartbeat interval while the stream is open
- Ends the response after `handleMessages()` resolves

The `streamObserver` pattern is already event-driven. The server writes each event as it arrives. The bottleneck is that the facade batches all events before calling the observer.

### Backend notification delivery

`AcpBackendManager.prompt()` (`src/logic/acp-client/backend-manager.ts:144-172`):
- Registers the `onNotification` callback in `promptListeners`
- Calls `connection.prompt(request)` which resolves when the ACP agent finishes
- `sessionUpdate()` (`backend-manager.ts:235-244`) is called by the ACP connection for each notification, which invokes registered listeners

Notifications arrive incrementally during `connection.prompt()`. The `onNotification` callback fires for each one in real-time. The backend manager does not buffer them.

### `FinalizedAnthropicTurn` type

Defined in `src/types.ts:74-79`:
```typescript
export type FinalizedAnthropicTurn = {
  message: Message;
  streamEvents: RawMessageStreamEvent[];
  sessionId: string;
  requestId: string;
};
```

The facade's `handleMessages()` returns this type. The `message` field is the complete Anthropic `Message` object (used for non-streaming responses). The `streamEvents` array is the ordered list of SSE events (used for streaming). Both require the turn to be fully assembled before returning.

### The `AnthropicFacade` interface

Defined in `src/interfaces.ts:30-41`:
```typescript
export interface AnthropicFacade {
  handleMessages(
    headers: Headers,
    body: MessageCreateParamsBase & { stream?: boolean },
    signal?: AbortSignal,
    streamObserver?: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    },
  ): Promise<FinalizedAnthropicTurn>;
  listModels(headers: Headers): Promise<ModelInfo[]>;
}
```

The `streamObserver` is already part of the interface but is only called after all events are batched.

### Tool result caching side effect

The translator's `cacheToolResultFromUpdate()` (`src/logic/anthropic-api/translator.ts:357-419`) writes tool results to `/tmp/claude-acp-tool-results/{toolCallId}.json` on each `tool_call_update` with `completed` or `failed` status. This happens as a side effect during `pushNotification()`. In a streaming model, this would fire in real-time as notifications arrive.

## Decision Points

1. **Where to split the stream for multi-turn.** The TurnBuffer currently collects all notifications and splits at tool-batch boundaries. In a streaming model, the first turn's text/thinking/tool_use events can stream immediately. The question is when to emit `message_delta` (stop_reason) and `message_stop` - these signal the end of a turn to the client.

2. **Return type of handleMessages.** Currently returns `Promise<FinalizedAnthropicTurn>` which includes `message` (complete Message object). Streaming means the return value may not have all content until the stream finishes. The non-streaming path also uses this return value.

3. **Collector lifecycle across chunks.** Currently `translateChunk()` creates a fresh collector per chunk via `fromPromptResult()`. For real-time streaming, a single collector would live for the duration of a chunk, calling `pushNotification()` incrementally. At tool-batch boundaries, `finish()` would be called, and a new collector started for the next chunk.

4. **Continuation requests under streaming.** Currently, continuation requests return the next pre-buffered chunk. With streaming, the initial request's stream may still be open when tool-batch boundary is hit. The continuation request needs to either: (a) open a new SSE stream for the next chunk, or (b) the initial stream continues through all chunks. Option (a) preserves the current multi-request model that clients expect from the Anthropic API (each tool_use stop triggers a new request/response cycle).

## References

- Prior task: `.boris/2026-04-09-incremental-prompting/OVERVIEW.md` - established the incremental prompt model and TurnBuffer
- Anthropic streaming SSE spec: events are `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
