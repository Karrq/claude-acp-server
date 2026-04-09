# Design

## Goal and approach

Stop replaying the full conversation history to the backend on every turn. Instead, send only the new user message content as the ACP `PromptRequest.prompt`. The backend session is stateful and retains all prior context.

## Decisions made

### 1. Always incremental - no transcript, no first-turn special case

Every turn works the same way: extract the last user message from Pi's request, convert its content blocks to ACP `ContentBlock[]`, send as the prompt. No transcript is ever built. No `hasPrompted` flag is needed.

This works because:
- **System prompt** is passed via `_meta` on session creation (already implemented through `CLAUDE_ACP_OPTIONS`). The backend has it from the start.
- **Tool context** is handled by the backend. The restricted tool set is already configured at session level, so the backend knows what tools are available.
- **First turn** has exactly one user message, so "extract the last user message" naturally gives you the only message.

### 2. Replace `anthropicRequestToPromptRequest()` with direct extraction

The existing `anthropicRequestToPromptRequest()` function (`src/helpers/messages.ts:353-414`) builds a transcript from all prior messages and prepends it to the prompt. This function is replaced (or bypassed) with a simpler approach:

1. Take `request.messages[request.messages.length - 1]` (the last user message)
2. Convert its content blocks via the existing `contentBlockToAcp()`
3. Return `{ sessionId, prompt: [...convertedBlocks] }`

The transcript-building code (`contextLines`, `messageToTranscriptLine`, the "Conversation context for this ACP session bootstrap" wrapper) is no longer used for this path.

### 3. Tool results from Pi are discarded

When the backend produces tool_use chunks (served via TurnBuffer), Pi sends back tool_results in its next request. These are echoes of what the backend already executed. The server discards them via the existing `isToolResultContinuation` + `hasTurnBuffer` path, which serves the next buffered chunk without re-prompting.

## Excluded approaches

### Transcript on first turn
Rejected. The system prompt and tool context are already provided to the backend through session creation (`_meta`) and the configured tool set. There's no need to serialize them into a transcript text block.

### `hasPrompted` flag to distinguish first vs. follow-up turns
Rejected. Since every turn uses the same "extract last user message" approach, there's no need to track turn count. The logic is stateless with respect to turn history.

### Diffing message arrays to find new messages
Rejected as unnecessary complexity. The last user message is always the new one.

### Detecting when Pi goes back in time (dropped messages)
Deferred. If Pi replays a shorter history (e.g., user edited a message mid-conversation), the backend session state and Pi's view would diverge. Handling this requires detecting the mismatch and either forking/resetting the backend session. This is a separate, harder problem.

### Optimizing `ensureSession()` calls
Out of scope. The `ensureSession()` call on every request is wasteful but orthogonal to this change.

## Tradeoffs accepted

- **No validation that Pi's history matches backend state.** We trust they stay in sync. If the backend session is lost or Pi edits history, the server would send a bare user message to a backend with no context. Session loss and history editing are separate error cases to handle later.
- **Transcript code becomes dead code.** The `anthropicRequestToPromptRequest()` function and its transcript-building helpers are no longer used in the main flow. They can be removed or kept for reference.

## Key constraints

- The `PromptRequest.prompt` field is `Array<ContentBlock>` - it accepts the same content block types produced by `contentBlockToAcp()`.
- The `contentBlockToAcp()` function in `src/helpers/messages.ts` already handles text, image, document, tool_result, and tool_use block types.
- The `isToolResultContinuation` + TurnBuffer path must continue to work unchanged for intra-prompt tool cycling.
