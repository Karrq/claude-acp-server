import { randomUUID } from "node:crypto";
import type {
  AnthropicFacade,
  BackendManager,
  Logger,
  PromptTranslator,
} from "../../interfaces.js";
import type {
  MessageCreateParamsBase,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { HttpError } from "../../helpers/errors.js";
import { ClientRegistry } from "./client-registry.js";
import {
  estimateProvisionalStreamUsage,
  inferWorkingDirectoryFromRequest,
  shouldEnableToolBridge,
} from "../../helpers/messages.js";
import type { FinalizedAnthropicTurn, ServerConfig } from "../../types.js";
import { getTurnBuffer, hasTurnBuffer, clearTurnBuffer, type TurnChunk } from "./turn-buffer.js";
import { appendFileSync } from "node:fs";

const DEBUG_LOG = "/tmp/claude-acp-facade-debug.log";
function debugLog(msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG, `[${ts}] ${msg}\n`);
  } catch {}
}

// Detect if the request is a tool_result continuation
// (last user message contains only tool_result blocks, no user text)
function isToolResultContinuation(body: MessageCreateParamsBase): boolean {
  const messages = body.messages;
  if (!messages?.length) return false;
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.role !== "user") return false;
  const content = Array.isArray(lastMsg.content) ? lastMsg.content : [];
  if (!content.length) return false;
  return content.every((block: any) => block.type === "tool_result");
}

const MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4.6": "sonnet",
  "sonnet-4-6": "sonnet",
  "sonnet-4.6": "sonnet",
  sonnet: "sonnet",
  "claude-opus-4-6": "default",
  "claude-opus-4.6": "default",
  "opus-4-6": "default",
  "opus-4.6": "default",
  opus: "default",
};

/**
 * Build a simplified role sequence from the messages in a request. Each entry
 * is "a" (assistant) or "u" (user). Used to detect structural changes in the
 * conversation history - compaction, tree navigation, fork - by comparing
 * the incoming sequence against what we expect after the last turn.
 */
function buildRoleSequence(body: MessageCreateParamsBase): string[] {
  return body.messages.map((m) => (m.role === "assistant" ? "a" : "u"));
}

/**
 * Per-session conversation tracking state.
 * Keyed by the ACP session ID so multiple concurrent sessions
 * get isolated role sequence tracking.
 */
interface SessionState {
  expectedRoleSequence: string[];
  hasActiveSession: boolean;
}

export class AnthropicAcpFacade implements AnthropicFacade {
  /**
   * Per-session role sequence tracking. The Messages API is stateless, so
   * clients that send full history include the entire conversation each time.
   * After processing a request, we append "a" to predict what the next request
   * should start with.
   *
   * Comparing the full role sequence detects all forms of history restructuring:
   * compaction, tree navigation, and fork.
   *
   * Keyed by ACP session ID so multiple concurrent sessions can share a single
   * server process without corrupting each other's state.
   */
  private sessions = new Map<string, SessionState>();

  private readonly registry: ClientRegistry;

