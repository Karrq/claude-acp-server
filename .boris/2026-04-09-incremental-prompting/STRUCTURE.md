# Structure

## Affected parts of the system

### 1. `src/helpers/messages.ts` - New export: `extractLastUserPrompt()`

Add a new function that does the minimal extraction:

```typescript
export function extractLastUserPrompt(
  sessionId: string,
  request: MessageCreateParamsBase,
): PromptRequest {
  const finalMessage = request.messages[request.messages.length - 1];
  if (finalMessage.role !== "user") {
    throw new HttpError({
      status: 400,
      type: "invalid_request_error",
      message: "The final message must have role=user.",
    });
  }

  const prompt: ContentBlock[] = [];
  for (const block of normalizeMessageContent(finalMessage.content)) {
    prompt.push(...contentBlockToAcp(block));
  }

  return { sessionId, prompt };
}
```

This reuses the existing `normalizeMessageContent()` and `contentBlockToAcp()` helpers. The `anthropicRequestToPromptRequest()` function remains in the file (dead code for now) but is no longer called from the main flow.

### 2. `src/interfaces.ts` - Update `PromptTranslator` interface

Add a new method to the interface:

```typescript
export interface PromptTranslator {
  toPromptRequest(sessionId: string, request: MessageCreateParamsBase): PromptRequest;
  toIncrementalPromptRequest(sessionId: string, request: MessageCreateParamsBase): PromptRequest;
  // ... existing methods
}
```

### 3. `src/logic/anthropic-api/translator.ts` - Implement `toIncrementalPromptRequest()`

Add the method to `AnthropicPromptTranslator`:

```typescript
toIncrementalPromptRequest(
  sessionId: string,
  request: Parameters<typeof extractLastUserPrompt>[1],
) {
  return extractLastUserPrompt(sessionId, request);
}
```

### 4. `src/logic/anthropic-api/facade.ts` - Use incremental prompting in `handleInitialPrompt()`

Change line 145 in `handleInitialPrompt()`:

```typescript
// Before:
const promptRequest = this.translator.toPromptRequest(sessionId, body);

// After:
const promptRequest = this.translator.toIncrementalPromptRequest(sessionId, body);
```

This is the only call site that matters. The TurnBuffer continuation path (`handleContinuation()`) doesn't call the translator at all - it serves from the buffer.

## Sequencing

1. **Add `extractLastUserPrompt()` to `src/helpers/messages.ts`** - Pure addition, no existing code changes.
2. **Add `toIncrementalPromptRequest` to the interface and translator** - Wire up the new function.
3. **Switch the facade to use incremental prompting** - One-line change in `handleInitialPrompt()`.
4. **Verify** - Build, check debug logs to confirm only the last user message is sent.

Steps 1-2 can be done together. Step 3 is the behavioral change. Step 4 is validation.
