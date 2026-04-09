import { randomUUID } from "node:crypto";
import type { PromptResponse, SessionId, SessionNotification } from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";

const DEBUG_LOG = "/tmp/claude-acp-turn-buffer.log";
function debug(msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG, `[${ts}] ${msg}\n`);
  } catch {}
}

// ── Turn Buffer ──────────────────────────────────────────────────────
// Buffers all notifications from an ACP prompt() call.
// Splits them into chunks at tool batch boundaries.
// Each chunk becomes one Anthropic API "turn" (response).

export interface TurnChunk {
  notifications: SessionNotification[];
  stopReason: "tool_use" | "end_turn";
  usage: PromptResponse["usage"] | null;
}

export type NotificationCallback = (notification: SessionNotification) => void;
export type ChunkBoundaryCallback = (stopReason: "tool_use" | "end_turn") => void;
export type FinalizeCallback = (response: PromptResponse) => void;

export class TurnBuffer {
  private allNotifications: SessionNotification[] = [];
  private chunks: TurnChunk[] = [];
  private pendingToolIds: Set<string> = new Set();
  private currentChunkNotifications: SessionNotification[] = [];
  private finalResponse: PromptResponse | null = null;
  private resolvePrompt: ((response: PromptResponse) => void) | null = null;
  private promptPromise: Promise<PromptResponse> | null = null;
  private chunkReadyResolvers: (() => void)[] = [];
  private nextChunkIndex = 0;

  // Streaming callbacks - fire in real-time as notifications arrive
  private notificationCallback: NotificationCallback | null = null;
  private chunkBoundaryCallback: ChunkBoundaryCallback | null = null;
  private finalizeCallback: FinalizeCallback | null = null;

  constructor() {
    this.promptPromise = new Promise<PromptResponse>((resolve) => {
      this.resolvePrompt = resolve;
    });
  }

  /** Register callbacks for real-time streaming. Call before any notifications arrive. */
  setStreamCallbacks(callbacks: {
    onNotification: NotificationCallback;
    onChunkBoundary: ChunkBoundaryCallback;
    onFinalize: FinalizeCallback;
  }): void {
    this.notificationCallback = callbacks.onNotification;
    this.chunkBoundaryCallback = callbacks.onChunkBoundary;
    this.finalizeCallback = callbacks.onFinalize;
  }

  clearStreamCallbacks(): void {
    this.notificationCallback = null;
    this.chunkBoundaryCallback = null;
    this.finalizeCallback = null;
  }

  pushNotification(notification: SessionNotification): void {
    this.allNotifications.push(notification);
    this.notificationCallback?.(notification);
    const update = notification.update;

    if (update.sessionUpdate === "tool_call") {
      this.pendingToolIds.add(update.toolCallId);
      this.currentChunkNotifications.push(notification);
      debug(`push tool_call: id=${update.toolCallId} pending=${this.pendingToolIds.size} chunkNotifs=${this.currentChunkNotifications.length} rawInput=${JSON.stringify((update as any).rawInput ?? null).slice(0, 200)}`);
      debug(`push tool_call FULL: ${JSON.stringify(update).slice(0, 500)}`);
    } else if (update.sessionUpdate === "tool_call_update") {
      this.currentChunkNotifications.push(notification);
      debug(`push tool_call_update FULL: ${JSON.stringify(update).slice(0, 500)}`);
      if (update.status === "completed" || update.status === "failed") {
        this.pendingToolIds.delete(update.toolCallId);
        debug(`push tool_call_update: id=${update.toolCallId} status=${update.status} pending=${this.pendingToolIds.size} rawInput=${JSON.stringify((update as any).rawInput ?? null).slice(0, 200)}`);
        // Batch boundary: all pending tools done
        if (this.pendingToolIds.size === 0 && this.currentChunkNotifications.length > 0) {
          debug(`flushing chunk: tool_use notifs=${this.currentChunkNotifications.length} totalChunks=${this.chunks.length + 1}`);
          this.flushChunk("tool_use");
        }
      }
    } else {
      this.currentChunkNotifications.push(notification);
    }
  }

  private flushChunk(stopReason: "tool_use" | "end_turn"): void {
    if (this.currentChunkNotifications.length === 0 && stopReason !== "end_turn") return;
    this.chunks.push({
      notifications: this.currentChunkNotifications,
      stopReason,
      usage: null,
    });
    this.currentChunkNotifications = [];
    this.chunkBoundaryCallback?.(stopReason);
    // Notify anyone waiting for a chunk
    for (const resolve of this.chunkReadyResolvers) {
      resolve();
    }
    this.chunkReadyResolvers = [];
  }

  finalize(response: PromptResponse): void {
    this.finalResponse = response;
    debug(`finalize: flushing final chunk notifs=${this.currentChunkNotifications.length} existingChunks=${this.chunks.length} stopReason=${response.stopReason}`);
    // Flush remaining notifications as the final chunk
    this.flushChunk("end_turn");
    // Update last chunk with usage
    if (this.chunks.length > 0) {
      this.chunks[this.chunks.length - 1].usage = response.usage ?? null;
    }
    debug(`finalize: total chunks=${this.chunks.length}`);
    this.finalizeCallback?.(response);
    // Resolve the prompt promise
    if (this.resolvePrompt) {
      this.resolvePrompt(response);
    }
    // Notify anyone waiting
    for (const resolve of this.chunkReadyResolvers) {
      resolve();
    }
    this.chunkReadyResolvers = [];
  }

  async waitForNextChunk(): Promise<TurnChunk | null> {
    // If we have a chunk ready, return it
    if (this.nextChunkIndex < this.chunks.length) {
      return this.chunks[this.nextChunkIndex++];
    }
    // If the prompt is complete and no more chunks, return null
    if (this.finalResponse !== null) {
      return null;
    }
    // Wait for either a new chunk or finalization
    await new Promise<void>((resolve) => {
      this.chunkReadyResolvers.push(resolve);
    });
    // Check again
    if (this.nextChunkIndex < this.chunks.length) {
      return this.chunks[this.nextChunkIndex++];
    }
    return null;
  }

  get isComplete(): boolean {
    return this.finalResponse !== null;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  get consumedChunkCount(): number {
    return this.nextChunkIndex;
  }

  get hasNextChunk(): boolean {
    return this.nextChunkIndex < this.chunks.length;
  }

  /** Advance the chunk index without returning the chunk. Used after streaming a chunk live. */
  skipCurrentChunk(): void {
    if (this.nextChunkIndex < this.chunks.length) {
      this.nextChunkIndex++;
    }
  }
}

// ── Session-level buffer store ─────────────────────────────────────────

const turnBuffers = new Map<SessionId, TurnBuffer>();

export function getTurnBuffer(sessionId: SessionId): TurnBuffer {
  let buffer = turnBuffers.get(sessionId);
  if (!buffer) {
    buffer = new TurnBuffer();
    turnBuffers.set(sessionId, buffer);
    debug(`Created buffer for session ${sessionId.slice(0, 8)}`);
  }
  return buffer;
}

export function clearTurnBuffer(sessionId: SessionId): void {
  turnBuffers.delete(sessionId);
  debug(`Cleared buffer for session ${sessionId.slice(0, 8)}`);
}

export function hasTurnBuffer(sessionId: SessionId): boolean {
  return turnBuffers.has(sessionId);
}
