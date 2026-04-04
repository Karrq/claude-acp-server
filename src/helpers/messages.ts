import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk";
import type {
  ContentBlockParam,
  MessageCreateParamsBase,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { HttpError } from "./errors.js";

function normalizeMessageContent(content: MessageParam["content"]): ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

function renderContentBlockForTranscript(block: ContentBlockParam): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image:${block.source.type === "url" ? block.source.url : block.source.media_type}]`;
    case "tool_result":
      return `[tool_result:${block.tool_use_id}]`;
    case "document":
      return "[document]";
    default:
      return `[${block.type}]`;
  }
}

function messageToTranscriptLine(message: MessageParam): string {
  const rendered = normalizeMessageContent(message.content)
    .map((block) => renderContentBlockForTranscript(block))
    .join("\n");

  return `${message.role.toUpperCase()}:\n${rendered}`.trim();
}

function contentBlockToAcp(block: ContentBlockParam): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "image":
      if (block.source.type === "base64") {
        return [
          {
            type: "image",
            data: block.source.data,
            mimeType: block.source.media_type,
          },
        ];
      }

      return [
        {
          type: "text",
          text: `[image:${block.source.url}]`,
        },
      ];
    case "document":
      if (block.source.type === "text") {
        return [
          {
            type: "resource",
            resource: {
              uri:
                block.source.media_type === "text/plain"
                  ? "anthropic://document.txt"
                  : "anthropic://document",
              text: block.source.data,
            },
          },
        ];
      }

      return [{ type: "text", text: "[document omitted]" }];
    case "tool_result":
      return [
        {
          type: "text",
          text: `[tool_result:${block.tool_use_id}] ${typeof block.content === "string" ? block.content : JSON.stringify(block.content)}`,
        },
      ];
    default:
      return [{ type: "text", text: renderContentBlockForTranscript(block) }];
  }
}

export function anthropicRequestToPromptRequest(
  sessionId: string,
  request: MessageCreateParamsBase,
): PromptRequest {
  if (!request.messages.length) {
    throw new HttpError({
      status: 400,
      type: "invalid_request_error",
      message: "messages must contain at least one entry.",
    });
  }

  const finalMessage = request.messages[request.messages.length - 1];
  if (finalMessage.role !== "user") {
    throw new HttpError({
      status: 400,
      type: "invalid_request_error",
      message: "The final message must have role=user when using ACP session continuity.",
    });
  }

  if (
    Array.isArray((request as { tools?: unknown[] }).tools) &&
    (request as { tools?: unknown[] }).tools!.length
  ) {
    throw new HttpError({
      status: 400,
      type: "invalid_request_error",
      message: "Client-defined Anthropic tools are not supported by this facade.",
    });
  }

  const prompt: ContentBlock[] = [];
  const contextLines: string[] = [];

  if (typeof request.system === "string" && request.system.trim()) {
    contextLines.push(`SYSTEM:\n${request.system.trim()}`);
  } else if (Array.isArray(request.system) && request.system.length) {
    const rendered = request.system
      .map((block) => ("text" in block ? block.text : "[system block]"))
      .join("\n");
    contextLines.push(`SYSTEM:\n${rendered}`);
  }

  for (const message of request.messages.slice(0, -1)) {
    contextLines.push(messageToTranscriptLine(message));
  }

  if (contextLines.length) {
    prompt.push({
      type: "text",
      text:
        "Conversation context for this ACP session bootstrap:\n\n" +
        `${contextLines.join("\n\n")}\n\n` +
        "Use the transcript as prior context. The next blocks are the current user turn.",
    });
  }

  for (const block of normalizeMessageContent(finalMessage.content)) {
    prompt.push(...contentBlockToAcp(block));
  }

  return {
    sessionId,
    prompt,
  };
}
