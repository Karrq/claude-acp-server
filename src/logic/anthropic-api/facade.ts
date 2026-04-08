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
import { getTurnBuffer, hasTurnBuffer, clearTurnBuffer } from "./turn-buffer.js";
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

export class AnthropicAcpFacade implements AnthropicFacade {
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

    // First request (or continuation with no buffer — shouldn't happen)
    return this.handleInitialPrompt(sessionId, body, requestedModel, signal, streamObserver);
  }

  /**
   * First request in a prompt cycle: run backend.prompt() to completion,
   * buffer all notifications into the TurnBuffer, then return the first chunk.
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

    const promptRequest = this.translator.toPromptRequest(sessionId, body);

    debugLog(`handleInitialPrompt: starting backend.prompt()`);

    // Run the backend prompt to completion, buffering all notifications
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

    // Get the first chunk from the buffer
    const firstChunk = await buffer.waitForNextChunk();
    if (!firstChunk) {
      throw new Error("No chunks produced from backend prompt");
    }

    debugLog(`handleInitialPrompt: first chunk stopReason=${firstChunk.stopReason} notifications=${firstChunk.notifications.length}`);

    // Translate the first chunk into an Anthropic turn
    const turn = this.translateChunk(firstChunk, sessionId, model, initialUsage, response);

    // Stream the SSE events if observer is present
    if (streamObserver) {
      await streamObserver.onReady({ sessionId, requestId: turn.requestId });
      for (const event of turn.streamEvents) {
        await streamObserver.onEvent(event);
      }
    }

    // If this was the only chunk (no tool use), clean up the buffer
    if (firstChunk.stopReason === "end_turn") {
      clearTurnBuffer(sessionId);
    }

    return turn;
  }

  /**
   * Continuation request: the backend already completed its prompt(),
   * so we just serve the next chunk from the TurnBuffer.
   * No duplicate context sent to the backend.
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
    const chunk = await buffer.waitForNextChunk();

    if (!chunk) {
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

    debugLog(`handleContinuation: chunk stopReason=${chunk.stopReason} notifications=${chunk.notifications.length} remaining=${buffer.chunkCount - buffer.consumedChunkCount}`);

    const turn = this.translateChunk(chunk, sessionId, model, {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }, null);

    if (streamObserver) {
      await streamObserver.onReady({ sessionId, requestId: turn.requestId });
      for (const event of turn.streamEvents) {
        await streamObserver.onEvent(event);
      }
    }

    // If this was the final chunk, clean up the buffer
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
