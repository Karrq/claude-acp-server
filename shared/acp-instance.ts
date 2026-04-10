import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type * as Net from "node:net";
import { debug } from "./debug-log.js";
import { clearToolResults } from "./tool-result-cache.js";
import { fetchModelsFromBackend, DEFAULT_MODELS } from "./model-fetcher.js";
import type { AcpModelConfig } from "./model-fetcher.js";

// ── Instance management ───────────────────────────────────────────────

export interface AcpInstance {
  process: ChildProcess | null;
  port: number;
  apiKey: string | null;
  sessionId: string | null;
  mcpDir: string | null;
}

const instances = new Map<string, AcpInstance>();
let appendSystemContent: string | null = null;

export function getOrCreateInstance(id: string): AcpInstance {
  let inst = instances.get(id);
  if (!inst) {
    inst = { process: null, port: 14319, apiKey: null, sessionId: null, mcpDir: null };
    instances.set(id, inst);
  }
  return inst;
}

export function getInstances(): Map<string, AcpInstance> {
  return instances;
}

export function deleteInstance(id: string): void {
  instances.delete(id);
}

// ── Key / session ID generation ────────────────────────────────────────

export function generateApiKey(): string {
  return "acp-" + randomBytes(16).toString("hex");
}

export function generateSessionId(sessionFile: string | undefined): string {
  if (sessionFile) {
    return (
      "acp-" +
      createHash("sha256")
        .update(sessionFile)
        .digest("hex")
        .slice(0, 32)
    );
  }
  return "acp-ephemeral-" + randomBytes(8).toString("hex");
}

// ── Port discovery ────────────────────────────────────────────────────

export function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const require = createRequire(import.meta.url);
    const net = require("node:net") as typeof Net;
    const server = net.createServer();
    server.listen(startPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr !== "string" ? addr.port : startPort;
      server.close(() => resolve(port));
    });
    server.on("error", () => resolve(findFreePort(startPort + 1)));
  });
}

// ── System prompt loading ──────────────────────────────────────────────

function loadAppendSystem(): string | null {
  if (appendSystemContent !== null) return appendSystemContent;

  const paths = [
    join(process.env.HOME || "/root", ".pi/agent/APPEND_SYSTEM.md"),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf8");
        const lines = content
          .split("\n")
          .filter((line) => !line.startsWith("## ") && line.trim() !== "");
        appendSystemContent = lines.join("\n");
        debug(`Loaded APPEND_SYSTEM from ${path}`);
        return appendSystemContent;
      } catch (e) {
        debug(`Failed to read ${path}: ${e}`);
      }
    }
  }
  return null;
}

// ── Server start / stop ───────────────────────────────────────────────

export interface ServerStartResult {
  port: number;
  apiKey: string;
  process: ChildProcess;
}

export interface ServerStartOptions {
  /** Override the server dist path (defaults to auto-detection) */
  serverDistPath?: string;
  /** Override ACP backend command (default: "npx") */
  backendCommand?: string;
  /** Override ACP backend args (default: "-y @agentclientprotocol/claude-agent-acp") */
  backendArgs?: string;
}

export async function startServer(
  cwd: string,
  sessionId: string,
  inst: AcpInstance,
  options?: ServerStartOptions,
): Promise<ServerStartResult> {
  debug(`startServer: cwd=${cwd} sessionId=${sessionId}`);

  if (inst.process && !inst.process.killed) {
    inst.process.kill("SIGKILL");
    inst.process = null;
    debug(`startServer: killed previous process for this instance`);
  }

  const port = await findFreePort(14319);
  debug(`startServer: found free port ${port}`);
  const apiKey = generateApiKey();
  const customPrompt = loadAppendSystem();

  const claudeCodeOptions: Record<string, unknown> = {
    sessionId,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    ...(customPrompt && { systemPrompt: customPrompt }),
  };

  debug(`CLAUDE_ACP_OPTIONS: ${JSON.stringify(claudeCodeOptions).slice(0, 300)}`);

  const backendCommand = options?.backendCommand ?? "npx";
  const backendArgs = options?.backendArgs ?? "-y @agentclientprotocol/claude-agent-acp";

  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    FACADE_API_KEY: apiKey,
    ACP_BACKEND_COMMAND: backendCommand,
    ACP_BACKEND_ARGS: backendArgs,
    ACP_BACKEND_CWD: cwd,
    ACP_SESSION_CWD: cwd,
    ACP_PERMISSION_POLICY: "allow_always",
    ACP_PERMISSION_MODE: "bypassPermissions",
    CLAUDE_ACP_SESSION_ID: sessionId,
    CLAUDE_ACP_OPTIONS: JSON.stringify(claudeCodeOptions),
  };

  const serverPath =
    options?.serverDistPath ??
    join(
      realpathSync(
        new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"),
      ),
      "..",
      "dist",
      "index.js",
    );

  debug(`Using server at: ${serverPath}`);

  const proc = spawn("node", [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  debug(`startServer: spawned PID=${proc.pid}`);

  proc.stdout?.on("data", (data: Buffer) => {
    debug(`Server stdout: ${data.toString().slice(0, 500)}`);
  });
  proc.stderr?.on("data", (data: Buffer) => {
    debug(`Server stderr: ${data.toString().slice(0, 500)}`);
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      debug(`startServer: TIMEOUT after 30s — killing proc`);
      proc.kill("SIGKILL");
      reject(new Error("Server timeout"));
    }, 30000);
    const checkListening = (data: Buffer) => {
      const text = data.toString();
      debug(`startServer: checking data for 'listening': ${text.slice(0, 200)}`);
      if (text.includes("listening")) {
        clearTimeout(timeout);
        debug(`startServer: server is listening on port ${port}`);
        resolve();
      }
    };
    proc.stdout?.on("data", checkListening);
    proc.stderr?.on("data", checkListening);
    proc.on("error", (err) => {
      clearTimeout(timeout);
      debug(`startServer: proc error: ${err.message}`);
      reject(err);
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      debug(`startServer: proc exited code=${code} signal=${signal}`);
      if (code) {
        reject(new Error(`Server exited with code ${code}`));
      } else if (signal) {
        reject(new Error(`Server killed by signal ${signal}`));
      }
    });
  });

  return { port, apiKey, process: proc };
}

