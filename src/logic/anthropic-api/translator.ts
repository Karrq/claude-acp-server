import { randomUUID } from "node:crypto";
import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type {
  Message,
  RawMessageStreamEvent,
  TextBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { PromptTranslator } from "../../interfaces.js";
import { anthropicRequestToPromptRequest } from "../../helpers/messages.js";
import type { FinalizedAnthropicTurn } from "../../types.js";

function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

function mapStopReason(stopReason: PromptResponse["stopReason"]): Message["stop_reason"] {
  switch (stopReason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "cancelled":
    case "max_turn_requests":
    default:
      return "end_turn";
  }
}

class AnthropicStreamCollector {
  private readonly usage: Message["usage"] = {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 0,
    output_tokens: 0,
    server_tool_use: null,
    service_tier: null,
  };
  private readonly content: Message["content"] = [];
  private readonly streamEvents: RawMessageStreamEvent[] = [];
  private readonly messageId = newMessageId();
  private activeTextBlockIndex: number | null = null;

  constructor(
    private readonly requestId: string,
    private readonly sessionId: string,
    private readonly model: string,
  ) {}

  start(): RawMessageStreamEvent {
    const event: RawMessageStreamEvent = {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        container: null,
        role: "assistant",
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { ...this.usage },
      },
    };
    this.streamEvents.push(event);
    return event;
  }

  pushNotification(notification: SessionNotification): RawMessageStreamEvent[] {
    const emitted: RawMessageStreamEvent[] = [];
    const update = notification.update;

    if (update.sessionUpdate !== "agent_message_chunk") {
      return emitted;
    }

    if (update.content.type === "text") {
      if (this.activeTextBlockIndex === null) {
        this.activeTextBlockIndex = this.content.length;
        this.content.push({
          type: "text",
          text: "",
          citations: null,
        } as TextBlock);

        emitted.push({
          type: "content_block_start",
          index: this.activeTextBlockIndex,
          content_block: {
            type: "text",
            text: "",
            citations: null,
          },
        });
      }

      const block = this.content[this.activeTextBlockIndex];
      if (block.type === "text") {
        block.text += update.content.text;
      }

      emitted.push({
        type: "content_block_delta",
        index: this.activeTextBlockIndex,
        delta: {
          type: "text_delta",
          text: update.content.text,
        },
      });
    }

    this.streamEvents.push(...emitted);
    return emitted;
  }

  finish(response: PromptResponse): FinalizedAnthropicTurn {
    this.usage.cache_creation_input_tokens = response.usage?.cachedWriteTokens ?? null;
    this.usage.cache_read_input_tokens = response.usage?.cachedReadTokens ?? null;
    this.usage.input_tokens = response.usage?.inputTokens ?? 0;
    this.usage.output_tokens = response.usage?.outputTokens ?? 0;

    if (this.activeTextBlockIndex !== null) {
      this.streamEvents.push({
        type: "content_block_stop",
        index: this.activeTextBlockIndex,
      });
      this.activeTextBlockIndex = null;
    }

    const stopReason = mapStopReason(response.stopReason);
    this.streamEvents.push({
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
        stop_details: null,
        container: null,
      },
      usage: {
        cache_creation_input_tokens: this.usage.cache_creation_input_tokens,
        cache_read_input_tokens: this.usage.cache_read_input_tokens,
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        server_tool_use: null,
      },
    });
    this.streamEvents.push({ type: "message_stop" });

    const message: Message = {
      id: this.messageId,
      type: "message",
      container: null,
      role: "assistant",
      content: this.content,
      model: this.model,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: null,
      usage: { ...this.usage },
    };

    return {
      requestId: this.requestId,
      sessionId: this.sessionId,
      streamEvents: [...this.streamEvents],
      message,
    };
  }
}

export class AnthropicPromptTranslator implements PromptTranslator {
  toPromptRequest(
    sessionId: string,
    request: Parameters<typeof anthropicRequestToPromptRequest>[1],
  ) {
    return anthropicRequestToPromptRequest(sessionId, request);
  }

  createStreamCollector(args: { requestId: string; sessionId: string; model: string }) {
    return new AnthropicStreamCollector(args.requestId, args.sessionId, args.model);
  }

  fromPromptResult(args: {
    requestId: string;
    sessionId: string;
    model: string;
    response: PromptResponse;
    notifications: SessionNotification[];
  }) {
    const collector = this.createStreamCollector({
      requestId: args.requestId,
      sessionId: args.sessionId,
      model: args.model,
    });
    collector.start();
    for (const notification of args.notifications) {
      collector.pushNotification(notification);
    }
    return collector.finish(args.response);
  }
}
