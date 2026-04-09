# TurnBuffer Streaming

**Status:** in progress (research)

**Original request:** The TurnBuffer currently waits for `backend.prompt()` to complete before returning anything to the client. The client sees nothing until the entire multi-turn execution finishes. Add streaming so the client gets incremental SSE events (text deltas, tool use blocks, thinking) as they arrive from the backend, while preserving the TurnBuffer's chunk-ordering for multi-turn tool-use cycles.

**Task scope:** Make the facade stream Anthropic SSE events to the client in real-time as ACP notifications arrive, rather than buffering everything until prompt completion.