  private getSession(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { expectedRoleSequence: [], hasActiveSession: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * Record the role sequence after a successful response. Appends "a" for our
   * response to predict what the next full-history request should start with.
   */
  private recordTurn(sessionId: string, body: MessageCreateParamsBase): void {
    const session = this.getSession(sessionId);
    session.expectedRoleSequence = [...buildRoleSequence(body), "a"];
    session.hasActiveSession = true;
  }

  /**
   * Extend the expected sequence for a continuation turn (tool_use round-trip).
   * Each continuation adds a user message (tool_result) and an assistant response.
   */
  private recordContinuationTurn(sessionId: string): void {
    const session = this.getSession(sessionId);
    session.expectedRoleSequence.push("u", "a");
    session.hasActiveSession = true;
  }

  constructor(
    private readonly backend: BackendManager,
    private readonly translator: PromptTranslator,
    private readonly config: ServerConfig,
    private readonly logger: Logger = console,
  ) {
    this.registry = new ClientRegistry();
  }

  /**
   * Validate the anthropic-version header.
   */
  private requireVersion(headers: Headers): void {
    const version = headers.get("anthropic-version");
    if (!version) {
      throw new HttpError({
        status: 400,
        type: "invalid_request_error",
        message: "Missing anthropic-version header.",
      });
    }
    if (version !== this.config.anthropicVersion) {
      throw new HttpError({
        status: 400,
        type: "invalid_request_error",
        message: `Unsupported anthropic-version: ${version}. Expected ${this.config.anthropicVersion}.`,
      });
    }
  }

  /**
   * Extract the API key from headers and return the client record.
   * Any key is accepted as a client identity (created on first use).
   */
  private authenticateClient(headers: Headers) {
    const apiKey =
      headers.get("x-api-key") ??
      headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();

    if (!apiKey) {
      throw new HttpError({
        status: 401,
        type: "authentication_error",
        message: "Missing API key. Provide x-api-key or Authorization: Bearer <key>.",
      });
    }
    return this.registry.authenticate(apiKey);
  }

  async handleMessages(
    headers: Headers,
    body: MessageCreateParamsBase & { stream?: boolean },
    signal?: AbortSignal,
    streamObserver?: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    },
  ): Promise<FinalizedAnthropicTurn> {
    this.requireVersion(headers);
    const client = this.authenticateClient(headers);

    const requestedCwd =
      headers.get(this.config.cwdHeader) ?? inferWorkingDirectoryFromRequest(body) ?? undefined;

    // Session resolution: explicit header (scoped by client) -> client's active session -> new
    const requestedSessionId = headers.get(this.config.sessionHeader) || undefined;
    const resolvedSessionId = this.registry.resolveSessionId(client, requestedSessionId);

    const ensured = await this.backend.ensureSession(resolvedSessionId, requestedCwd);
    const sessionId = ensured.sessionId;
    this.registry.recordSession(client, sessionId);
    const session = this.getSession(sessionId);

    if (this.config.permissionMode && ensured.modes?.availableModes?.length) {
      const targetMode = ensured.modes.availableModes.find(
        (m) => m.id === this.config.permissionMode,
      );
      if (targetMode) {
        try {
          await this.backend.setSessionMode(sessionId, targetMode.id);
        } catch (err) {
          this.logger.warn("[claude-acp-server] failed to set permission mode", err);
        }
      }
    }

    const requestedModel = body.model;
    const backendModel = MODEL_ALIASES[requestedModel] ?? requestedModel;

    if (ensured.models?.availableModels?.length) {
      const knownModelIds = new Set(ensured.models.availableModels.map((entry) => entry.modelId));
      if (!knownModelIds.has(backendModel)) {
        throw new HttpError({
          status: 400,
          type: "invalid_request_error",
          message: `Unknown model '${requestedModel}'. Available models: ${Array.from(knownModelIds).join(", ")}`,
        });
      }
    }

    await this.backend.setSessionModel(sessionId, backendModel);

    // Detect continuation: last user message is tool_result only
    const isContinuation = isToolResultContinuation(body);
    debugLog(`handleMessages: isContinuation=${isContinuation} sessionId=${sessionId.slice(0, 8)}`);

    if (isContinuation && hasTurnBuffer(sessionId)) {
      return this.handleContinuation(sessionId, requestedModel, streamObserver);
    }

    // Detect session reset by comparing the incoming role sequence against
    // what we predicted. Only checked when the request contains assistant
    // messages (full history). Clients that send only the latest message
    // (like tests) skip this check.
    const incomingRoles = buildRoleSequence(body);
    const hasHistory = incomingRoles.includes("a");
    let isSessionReset = false;
    if (hasHistory && session.hasActiveSession) {
      const expected = session.expectedRoleSequence;
      // The incoming sequence must start with our predicted prefix.
      const prefixMatches =
        expected.length <= incomingRoles.length &&
        expected.every((role, i) => incomingRoles[i] === role);
      // Extra trailing user messages are fine (queued messages, followups).
      // But extra assistant messages mean history the backend doesn't know
      // about - that requires a transcript to bring the backend up to date.
      const extraRoles = incomingRoles.slice(expected.length);
      const hasUnknownAssistantHistory = extraRoles.includes("a");
      isSessionReset = !prefixMatches || hasUnknownAssistantHistory;
    }
    debugLog(`handleMessages: active=${session.hasActiveSession} hasHistory=${hasHistory} expected=[${session.expectedRoleSequence.join(",")}] incoming=[${incomingRoles.join(",")}] isReset=${isSessionReset}`);

    if (isSessionReset) {
      const turn = await this.handleSessionReset(sessionId, body, requestedModel, signal, streamObserver);
      // Update client mapping to point to the new session created by the reset
      this.registry.recordSession(client, turn.sessionId);
      return turn;
    }

    // Normal path: incremental prompt
    return this.handleInitialPrompt(sessionId, body, requestedModel, signal, streamObserver);
  }

  /**
   * First request in a prompt cycle. If a streamObserver is provided,
   * SSE events are forwarded in real-time as notifications arrive from the backend.
   * Otherwise, the prompt runs to completion and the result is returned as a batch.
   */
  private async handleInitialPrompt(
    sessionId: string,
    body: MessageCreateParamsBase,
    model: string,
    signal: AbortSignal | undefined,
    streamObserver: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    } | undefined,
  ): Promise<FinalizedAnthropicTurn> {
    // Clear any stale buffer from a previous prompt cycle
    clearTurnBuffer(sessionId);
    const buffer = getTurnBuffer(sessionId);
    const session = this.getSession(sessionId);

    const enableToolBridge = shouldEnableToolBridge(body);
    const initialUsage = estimateProvisionalStreamUsage({
      request: body,
      hasPriorSession: false,
    });

    // If the client sends prior conversation history on what is effectively
    // the first turn (e.g. after a server restart, handover, or compact),
    // send the full transcript so the new session picks up the context.
    const incomingRoles = buildRoleSequence(body);
    const needsTranscript = !session.hasActiveSession && incomingRoles.includes("a");
    const promptRequest = needsTranscript
      ? this.translator.toPromptRequest(sessionId, body)
      : this.translator.toIncrementalPromptRequest(sessionId, body);

    debugLog(`handleInitialPrompt: starting backend.prompt() streaming=${!!streamObserver} needsTranscript=${needsTranscript}`);

    if (streamObserver) {
      return this.streamInitialPrompt(sessionId, body, model, signal, streamObserver, buffer, initialUsage, promptRequest);
    }

    // Non-streaming path: run to completion, batch translate
    const response = await this.backend.prompt({
      sessionId,
      request: promptRequest,
      signal,
      onNotification: (notification) => {
        buffer.pushNotification(notification);
      },
    });

    buffer.finalize(response);
    debugLog(`handleInitialPrompt: prompt complete, chunks=${buffer.chunkCount}`);

    const firstChunk = await buffer.waitForNextChunk();
    if (!firstChunk) {
      throw new Error("No chunks produced from backend prompt");
    }

    const turn = this.translateChunk(firstChunk, sessionId, model, initialUsage, response);
    this.recordTurn(sessionId, body);

    if (firstChunk.stopReason === "end_turn") {
      clearTurnBuffer(sessionId);
    }

    return turn;
  }

