# Structure

## Affected parts

### 1. `src/logic/anthropic-api/turn-buffer.ts` - Add per-notification streaming

The TurnBuffer needs a way for the facade to receive individual notifications as they arrive, not just completed chunks. Add an async iterator or callback mechanism that yields each notification in real-time, while still tracking chunk boundaries.

New capability: `onNotification` callback that fires for every notification pushed. The facade registers this to forward events to the stream collector. Chunk boundary signals (`onChunkBoundary`) tell the facade when to finalize the current SSE stream.

The existing `waitForNextChunk()` API stays for the continuation fast-path (chunk already buffered).

### 2. `src/logic/anthropic-api/facade.ts` - Stream-aware handleInitialPrompt

The main change. `handleInitialPrompt()` stops awaiting `backend.prompt()` upfront. Instead:

1. Create a stream collector via `translator.createStreamCollector()`
2. Emit `message_start` via `streamObserver.onEvent(collector.start())`
3. Start `backend.prompt()` (don't await it yet)
4. As notifications arrive via the TurnBuffer's callback: translate each through the collector's `pushNotification()`, forward resulting SSE events to `streamObserver`
5. When TurnBuffer signals a chunk boundary: call `collector.finish()` with a synthetic response (stop_reason: tool_use), end the SSE stream
6. When TurnBuffer signals finalization (prompt done, last chunk): call `collector.finish()` with the real response, end the SSE stream

For the non-streaming path (no `streamObserver`): await the prompt to completion, then use `fromPromptResult()` as today.

`handleContinuation()` gets the same treatment: if there's a `streamObserver` and the next chunk isn't fully buffered yet, stream notifications as they arrive. If the chunk is already buffered, replay it through the collector incrementally (still streaming SSE events one by one rather than batching).

### 3. `src/logic/anthropic-api/facade.ts` - `translateChunk` replaced by streaming

The current `translateChunk()` method creates a collector per chunk in batch mode. For streaming, the collector is created upfront and fed incrementally. `translateChunk()` remains for the non-streaming path but the streaming path bypasses it.

## Sequencing

**Step 1: Add streaming hooks to TurnBuffer.**
Add `onNotification` and `onChunkBoundary` callbacks. These fire during `pushNotification()` and `flushChunk()`. The existing chunk-buffering logic stays intact - these are additive callbacks that run alongside it.

**Step 2: Wire streaming in `handleInitialPrompt()`.**
When `streamObserver` is present: create a collector, emit `message_start`, register TurnBuffer callbacks, start the prompt without awaiting. Wait for the first chunk boundary or finalization. Forward events as they arrive.

**Step 3: Wire streaming in `handleContinuation()`.**
Same pattern but for continuation requests. If the chunk is already buffered, replay through a collector with SSE forwarding. If the chunk is still in-flight, stream live.

**Step 4: Verify non-streaming path unchanged.**
Ensure requests without `stream: true` still batch and return `FinalizedAnthropicTurn` with complete `message` and `streamEvents`.

## Dependency handling

Step 1 is independent. Steps 2 and 3 depend on Step 1. Step 4 is verification of steps 2-3.
