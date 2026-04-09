# TODO

- [x] Add `extractLastUserPrompt()` function to `src/helpers/messages.ts`
- [x] Add `toIncrementalPromptRequest` method to `PromptTranslator` interface in `src/interfaces.ts`
- [x] Implement `toIncrementalPromptRequest()` in `src/logic/anthropic-api/translator.ts`
- [x] Switch `handleInitialPrompt()` in `src/logic/anthropic-api/facade.ts` to use `toIncrementalPromptRequest()`
- [x] Build and verify no type errors
