# Research

## How the current prompt flow works

### Pi sends a Messages API request

Pi (the client) sends standard Anthropic Messages API requests to the ACP server. Each request contains the full conversation history: system prompt, all prior user/assistant messages, and the new user message at the end.

For a follow-up turn, the message array looks like:
```
[user_1, assistant_1, user_2, assistant_2, ..., user_N]
```

This is standard Messages API behavior - the client replays the full history because the API is stateless.

### `anthropicRequestToPromptRequest()` serializes ALL prior messages into a transcript

`src/helpers/messages.ts:353-414`

This function takes the full Messages API request and converts it to an ACP `PromptRequest`. It:

1. Extracts system prompt, tools, and all messages **except the last** into a serialized text transcript:
   ```
   "Conversation context for this ACP session bootstrap:\n\n"
   + SYSTEM: ...
   + USER: message_1
   + ASSISTANT: message_2
   + ...
   + "Use the transcript as prior context. The next blocks are the current user turn."
   ```
2. Converts only the **final user message** into actual ACP `ContentBlock[]` items.
3. Wraps everything in `{ sessionId, prompt: [...] }`.

The transcript is a single large text block prepended to the actual user content. Every prior message is flattened into text, including tool_use and tool_result blocks (serialized as `[tool_use:name:id]` and `[tool_result:id]` strings).

### `facade.ts` calls `backend.prompt()` on every user turn

`src/logic/anthropic-api/facade.ts:125-187` (`handleInitialPrompt`)

For every non-continuation request (i.e., every new user message), the facade:
1. Calls `ensureSession()` (which resumes or creates the ACP backend session)
2. Calls `this.translator.toPromptRequest(sessionId, body)` - serializing the full conversation
3. Calls `this.backend.prompt({ sessionId, request: promptRequest, ... })` - sending it all to the backend
4. Buffers notifications in a TurnBuffer

The backend receives the full serialized transcript every time, even though it already has the conversation history in its resumed session.

### The ACP `PromptRequest` type

From the SDK (`@agentclientprotocol/sdk`):

```typescript
type PromptRequest = {
  _meta?: { [key: string]: unknown } | null;
  messageId?: string | null;  // unstable
  prompt: Array<ContentBlock>;
  sessionId: SessionId;
};
```

It takes a `sessionId` and a `prompt` (array of content blocks). The prompt represents **the user's message for this turn**. The session is stateful - the backend remembers all prior turns within a session.

### Session resumption works correctly

`src/logic/acp-client/backend-manager.ts:72-129`

The backend manager caches `acpSessionId` and calls `unstable_resumeSession()` on subsequent requests. From the debug logs, this consistently succeeds - the same session ID `2eb78901` is used across all turns. The backend session is persistent and maintains its own conversation state.

### The TurnBuffer continuation detection

`src/logic/anthropic-api/facade.ts:33-41, 109-118`

The facade has a `isToolResultContinuation()` check that detects when the last user message is exclusively `tool_result` blocks. This works correctly for intra-prompt-cycle continuations (when the backend's single prompt() call produced tool_use chunks). The TurnBuffer serves subsequent chunks without re-prompting.

This mechanism is orthogonal to the cross-turn problem: it handles splitting one backend prompt() into multiple Messages API responses. It does not help with the case where a new user message arrives.

### What the backend sees on each turn

From the debug logs, each new user message triggers:
1. `ensureSession()` -> resume succeeds (same session ID)
2. `handleInitialPrompt` -> calls `backend.prompt()` with a `PromptRequest` containing the full serialized transcript

The backend (Claude Code) receives this full transcript as the "user message" for each turn. Since the backend session already has the prior conversation, it sees the history twice: once in its own session state, and again in the serialized transcript text block.

### `contentBlockToAcp` for tool_result

`src/helpers/messages.ts:334-340`

Tool results in the Messages API (`tool_result` type blocks) are converted to plain text:
```typescript
case "tool_result":
  return [{
    type: "text",
    text: `[tool_result:${block.tool_use_id}] ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
  }];
```

These get serialized into the transcript text blob.

## Decision points

1. **What to send as the prompt on follow-up turns**: The ACP `PromptRequest.prompt` needs only the new user content. The question is how to extract just the new user message from the full Messages API request that Pi sends.

2. **First turn vs. follow-up turns**: The first turn has no prior backend session state, so it may still need the system prompt and any initial context. Follow-up turns should only need the new user message.

3. **System prompt handling**: Currently the system prompt is serialized into the transcript on every turn. On the first turn this is necessary. On follow-up turns, the backend session already has it.

4. **Tool results across turns**: When a tool_use chunk is returned to Pi and Pi sends back tool_results, those tool_results should be discarded. The backend already executed those tool calls within its session state - the results Pi sends back are just echoes of what the backend already has. Sending them again would be redundant (or confusing).

5. **Detecting first vs. follow-up turn**: The server needs to know whether the backend session already has conversation history. Options include tracking a "has prompted at least once" flag, or relying on the session resume/create distinction.
