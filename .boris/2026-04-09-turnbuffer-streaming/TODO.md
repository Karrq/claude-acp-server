# TODO

- [x] Add `onNotification` and `onChunkBoundary` callbacks to TurnBuffer
- [x] Add `onFinalize` callback to TurnBuffer for prompt completion signal
- [x] Rewrite `handleInitialPrompt()` streaming path: create collector, emit message_start, start prompt in background, forward events via callbacks, finalize at chunk boundary
- [x] Rewrite `handleContinuation()` streaming path: stream buffered or live notifications through collector
- [x] Verify non-streaming path (no streamObserver) still works as batch
- [x] Typecheck passes
- [ ] Test end-to-end: stream=true request receives incremental SSE events
