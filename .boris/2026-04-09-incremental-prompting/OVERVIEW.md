# Incremental Prompting

**Status:** completed

**Original request:** The ACP server calls `backend.prompt()` with the full replayed conversation on every user turn. Since the backend session is stateful (resumed via `unstable_resumeSession`), each new user message should only send the new message as a prompt - the backend already has the prior context. This wastes tokens and isn't cache-efficient.

**Task scope:** Change the facade so that follow-up user turns send only the new user message to `backend.prompt()` instead of replaying the full conversation. Leverage the ACP backend's session state so the server acts as a thin relay for new turns, not a stateless adapter that replays history.

## What was built

Replaced the transcript-based prompt building with direct extraction of the last user message. Every turn now sends only the new user message's content blocks to `backend.prompt()`, regardless of whether it's the first or a follow-up turn. The backend session (resumed via `unstable_resumeSession`) retains all prior context.

## Key decisions made

- **Always incremental, no special first-turn case.** System prompt is passed via `_meta` on session creation (`CLAUDE_ACP_OPTIONS`), tool context is handled by the backend's configured tool set. No transcript is ever needed.
- **Tool results from Pi are discarded.** The TurnBuffer continuation path already handles this - Pi's echoed tool_results are served from the buffer, not re-sent to the backend.
- **No `hasPrompted` flag.** The logic is stateless with respect to turn history - "extract last user message" works identically on every turn.
- **Deferred: Pi going back in time (dropped messages).** If Pi replays a shorter history, the backend session and Pi's view diverge. Handling this requires detecting the mismatch and forking/resetting the backend session - a separate, harder problem.

## Key files changed

- `src/helpers/messages.ts` - Added `extractLastUserPrompt()` function
- `src/interfaces.ts` - Added `toIncrementalPromptRequest` to `PromptTranslator` interface
- `src/logic/anthropic-api/translator.ts` - Implemented `toIncrementalPromptRequest()`
- `src/logic/anthropic-api/facade.ts` - Switched `handleInitialPrompt()` to use `toIncrementalPromptRequest()`

## Known limitations or deferred work

- `anthropicRequestToPromptRequest()` and its transcript-building helpers in `src/helpers/messages.ts` are now dead code in the main flow. Can be removed in a cleanup pass.
- No detection of Pi replaying a shorter/edited history (the "time travel" problem). If this happens, the backend session and Pi's view silently diverge.
- `ensureSession()` is still called on every request including TurnBuffer continuations - unnecessary round-trips.
