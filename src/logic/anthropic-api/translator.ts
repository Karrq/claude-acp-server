import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type {
  Message,
  RawMessageStreamEvent,
  ThinkingBlock,
  TextBlock,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { PromptTranslator } from "../../interfaces.js";
import {
  TOOL_USE_BRIDGE_END,
  TOOL_USE_BRIDGE_START,
  anthropicRequestToPromptRequest,
  extractLastUserPrompt,
  type ProvisionalStreamUsage,
  parseBridgedToolUse,
  toAnthropicToolUseBlock,
} from "../../helpers/messages.js";
import type { FinalizedAnthropicTurn } from "../../types.js";

function debug(msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync("/tmp/claude-acp-translator-debug.log", `[${ts}] ${msg}\n`);
  } catch {}
}

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
  private readonly usage: Message["usage"];
  private readonly content: Message["content"] = [];
  private readonly streamEvents: RawMessageStreamEvent[] = [];
  private readonly messageId = newMessageId();
  private readonly toolUseId = `toolu_${randomUUID().replace(/-/g, "")}`;
  private activeTextBlockIndex: number | null = null;
  private activeThinkingBlockIndex: number | null = null;
  private bridgedToolUse: ReturnType<typeof parseBridgedToolUse> = null;
  private pendingText = "";
  private pendingBridge = "";
  private readonly toolCallTitles = new Map<string, string>();
  // Track ACP tool uses so we can emit proper tool_use/tool_result blocks
  private readonly acpToolUses: Map<string, {
    toolName: string;
    rawInput: Record<string, unknown>;
    rawOutput?: unknown;
    status: string;
    kind?: string;
    title?: string;
    content?: Array<{ type: string; [key: string]: unknown }>;
    blockIndex: number;
    inputEmitted: boolean; // whether we've already sent the full input_json_delta
  }> = new Map();

  // Write tool results to a cache directory so Pi extension can read them
  private cacheToolResult(toolCallId: string, result: string, isError: boolean = false, details?: Record<string, unknown>): void {
    try {
      const dir = join("/tmp", "claude-acp-tool-results");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${toolCallId}.json`), JSON.stringify({ text: result, is_error: isError, details: details || {} }));
    } catch {}
  }

  constructor(
    private readonly requestId: string,
    private readonly sessionId: string,
    private readonly model: string,
    private readonly enableToolBridge: boolean,
    private readonly includeProgressThinking: boolean,
    initialUsage: ProvisionalStreamUsage,
  ) {
    this.usage = {
      cache_creation: null,
      cache_creation_input_tokens: initialUsage.cache_creation_input_tokens,
      cache_read_input_tokens: initialUsage.cache_read_input_tokens,
      inference_geo: null,
      input_tokens: initialUsage.input_tokens,
      output_tokens: 0,
      server_tool_use: null,
      service_tier: null,
    };
  }

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

  private ensureTextBlockStarted(emitted: RawMessageStreamEvent[]) {
    if (this.activeTextBlockIndex !== null) {
      return;
    }

    this.closeThinkingBlock(emitted);

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

  private emitTextDelta(text: string, emitted: RawMessageStreamEvent[]) {
    if (!text.length) {
      return;
    }

    this.ensureTextBlockStarted(emitted);

    const block = this.content[this.activeTextBlockIndex!];
    if (block.type === "text") {
      block.text += text;
    }

    emitted.push({
      type: "content_block_delta",
      index: this.activeTextBlockIndex!,
      delta: {
        type: "text_delta",
        text,
      },
    });
  }

  private ensureThinkingBlockStarted(emitted: RawMessageStreamEvent[]) {
    if (this.activeThinkingBlockIndex !== null || !this.includeProgressThinking) {
      return;
    }

    this.activeThinkingBlockIndex = this.content.length;
    this.content.push({
      type: "thinking",
      thinking: "",
      signature: "",
    } as ThinkingBlock);

    emitted.push({
      type: "content_block_start",
      index: this.activeThinkingBlockIndex,
      content_block: {
        type: "thinking",
        thinking: "",
        signature: "",
      },
    });
  }

  private emitThinkingDelta(text: string, emitted: RawMessageStreamEvent[]) {
    if (!this.includeProgressThinking || !text.length) {
      return;
    }

    this.ensureThinkingBlockStarted(emitted);
    const block = this.content[this.activeThinkingBlockIndex!];
    if (block.type === "thinking") {
      block.thinking += text;
    }

    emitted.push({
      type: "content_block_delta",
      index: this.activeThinkingBlockIndex!,
      delta: {
        type: "thinking_delta",
        thinking: text,
      },
    });
  }

  private closeThinkingBlock(emitted: RawMessageStreamEvent[]) {
    if (this.activeThinkingBlockIndex === null) {
      return;
    }

    emitted.push({
      type: "content_block_stop",
      index: this.activeThinkingBlockIndex,
    });
    this.activeThinkingBlockIndex = null;
  }

  private closeTextBlock(emitted: RawMessageStreamEvent[]) {
    if (this.activeTextBlockIndex === null) {
      return;
    }

    emitted.push({
      type: "content_block_stop",
      index: this.activeTextBlockIndex,
    });
    this.activeTextBlockIndex = null;
  }

  private summarizeToolPayload(value: unknown): string {
    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value === "string") {
      const normalized = value.trim().replace(/\s+/g, " ");
      if (!normalized.length) {
        return "";
      }
      return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
    }

    try {
      const serialized = JSON.stringify(value);
      if (serialized === "{}" || serialized === "[]") {
        return "";
      }
      return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
    } catch {
      return String(value);
    }
  }

  private summarizeToolLocations(
    locations:
      | Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }>["locations"]
      | Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>["locations"],
  ): string {
    if (!Array.isArray(locations) || !locations.length) {
      return "";
    }

    const paths = locations
      .map((location) => location.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .slice(0, 2);

    return paths.join(", ");
  }

  private formatToolCallStart(
    update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }>,
  ): string {
    const title = update.title?.trim() || "Tool";
    this.toolCallTitles.set(update.toolCallId, title);
    const detail =
      this.summarizeToolPayload(update.rawInput) || this.summarizeToolLocations(update.locations);
    return detail ? `\nUsing ${title}: ${detail}\n` : `\nUsing ${title}\n`;
  }

  private emitToolUseBlock(
    update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }>,
    emitted: RawMessageStreamEvent[],
  ) {
    this.closeThinkingBlock(emitted);
    this.closeTextBlock(emitted);

    const toolCallId = update.toolCallId;
    const toolName = (update as any)._meta?.claudeCode?.toolName || update.title || "Tool";
    const rawInput: Record<string, unknown> = (update.rawInput as Record<string, unknown>) || {};

    const hasInput = rawInput && Object.keys(rawInput).length > 0;
    const blockIndex = this.content.length;

    this.acpToolUses.set(toolCallId, {
      toolName,
      rawInput,
      status: update.status || "pending",
      kind: update.kind,
      title: update.title,
      blockIndex,
      inputEmitted: hasInput, // if rawInput was non-empty, we emit it now
    });

    const inputJson = JSON.stringify(rawInput);

    debug(`emitToolUseBlock: id=${toolCallId} name=${toolName} inputJson=${inputJson.slice(0, 200)} hasInput=${hasInput}`);

    this.content.push({
      type: "tool_use",
      id: toolCallId,
      name: toolName,
      input: rawInput,
      caller: { type: "direct" },
    } as ToolUseBlock);

    emitted.push({
      type: "content_block_start",
      index: blockIndex,
      content_block: {
        type: "tool_use",
        id: toolCallId,
        name: toolName,
        input: {},
        caller: { type: "direct" },
      },
    });

    // Emit input_json_delta + content_block_stop if we have input now;
    // otherwise defer to tool_call_update (which will emit input_json_delta + stop)
    if (hasInput) {
      emitted.push({
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: inputJson,
        },
      });
      emitted.push({
        type: "content_block_stop",
        index: blockIndex,
      });
    }
    // If no input yet, content_block_stop is deferred — see cacheToolResultFromUpdate
  }

  private cacheToolResultFromUpdate(
    update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>,
  ): void {
    const toolUse = this.acpToolUses.get(update.toolCallId);
    const emitted: RawMessageStreamEvent[] = [];

    if (toolUse) {
      if (update.status) toolUse.status = update.status;
      if (update.rawOutput !== undefined) toolUse.rawOutput = update.rawOutput;

      // If the tool_call came with empty input but tool_call_update has rawInput,
      // emit an input_json_delta + content_block_stop now so Pi gets the actual arguments
      const updateRawInput = (update as any).rawInput as Record<string, unknown> | undefined;
      if (updateRawInput && Object.keys(updateRawInput).length > 0 && !toolUse.inputEmitted) {
        toolUse.rawInput = updateRawInput;
        toolUse.inputEmitted = true;
        const inputJson = JSON.stringify(updateRawInput);
        debug(`cacheToolResultFromUpdate: emitting deferred input_json_delta for id=${update.toolCallId} inputJson=${inputJson.slice(0, 200)}`);
        emitted.push({
          type: "content_block_delta",
          index: toolUse.blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: inputJson,
          },
        });
        // Now close the block
        emitted.push({
          type: "content_block_stop",
          index: toolUse.blockIndex,
        });
        // Also update the content block in-place
        const contentBlock = this.content[toolUse.blockIndex];
        if (contentBlock && (contentBlock as any).type === "tool_use") {
          (contentBlock as any).input = updateRawInput;
        }
        this.streamEvents.push(...emitted);
      }

      // Save diff content from intermediate updates for when completed fires
      const updateContent = (update as any).content;
      if (Array.isArray(updateContent)) {
        for (const item of updateContent) {
          if (item.type === "diff" && (item.oldText || item.newText)) {
            if (!toolUse.content) toolUse.content = [];
            // Avoid duplicates
            if (!toolUse.content.some((c: any) => c.type === "diff" && c.path === item.path && c.oldText === item.oldText)) {
              toolUse.content.push(item);
            }
          }
        }
      }
    }

    if (update.status === "completed") {
      const { output, details } = this.extractToolOutputWithDetails(update, toolUse);
      this.cacheToolResult(update.toolCallId, output || "", false, details);
    } else if (update.status === "failed") {
      const output = this.extractToolOutput(update);
      const errorText = output || "Tool execution failed (permission denied or cancelled)";
      debug(`[translator] caching failed tool result: id=${update.toolCallId} error=${errorText.slice(0, 100)}`);
      this.cacheToolResult(update.toolCallId, errorText, true);
    }
  }

  private extractToolOutput(
    update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>,
  ): string {
    // Try rawOutput first — but preserve newlines (don't use summarizeToolPayload which collapses whitespace)
    if (update.rawOutput !== undefined && update.rawOutput !== null) {
      if (typeof update.rawOutput === "string") {
        const text = update.rawOutput.trim();
        if (text.length) return text.slice(0, 2000);
      } else {
        try {
          const serialized = JSON.stringify(update.rawOutput);
          if (serialized !== "{}" && serialized !== "[]") {
            return serialized.length > 2000 ? `${serialized.slice(0, 1997)}...` : serialized;
          }
        } catch {}
      }
    }

    // Try content array
    if (Array.isArray((update as any).content)) {
      for (const item of (update as any).content) {
        if (item.type === "content" && item.content?.type === "text" && item.content.text) {
          return item.content.text.slice(0, 2000);
        }
        if (item.type === "diff") {
          return `diff: ${item.path || "unknown"}`;
        }
        if (item.type === "terminal") {
          return "[terminal output]";
        }
      }
    }

    // Try locations
    const locs = this.summarizeToolLocations(update.locations);
    if (locs) return locs;

    return "";
  }

  private extractToolOutputWithDetails(
    update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }>,
    toolUse?: { content?: Array<{ type: string; [key: string]: unknown }> },
  ): { output: string; details: Record<string, unknown> } {
    // Check for diff content from Edit/Write tools — prefer accumulated content from intermediate updates
    const diffSource = toolUse?.content || (update as any).content;
    const diffParts: string[] = [];
    if (Array.isArray(diffSource)) {
      for (const item of diffSource) {
        if ((item as any).type === "diff" && ((item as any).oldText || (item as any).newText)) {
          // Generate Pi-compatible diff format: +lineNum content / -lineNum content
          const oldLines = ((item as any).oldText || "").split("\n");
          const newLines = ((item as any).newText || "").split("\n");
          const maxLineNum = Math.max(oldLines.length, newLines.length);
          const lineNumWidth = String(maxLineNum).length;
          const diffLines: string[] = [];
          let oldLineNum = 1;
          let newLineNum = 1;
          for (const line of oldLines) {
            const num = String(oldLineNum).padStart(lineNumWidth, " ");
            diffLines.push(`-${num} ${line}`);
            oldLineNum++;
          }
          for (const line of newLines) {
            const num = String(newLineNum).padStart(lineNumWidth, " ");
            diffLines.push(`+${num} ${line}`);
            newLineNum++;
          }
          diffParts.push(diffLines.join("\n"));
        }
      }
    }

    const details: Record<string, unknown> = {};
    if (diffParts.length > 0) {
      details.diff = diffParts.join("\n");
    }

    const output = this.extractToolOutput(update);
    return { output, details };
  }

  private longestStartTokenSuffix(value: string): number {
    const maxLength = Math.min(value.length, TOOL_USE_BRIDGE_START.length - 1);
    for (let length = maxLength; length > 0; length -= 1) {
      if (TOOL_USE_BRIDGE_START.startsWith(value.slice(-length))) {
        return length;
      }
    }
    return 0;
  }

  private pushBridgeChunk(chunk: string, emitted: RawMessageStreamEvent[]) {
    this.pendingBridge += chunk;
    const endIndex = this.pendingBridge.indexOf(TOOL_USE_BRIDGE_END);
    if (endIndex < 0) {
      return;
    }

    const candidate = this.pendingBridge.slice(0, endIndex + TOOL_USE_BRIDGE_END.length);
    const trailing = this.pendingBridge.slice(endIndex + TOOL_USE_BRIDGE_END.length);
    const parsed = parseBridgedToolUse(candidate);

    if (parsed && !trailing.trim().length) {
      this.bridgedToolUse = parsed;
      this.pendingBridge = "";
      this.pendingText = "";
      return;
    }

    this.pendingBridge = "";
    this.emitTextDelta(candidate + trailing, emitted);
  }

  private pushToolAwareText(text: string): RawMessageStreamEvent[] {
    const emitted: RawMessageStreamEvent[] = [];
    if (!text.length || this.bridgedToolUse) {
      return emitted;
    }

    if (this.pendingBridge.length) {
      this.pushBridgeChunk(text, emitted);
      this.streamEvents.push(...emitted);
      return emitted;
    }

    const combined = this.pendingText + text;
    const startIndex = combined.indexOf(TOOL_USE_BRIDGE_START);
    if (startIndex >= 0) {
      this.pendingText = "";
      this.emitTextDelta(combined.slice(0, startIndex), emitted);
      this.pushBridgeChunk(combined.slice(startIndex), emitted);
      this.streamEvents.push(...emitted);
      return emitted;
    }

    const suffixLength = this.longestStartTokenSuffix(combined);
    const flushLength = combined.length - suffixLength;
    this.pendingText = combined.slice(flushLength);
    this.emitTextDelta(combined.slice(0, flushLength), emitted);
    this.streamEvents.push(...emitted);
    return emitted;
  }

  private flushPendingText(emitted: RawMessageStreamEvent[]) {
    if (this.pendingBridge.length) {
      this.pendingText += this.pendingBridge;
      this.pendingBridge = "";
    }

    if (!this.pendingText.length) {
      return;
    }

    this.emitTextDelta(this.pendingText, emitted);
    this.pendingText = "";
  }

  pushNotification(notification: SessionNotification): RawMessageStreamEvent[] {
    const emitted: RawMessageStreamEvent[] = [];
    const update = notification.update;

    if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
      this.emitThinkingDelta(update.content.text, emitted);
      this.streamEvents.push(...emitted);
      return emitted;
    }

    if (update.sessionUpdate === "tool_call") {
      debug(`[translator] tool_call: ${(update as any)._meta?.claudeCode?.toolName} id=${update.toolCallId}`);
      this.emitToolUseBlock(update, emitted);
      this.streamEvents.push(...emitted);
      return emitted;
    }

    if (update.sessionUpdate === "tool_call_update") {
      debug(`[translator] tool_call_update: id=${update.toolCallId} status=${update.status}`);
      this.cacheToolResultFromUpdate(update);
      this.streamEvents.push(...emitted);
      return emitted;
    }

    if (update.sessionUpdate !== "agent_message_chunk") {
      return emitted;
    }

    if (update.content.type === "text") {
      if (this.enableToolBridge) {
        return this.pushToolAwareText(update.content.text);
      }

      if (!update.content.text.length) {
        this.streamEvents.push(...emitted);
        return emitted;
      }

      this.emitTextDelta(update.content.text, emitted);
    }

    this.streamEvents.push(...emitted);
    return emitted;
  }

  finish(response: PromptResponse): FinalizedAnthropicTurn {
    this.usage.cache_creation_input_tokens = response.usage?.cachedWriteTokens ?? null;
    this.usage.cache_read_input_tokens = response.usage?.cachedReadTokens ?? null;
    this.usage.input_tokens = response.usage?.inputTokens ?? 0;
    this.usage.output_tokens = response.usage?.outputTokens ?? 0;

    const emitted: RawMessageStreamEvent[] = [];
    if (this.enableToolBridge && !this.bridgedToolUse) {
      this.flushPendingText(emitted);
      this.streamEvents.push(...emitted);
    }

    // Close any tool_use blocks that never received input via tool_call_update
    for (const [toolCallId, toolUse] of this.acpToolUses) {
      if (!toolUse.inputEmitted) {
        debug(`finish: emitting late content_block_stop for tool_use id=${toolCallId} (no rawInput received)`);
        this.streamEvents.push({
          type: "content_block_delta",
          index: toolUse.blockIndex,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(toolUse.rawInput),
          },
        });
        this.streamEvents.push({
          type: "content_block_stop",
          index: toolUse.blockIndex,
        });
        toolUse.inputEmitted = true;
      }
    }

    if (this.bridgedToolUse) {
      this.closeThinkingBlock(this.streamEvents);
      this.closeTextBlock(this.streamEvents);

      const block = toAnthropicToolUseBlock(this.bridgedToolUse, this.toolUseId) as ToolUseBlock;
      const blockIndex = this.content.length;
      this.content.push(block);
      this.streamEvents.push({
        type: "content_block_start",
        index: blockIndex,
        content_block: block,
      });
      this.streamEvents.push({
        type: "content_block_stop",
        index: blockIndex,
      });
    } else {
      this.closeThinkingBlock(this.streamEvents);
      this.closeTextBlock(this.streamEvents);
    }
    // If we have ACP tool_use blocks, set stop_reason to "tool_use"
    // so Pi executes our registered tools and sends results back.
    // The ACP backend will see the tool_result context in the next request
    // and continue from where it left off.
    const hasAcpToolUses = this.acpToolUses.size > 0;
    const stopReason = this.bridgedToolUse
      ? "tool_use"
      : hasAcpToolUses
        ? "tool_use"
        : mapStopReason(response.stopReason);
    debug(`[translator] finish: toolUses=${hasAcpToolUses ? this.acpToolUses.size : 0} stopReason=${stopReason} bridged=${!!this.bridgedToolUse}`);
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

  toIncrementalPromptRequest(
    sessionId: string,
    request: Parameters<typeof extractLastUserPrompt>[1],
  ) {
    return extractLastUserPrompt(sessionId, request);
  }

  createStreamCollector(args: {
    requestId: string;
    sessionId: string;
    model: string;
    enableToolBridge: boolean;
    includeProgressThinking: boolean;
    initialUsage: ProvisionalStreamUsage;
  }) {
    return new AnthropicStreamCollector(
      args.requestId,
      args.sessionId,
      args.model,
      args.enableToolBridge,
      args.includeProgressThinking,
      args.initialUsage,
    );
  }

  fromPromptResult(args: {
    requestId: string;
    sessionId: string;
    model: string;
    enableToolBridge: boolean;
    includeProgressThinking?: boolean;
    initialUsage: ProvisionalStreamUsage;
    response: PromptResponse;
    notifications: SessionNotification[];
  }) {
    const collector = this.createStreamCollector({
      requestId: args.requestId,
      sessionId: args.sessionId,
      model: args.model,
      enableToolBridge: args.enableToolBridge,
      includeProgressThinking: args.includeProgressThinking ?? false,
      initialUsage: args.initialUsage,
    });
    collector.start();
    for (const notification of args.notifications) {
      collector.pushNotification(notification);
    }
    return collector.finish(args.response);
  }
}