export async function stopInstance(inst: AcpInstance): Promise<void> {
  if (inst.process && !inst.process.killed) {
    inst.process.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!inst.process.killed) inst.process.kill("SIGKILL");
    inst.process = null;
    inst.apiKey = null;
  }
  if (inst.mcpDir) {
    try {
      rmSync(inst.mcpDir, { recursive: true });
    } catch {}
    inst.mcpDir = null;
  }
  clearToolResults();
}

// ── Health check ───────────────────────────────────────────────────────

export async function isServerReachable(inst: AcpInstance): Promise<boolean> {
  if (!inst.process || inst.process.killed || !inst.apiKey) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${inst.port}/v1/models`, {
      headers: {
        "x-api-key": inst.apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Start + fetch models ───────────────────────────────────────────────

export interface StartAndFetchResult {
  port: number;
  apiKey: string;
  process: ChildProcess;
  models: AcpModelConfig[];
}

export async function startServerAndFetchModels(
  cwd: string,
  sessionId: string,
  inst: AcpInstance,
  options?: ServerStartOptions,
): Promise<StartAndFetchResult> {
  const { port, apiKey, process: proc } = await startServer(
    cwd,
    sessionId,
    inst,
    options,
  );
  inst.process = proc;
  inst.port = port;
  inst.apiKey = apiKey;

  const backendModels = await fetchModelsFromBackend(port, apiKey);
  const models = backendModels.length > 0 ? backendModels : DEFAULT_MODELS;

  debug(
    `startServerAndFetchModels: ${models.length} models: ${models.map((m) => m.id).join(", ")}`,
  );

  return { port, apiKey, process: proc, models };
}

// ── Ensure running (auto-restart) ─────────────────────────────────────

export async function ensureServerRunning(
  cwd: string,
  inst: AcpInstance,
  getSessionId: () => string,
  options?: ServerStartOptions,
): Promise<{ restarted: boolean; models: AcpModelConfig[] }> {
  const reachable = await isServerReachable(inst);
  if (reachable) {
    debug(`ensureServerRunning: server is reachable on port ${inst.port}`);
    return { restarted: false, models: [] };
  }
  debug(`ensureServerRunning: server unreachable, restarting`);
  const sessionId = inst.sessionId || getSessionId();
  inst.sessionId = sessionId;
  const result = await startServerAndFetchModels(cwd, sessionId, inst, options);
  return { restarted: true, models: result.models };
}

// ── Request payload stripping ─────────────────────────────────────────

/**
 * Strip host-agent system prompts and tool definitions before forwarding
 * to the ACP server. The ACP backend manages its own tools and prompts.
 */
export function stripHostAgentContext(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const model = payload.model as string | undefined;
  const messages = payload.messages as Array<Record<string, unknown>> | undefined;

  debug(
    `=== REQUEST === model=${model} msgs=${messages?.length} tools=${(payload.tools as Array<unknown>)?.length}`,
  );

  // Remove host system prompt
  if (payload.system) {
    delete payload.system;
    debug("Stripped system prompt");
  }

  // Clear host tools — the ACP backend provides its own
  if (payload.tools && Array.isArray(payload.tools)) {
    payload.tools = [];
  }

  return payload;
}