  /**
   * Handle a session reset caused by compaction, handover, or tree navigation.
   * Creates a fresh ACP session, then sends the full message transcript via
   * toPromptRequest so the backend picks up the new context.
   */
  private async handleSessionReset(
    oldSessionId: string,
    body: MessageCreateParamsBase,
    model: string,
    signal: AbortSignal | undefined,
    streamObserver: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    } | undefined,
  ): Promise<FinalizedAnthropicTurn> {
    const oldSession = this.getSession(oldSessionId);
    const incomingRoles = buildRoleSequence(body);
    this.logger.log(
      `[claude-acp-server] session reset detected (expected [${oldSession.expectedRoleSequence.join(",")}], got [${incomingRoles.join(",")}]). Creating fresh ACP session.`,
    );
    debugLog(`handleSessionReset: old=${oldSessionId.slice(0, 8)} expected=[${oldSession.expectedRoleSequence.join(",")}] incoming=[${incomingRoles.join(",")}]`);

    // Clear state from the old session
    clearTurnBuffer(oldSessionId);
    this.sessions.delete(oldSessionId);
    this.backend.resetSession(oldSessionId);

    // Create a fresh ACP session (no session ID = force new)
    const requestedCwd = inferWorkingDirectoryFromRequest(body) ?? undefined;
    const ensured = await this.backend.ensureSession(undefined, requestedCwd);
    const sessionId = ensured.sessionId;
    debugLog(`handleSessionReset: new session=${sessionId.slice(0, 8)}`);

    // Re-apply permission mode and model on the new session
    if (this.config.permissionMode && ensured.modes?.availableModes?.length) {
      const targetMode = ensured.modes.availableModes.find(
        (m) => m.id === this.config.permissionMode,
      );
      if (targetMode) {
        try {
          await this.backend.setSessionMode(sessionId, targetMode.id);
        } catch (err) {
          this.logger.warn("[claude-acp-server] failed to set permission mode on reset session", err);
        }
      }
    }

    const backendModel = MODEL_ALIASES[model] ?? model;
    if (ensured.models?.availableModels?.length) {
      const knownModelIds = new Set(ensured.models.availableModels.map((e) => e.modelId));
      if (knownModelIds.has(backendModel)) {
        await this.backend.setSessionModel(sessionId, backendModel);
      }
    }

    // Use the full message translator instead of incremental - this sends the
    // entire conversation transcript as context for the new session
    const buffer = getTurnBuffer(sessionId);
    const initialUsage = estimateProvisionalStreamUsage({
      request: body,
      hasPriorSession: false,
    });
    const promptRequest = this.translator.toPromptRequest(sessionId, body);

    debugLog(`handleSessionReset: sending full transcript prompt, messages=${body.messages.length}`);

    if (streamObserver) {
      return this.streamInitialPrompt(sessionId, body, model, signal, streamObserver, buffer, initialUsage, promptRequest);
    }

    // Non-streaming path
    const response = await this.backend.prompt({
      sessionId,
      request: promptRequest,
      signal,
      onNotification: (notification) => {
        buffer.pushNotification(notification);
      },
    });

    buffer.finalize(response);
    const firstChunk = await buffer.waitForNextChunk();
    if (!firstChunk) {
      throw new Error("No chunks produced from backend prompt");
    }

    const turn = this.translateChunk(firstChunk, sessionId, model, initialUsage, response);
    this.recordTurn(sessionId, body);

    if (firstChunk.stopReason === "end_turn") {
      clearTurnBuffer(sessionId);
    }

    return turn;
  }

  /**
   * Streaming path for the initial prompt. Starts the backend prompt in the background,
   * streams SSE events to the client as notifications arrive, and resolves when the
   * first chunk boundary is hit (tool_use) or the prompt completes (end_turn).
   */
  private async streamInitialPrompt(
    sessionId: string,
    body: MessageCreateParamsBase,
    model: string,
    signal: AbortSignal | undefined,
    streamObserver: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    },
    buffer: ReturnType<typeof getTurnBuffer>,
    initialUsage: { input_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null },
    promptRequest: ReturnType<PromptTranslator["toIncrementalPromptRequest"]>,
  ): Promise<FinalizedAnthropicTurn> {
    const requestId = randomUUID();

    const collector = this.translator.createStreamCollector({
      requestId,
      sessionId,
      model,
      enableToolBridge: shouldEnableToolBridge(body),
      includeProgressThinking: true,
      initialUsage,
    });

    // Emit message_start and open the SSE stream
    await streamObserver.onReady({ sessionId, requestId });
    await streamObserver.onEvent(collector.start());

    // Track how many events we've sent so we can send only the finish events later
    let eventsSent = 1; // message_start

    // Promise that resolves when the first chunk boundary is reached or prompt finishes
    let resolveChunkDone!: (result: { stopReason: "tool_use" | "end_turn"; response: PromptResponse | null }) => void;
    let rejectChunkDone!: (err: unknown) => void;
    const chunkDone = new Promise<{ stopReason: "tool_use" | "end_turn"; response: PromptResponse | null }>((resolve, reject) => {
      resolveChunkDone = resolve;
      rejectChunkDone = reject;
    });

    let chunkBoundaryHit = false;
    let finalResponse: PromptResponse | null = null;

    buffer.setStreamCallbacks({
      onNotification: (notification) => {
        if (chunkBoundaryHit) return;
        const events = collector.pushNotification(notification);
        for (const event of events) {
          eventsSent++;
          void streamObserver.onEvent(event);
        }
      },
      onChunkBoundary: (stopReason) => {
        if (chunkBoundaryHit) return;
        chunkBoundaryHit = true;
        debugLog(`streamInitialPrompt: chunk boundary stopReason=${stopReason}`);
        resolveChunkDone({ stopReason, response: finalResponse });
      },
      onFinalize: (response) => {
        finalResponse = response;
        debugLog(`streamInitialPrompt: finalize received`);
      },
    });

    // Start the backend prompt in the background
    const promptPromise = this.backend.prompt({
      sessionId,
      request: promptRequest,
      signal,
      onNotification: (notification) => {
        buffer.pushNotification(notification);
      },
    });

    // Finalize the buffer when the prompt completes or propagate errors
    promptPromise.then(
      (response) => {
        buffer.finalize(response);
      },
      (err) => {
        debugLog(`streamInitialPrompt: prompt error: ${err}`);
        buffer.clearStreamCallbacks();
        if (!chunkBoundaryHit) {
          rejectChunkDone(err);
        }
      },
    );

    // Wait for the first chunk boundary or prompt completion
    const { stopReason, response } = await chunkDone;
    buffer.clearStreamCallbacks();
    // Mark this chunk as consumed so continuations don't replay it
    buffer.skipCurrentChunk();

    // Finalize the collector. For tool_use chunks we need stop_reason=tool_use
    // but the collector's finish() derives stop_reason from tool_use blocks it has seen.
    const finishResponse: PromptResponse = response ?? {
      stopReason: "end_turn" as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const turn = collector.finish(finishResponse);

    // Send only the events added by finish() (closing blocks, message_delta, message_stop)
    const allEvents = turn.streamEvents;
    for (let i = eventsSent; i < allEvents.length; i++) {
      await streamObserver.onEvent(allEvents[i]);
    }

    this.recordTurn(sessionId, body);

    if (stopReason === "end_turn") {
      clearTurnBuffer(sessionId);
    }

    return turn;
  }

  /**
   * Continuation request: the backend already completed its prompt(),
   * so we serve the next chunk from the TurnBuffer.
   * If streaming, events are sent incrementally through the collector.
   */
  private async handleContinuation(
    sessionId: string,
    model: string,
    streamObserver: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    } | undefined,
  ): Promise<FinalizedAnthropicTurn> {
    const buffer = getTurnBuffer(sessionId);

    // If the next chunk is already buffered, we can check immediately
    if (!buffer.hasNextChunk && buffer.isComplete) {
      debugLog(`handleContinuation: no more chunks, returning empty end_turn`);
      const emptyTurn = this.createEmptyTurn(sessionId, model);
      if (streamObserver) {
        await streamObserver.onReady({ sessionId, requestId: emptyTurn.requestId });
        for (const event of emptyTurn.streamEvents) {
          await streamObserver.onEvent(event);
        }
      }
      clearTurnBuffer(sessionId);
      return emptyTurn;
    }

    // Wait for the next chunk (may already be buffered, or still in-flight)
    const chunk = await buffer.waitForNextChunk();

    if (!chunk) {
      debugLog(`handleContinuation: waitForNextChunk returned null`);
      const emptyTurn = this.createEmptyTurn(sessionId, model);
      if (streamObserver) {
        await streamObserver.onReady({ sessionId, requestId: emptyTurn.requestId });
        for (const event of emptyTurn.streamEvents) {
          await streamObserver.onEvent(event);
        }
      }
      clearTurnBuffer(sessionId);
      return emptyTurn;
    }

    debugLog(`handleContinuation: chunk stopReason=${chunk.stopReason} notifications=${chunk.notifications.length} remaining=${buffer.chunkCount - buffer.consumedChunkCount}`);

    // Stream the chunk's notifications through a collector for incremental SSE delivery
    if (streamObserver) {
      const turn = await this.streamChunk(chunk, sessionId, model, streamObserver);
      this.recordContinuationTurn(sessionId);
      return turn;
    }

    // Non-streaming: batch translate as before
    const turn = this.translateChunk(chunk, sessionId, model, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, null);
    this.recordContinuationTurn(sessionId);

    if (chunk.stopReason === "end_turn") {
      clearTurnBuffer(sessionId);
    }

    return turn;
  }

  /**
   * Stream an already-buffered chunk's notifications through a collector,
   * sending SSE events incrementally to the client.
   */
  private async streamChunk(
    chunk: TurnChunk,
    sessionId: string,
    model: string,
    streamObserver: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    },
  ): Promise<FinalizedAnthropicTurn> {
    const requestId = randomUUID();
    const collector = this.translator.createStreamCollector({
      requestId,
      sessionId,
      model,
      enableToolBridge: false,
      includeProgressThinking: true,
      initialUsage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    await streamObserver.onReady({ sessionId, requestId });
    await streamObserver.onEvent(collector.start());
    let eventsSent = 1;

    // Replay buffered notifications through the collector, streaming each event
    for (const notification of chunk.notifications) {
      const events = collector.pushNotification(notification);
      for (const event of events) {
        eventsSent++;
        await streamObserver.onEvent(event);
      }
    }

    // Finalize to get closing events
    const response: PromptResponse = {
      stopReason: "end_turn" as const,
      usage: chunk.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const turn = collector.finish(response);

    // Send only the finish events
    const allEvents = turn.streamEvents;
    for (let i = eventsSent; i < allEvents.length; i++) {
      await streamObserver.onEvent(allEvents[i]);
    }

    if (chunk.stopReason === "end_turn") {
      clearTurnBuffer(sessionId);
    }

    return turn;
  }

  /**
   * Translate a TurnBuffer chunk into a FinalizedAnthropicTurn.
   * Each chunk gets its own collector (via fromPromptResult),
   * producing a complete Anthropic message with proper stop_reason.
   */
  private translateChunk(
    chunk: {
      notifications: import("@agentclientprotocol/sdk").SessionNotification[];
      stopReason: string;
      usage: PromptResponse["usage"] | null;
    },
    sessionId: string,
    model: string,
    initialUsage: { input_tokens: number; cache_creation_input_tokens: number | null; cache_read_input_tokens: number | null },
    fullResponse: PromptResponse | null,
  ): FinalizedAnthropicTurn {
    // For the final chunk, use the real response (has real usage and stopReason)
    // For intermediate chunks, use a synthetic response (stopReason gets overridden by translator)
    const isLast = chunk.stopReason === "end_turn";
    const response: PromptResponse = isLast && fullResponse
      ? fullResponse
      : {
          stopReason: "end_turn" as const,
          usage: chunk.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };

    return this.translator.fromPromptResult({
      requestId: randomUUID(),
      sessionId,
      model,
      enableToolBridge: false,
      includeProgressThinking: true,
      initialUsage,
      response,
      notifications: chunk.notifications,
    });
  }

  /**
   * Create an empty end_turn response for edge cases.
   */
  private createEmptyTurn(sessionId: string, model: string): FinalizedAnthropicTurn {
    const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
    const requestId = randomUUID();
    const message: any = {
      id: messageId,
      type: "message",
      container: null,
      role: "assistant",
      content: [{ type: "text", text: "", citations: null }],
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: null,
        inference_geo: null,
        server_tool_use: null,
        service_tier: null,
      },
    };
    const streamEvents: RawMessageStreamEvent[] = [
      { type: "message_start", message },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
          stop_details: null,
          container: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
        },
      },
      { type: "message_stop" },
    ];
    return { requestId, sessionId, streamEvents, message };
  }

  async listModels(headers: Headers) {
    this.requireVersion(headers);
    this.authenticateClient(headers);
    return this.backend.listModels();
  }
}
