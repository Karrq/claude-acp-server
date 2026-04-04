import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { HttpError } from "../../helpers/errors.js";
import type { Logger } from "../../interfaces.js";
import type { TerminalRecord } from "../../types.js";

function truncateOutput(output: string, byteLimit: number): { output: string; truncated: boolean } {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= byteLimit) {
    return { output, truncated: false };
  }

  const encoded = Buffer.from(output, "utf8");
  const slice = encoded.subarray(encoded.length - byteLimit);
  return { output: slice.toString("utf8"), truncated: true };
}

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalRecord>();

  constructor(
    private readonly logger: Logger,
    private readonly defaultByteLimit: number,
  ) {}

  async create(request: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = randomUUID();
    const child = spawn(request.command, request.args ?? [], {
      cwd: request.cwd ?? undefined,
      env: {
        ...process.env,
        ...Object.fromEntries((request.env ?? []).map((entry) => [entry.name, entry.value])),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessByStdio<null, Readable, Readable>;

    let resolveExit!: () => void;
    const waitForExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const record: TerminalRecord = {
      request,
      process: child,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      waitForExit,
      released: false,
    };

    const append = (chunk: Buffer | string) => {
      const limit = request.outputByteLimit ?? this.defaultByteLimit;
      const next = record.output + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      const truncated = truncateOutput(next, limit);
      record.output = truncated.output;
      record.truncated = record.truncated || truncated.truncated;
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("exit", (exitCode, signal) => {
      record.exitCode = exitCode;
      record.signal = signal;
      resolveExit();
    });
    child.on("error", (error) => {
      append(`\n[terminal error] ${error.message}\n`);
      record.exitCode = 1;
      resolveExit();
    });

    this.terminals.set(terminalId, record);
    return { terminalId };
  }

  async output(request: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(request.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      ...(terminal.exitCode !== null || terminal.signal !== null
        ? {
            exitStatus: {
              exitCode: terminal.exitCode,
              signal: terminal.signal,
            },
          }
        : {}),
    };
  }

  async waitForExit(request: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(request.terminalId);
    await terminal.waitForExit;
    return {
      exitCode: terminal.exitCode,
      signal: terminal.signal,
    };
  }

  async kill(request: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.getTerminal(request.terminalId);
    if (terminal.exitCode === null && terminal.signal === null && !terminal.process.killed) {
      terminal.process.kill("SIGTERM");
    }
    return {};
  }

  async release(request: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.getTerminal(request.terminalId);
    if (!terminal.released) {
      terminal.released = true;
      if (terminal.exitCode === null && terminal.signal === null && !terminal.process.killed) {
        terminal.process.kill("SIGTERM");
      }
      this.terminals.delete(request.terminalId);
    }
    return {};
  }

  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.terminals.keys(), (terminalId) =>
        this.release({ sessionId: "", terminalId }),
      ),
    );
  }

  private getTerminal(terminalId: string): TerminalRecord {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new HttpError({
        status: 404,
        type: "not_found_error",
        message: `Unknown terminal id: ${terminalId}`,
      });
    }
    return terminal;
  }
}
