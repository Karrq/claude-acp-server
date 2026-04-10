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
import { HttpError, requireAnthropicHeaders } from "../../helpers/errors.js";
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
 * Count assistant messages in an Anthropic request. Used to detect when the
 * client's message history has diverged from the ACP backend's stateful
 * session (e.g. after compaction, handover, or tree navigation).
 */
function countAssistantMessages(body: MessageCreateParamsBase): number {
  return body.messages.filter((m) => m.role === "assistant").length;
}

export class AnthropicAcpFacade implements AnthropicFacade {
  /**
   * Number of assistant turns the ACP backend has produced in the current
   * session. When Pi compacts, hands over, or navigates the conversation tree,
   * it sends fewer assistant messages than this count, which triggers a session
   * reset so the backend starts fresh with the new context.
   */
  private assistantTurnCount = 0;

  constructor(
    private readonly backend: BackendManager,
    private readonly translator: PromptTranslator,
    private readonly config: ServerConfig,
    private readonly logger: Logger = console,
  ) {}

  async handleMessages(
    headers: Headers,
    body: MessageCreateParamsBase & { stream?: boolean },
    signal?: AbortSignal,
    streamObserver?: {
      onReady: (meta: { sessionId: string; requestId: string }) => void | Promise<void>;
      onEvent: (event: RawMessageStreamEvent) => void | Promise<void>;
    },
  ): Promise<FinalizedAnthropicTurn> {
    requireAnthropicHeaders(headers, this.config.anthropicVersion, this.config.apiKey);

    const requestedCwd =
      headers.get(this.config.cwdHeader) ?? inferWorkingDirectoryFromRequest(body) ?? undefined;
    const ensured = await this.backend.ensureSession(undefined, requestedCwd);
    const sessionId = ensured.sessionId;

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

    // Detect session reset: the client sent fewer assistant messages than
    // the backend has produced. This happens after compaction, handover, or
    // tree navigation (fork/rewind). Create a fresh ACP session and send
    // the full message transcript so the backend picks up the new context.
    const incomingAssistantCount = countAssistantMessages(body);
    const isSessionReset = this.assistantTurnCount > 0 && incomingAssistantCount < this.assistantTurnCount;
    debugLog(`handleMessages: assistantTurnCount=${this.assistantTurnCount} incoming=${incomingAssistantCount} isReset=${isSessionReset}`);

    if (isSessionReset) {
      return this.handleSessionReset(sessionId, body, requestedModel, signal, streamObserver);
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

    const enableToolBridge = shouldEnableToolBridge(body);
    const initialUsage = estimateProvisionalStreamUsage({
      request: body,
      hasPriorSession: false,
    });

    // If the client sends prior conversation history on what is effectively
    // the first turn (e.g. after a server restart, handover, or compact),
    // send the full transcript so the new session picks up the context.
    const needsTranscript = this.assistantTurnCount === 0 && countAssistantMessages(body) > 0;
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
    this.assistantTurnCount++;

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
    this.logger.log(
      `[claude-acp-server] session reset detected (had ${this.assistantTurnCount} turns, client sent ${countAssistantMessages(body)}). Creating fresh ACP session.`,
    );
    debugLog(`handleSessionReset: old=${oldSessionId.slice(0, 8)} turns=${this.assistantTurnCount} incoming=${countAssistantMessages(body)}`);

    // Clear state from the old session
    clearTurnBuffer(oldSessionId);
    this.assistantTurnCount = 0;
    this.backend.resetSession();

    // Create a fresh ACP session
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
    this.assistantTurnCount++;

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

    this.assistantTurnCount++;

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
      this.assistantTurnCount++;
      return turn;
    }

    // Non-streaming: batch translate as before
    const turn = this.translateChunk(chunk, sessionId, model, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, null);
    this.assistantTurnCount++;

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
    requireAnthropicHeaders(headers, this.config.anthropicVersion, this.config.apiKey);
    return this.backend.listModels();
  }
}
