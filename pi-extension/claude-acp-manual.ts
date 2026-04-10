import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { highlightCode, getLanguageFromPath, keyHint } from "@mariozechner/pi-coding-agent";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { Model, Context, SimpleStreamOptions, Api } from "@mariozechner/pi-ai";
import Anthropic from "@anthropic-ai/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { rmSync, readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEBUG_LOG = "/tmp/claude-acp-ext-debug.log";
const RESULTS_DIR = "/tmp/claude-acp-tool-results";

function debug(msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG, `[${ts}] ${msg}\n`);
  } catch {}
}

// ── Tool rendering helpers ───────────────────────────────────────────
// Mimics Pi's built-in tool renderers for the 6 ACP tools.

function shortenPath(p: string): string {
  if (!p) return "";
  const home = homedir();
  if (p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

function getPath(args: any): string | null {
  const raw = str(args?.file_path ?? args?.path);
  return raw !== null ? shortenPath(raw) : null;
}

function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

const READ_PREVIEW_LINES = 10;
const BASH_PREVIEW_LINES = 5;

// ── renderCall formatters ──────────────────────────────────────────────

function formatReadCall(args: any, theme: any): string {
  const path = getPath(args);
  const offset = args?.offset;
  const limit = args?.limit;
  let pathDisplay = path === null
    ? theme.fg("error", "[invalid arg]")
    : path
      ? theme.fg("accent", path)
      : theme.fg("toolOutput", "...");
  if (offset !== undefined || limit !== undefined) {
    const startLine = offset ?? 1;
    const endLine = limit !== undefined ? startLine + limit - 1 : "";
    pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
  }
  return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;
}

function formatBashCall(args: any, theme: any): string {
  const command = str(args?.command);
  const timeout = args?.timeout;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  const commandDisplay = command === null
    ? theme.fg("error", "[invalid arg]")
    : command
      ? command
      : theme.fg("toolOutput", "...");
  return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function formatEditCall(args: any, theme: any): string {
  const rawPath = str(args?.file_path ?? args?.path);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  const pathDisplay = path === null
    ? theme.fg("error", "[invalid arg]")
    : path
      ? theme.fg("accent", path)
      : theme.fg("toolOutput", "...");
  let text = `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;

  // Show edit details: oldText -> newText summary
  const edits = args?.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    text += theme.fg("muted", ` (${edits.length} edit${edits.length > 1 ? "s" : ""})`);
  } else {
    const oldText = str(args?.oldText);
    const newText = str(args?.newText);
    if (oldText) {
      const summary = oldText.trim().split("\n").length > 1
        ? `${oldText.trim().split("\n").length} lines`
        : `"${oldText.trim().slice(0, 60)}${oldText.trim().length > 60 ? "..." : ""}"`;
      text += theme.fg("muted", ` replace ${summary}`);
    }
  }
  return text;
}

function formatWriteCall(args: any, options: any, theme: any): string {
  const rawPath = str(args?.file_path ?? args?.path);
  const fileContent = str(args?.content);
  const path = rawPath !== null ? shortenPath(rawPath) : null;
  let text = `${theme.fg("toolTitle", theme.bold("write"))} ${path === null ? theme.fg("error", "[invalid arg]") : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...")}`;
  if (fileContent === null) {
    text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
  } else if (fileContent) {
    const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
    const renderedLines = lang
      ? highlightCode(replaceTabs(fileContent), lang)
      : fileContent.split("\n").map((l: string) => theme.fg("toolOutput", replaceTabs(l)));
    // Trim trailing empty lines
    let end = renderedLines.length;
    while (end > 0 && !renderedLines[end - 1]?.trim()) end--;
    const lines = renderedLines.slice(0, end);
    const totalLines = lines.length;
    const maxLines = options.expanded ? totalLines : 10;
    const displayLines = lines.slice(0, maxLines);
    const remaining = totalLines - maxLines;
    text += `\n\n${displayLines.join("\n")}`;
    if (remaining > 0) {
      text += theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total, ${keyHint("app.tools.expand", "to expand")})`);
    }
  }
  return text;
}

function formatGlobCall(args: any, theme: any): string {
  const pattern = str(args?.pattern);
  const rawPath = str(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
  let text = theme.fg("toolTitle", theme.bold("glob")) +
    " " +
    (pattern === null ? theme.fg("error", "[invalid arg]") : theme.fg("accent", pattern || "")) +
    theme.fg("toolOutput", ` in ${path === null ? "." : path}`);
  return text;
}

function formatGrepCall(args: any, theme: any): string {
  const pattern = str(args?.pattern);
  const rawPath = str(args?.path);
  const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
  const glob = str(args?.glob);
  let text = theme.fg("toolTitle", theme.bold("grep")) +
    " " +
    (pattern === null ? theme.fg("error", "[invalid arg]") : theme.fg("accent", `/${pattern || ""}/`)) +
    theme.fg("toolOutput", ` in ${path === null ? "." : path}`);
  if (glob) text += theme.fg("toolOutput", ` (${glob})`);
  return text;
}

// ── renderResult formatters ──────────────────────────────────────────────

function renderReadResult(result: any, options: any, theme: any, context: any): any {
  const text = context.lastComponent ?? new Text("", 0, 0);
  const output = (result.content?.[0]?.text ?? "").replace(/\r/g, "");
  const rawPath = context.args?.file_path ?? context.args?.path;
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;

  if (!output.trim()) {
    text.setText("");
    return text;
  }

  const lines = lang
    ? highlightCode(replaceTabs(output), lang)
    : output.split("\n").map((l: string) => theme.fg("toolOutput", replaceTabs(l)));

  // Trim trailing empty lines
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) end--;
  const trimmed = lines.slice(0, end);

  const maxLines = options.expanded ? trimmed.length : READ_PREVIEW_LINES;
  const displayLines = trimmed.slice(0, maxLines);
  const remaining = trimmed.length - maxLines;

  let rendered = "\n" + displayLines.join("\n");
  if (remaining > 0) {
    rendered += theme.fg("muted", `\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
  }
  text.setText(rendered);
  return text;
}

function renderBashResult(result: any, options: any, theme: any, context: any): any {
  const text = context.lastComponent ?? new Text("", 0, 0);
  const output = (result.content?.[0]?.text ?? "").replace(/\r/g, "").trim();

  if (!output) {
    text.setText(theme.fg("muted", "(no output)"));
    return text;
  }

  const styledLines = output.split("\n").map((l: string) => theme.fg("toolOutput", l));
  const maxLines = options.expanded ? styledLines.length : BASH_PREVIEW_LINES;
  const displayLines = styledLines.slice(0, maxLines);
  const remaining = styledLines.length - maxLines;

  let rendered = "\n" + displayLines.join("\n");
  if (remaining > 0) {
    rendered += theme.fg("muted", `\n... (${remaining} more lines, ${keyHint("app.tools.expand", "to expand")})`);
  }
  text.setText(rendered);
  return text;
}

function renderEditResult(result: any, options: any, theme: any, context: any): any {
  // Show error text on failure
  if (context.isError) {
    const errorText = (result.content?.[0]?.text ?? "").trim();
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(errorText ? `\n${theme.fg("error", errorText)}` : "");
    return text;
  }
  // Show diff from details if available
  const diff = result.details?.diff;
  if (diff) {
    const text = context.lastComponent ?? new Text("", 0, 0);
    const lines = diff.split("\n");
    const rendered = lines.map((line: string) => {
      if (line.startsWith("+")) return theme.fg("success", line);
      if (line.startsWith("-")) return theme.fg("error", line);
      return theme.fg("muted", line);
    }).join("\n");
    text.setText(`\n${rendered}`);
    return text;
  }
  const text = context.lastComponent ?? new Text("", 0, 0);
  text.setText("");
  return text;
}

function renderWriteResult(result: any, options: any, theme: any, context: any): any {
  // Show error text on failure
  if (context.isError) {
    const errorText = (result.content?.[0]?.text ?? "").trim();
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(errorText ? `\n${theme.fg("error", errorText)}` : "");
    return text;
  }
  // The call rendering already shows the written content, no need for diff
  const text = context.lastComponent ?? new Text("", 0, 0);
  text.setText("");
  return text;
}

function renderGlobResult(result: any, options: any, theme: any, context: any): any {
  const text = context?.lastComponent ?? new Text("", 0, 0);
  const output = (result.content?.[0]?.text ?? "").trim();
  if (!output) {
    text.setText(theme.fg("muted", "No files found"));
    return text;
  }
  const lines = output.split("\n");
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let rendered = "\n" + displayLines.map((l: string) => theme.fg("toolOutput", shortenPath(l))).join("\n");
  if (remaining > 0) {
    rendered += theme.fg("muted", `\n... (${remaining} more, ${keyHint("app.tools.expand", "to expand")})`);
  }
  text.setText(rendered);
  return text;
}

function renderGrepResult(result: any, options: any, theme: any, context: any): any {
  const text = context?.lastComponent ?? new Text("", 0, 0);
  const output = (result.content?.[0]?.text ?? "").trim();
  if (!output) {
    text.setText(theme.fg("muted", "No matches found"));
    return text;
  }
  const lines = output.split("\n");
  const maxLines = options.expanded ? lines.length : 10;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let rendered = "\n" + displayLines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
  if (remaining > 0) {
    rendered += theme.fg("muted", `\n... (${remaining} more, ${keyHint("app.tools.expand", "to expand")})`);
  }
  text.setText(rendered);
  return text;
}

// ── Tool renderer map ──────────────────────────────────────────────────
const toolRenderers: Record<string, {
  renderCall: (args: any, theme: any, context: any) => any;
  renderResult: (result: any, options: any, theme: any, context: any) => any;
}> = {
  Read: {
    renderCall(args, theme, context) {
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatReadCall(args, theme));
      return text;
    },
    renderResult: renderReadResult,
  },
  Bash: {
    renderCall(args, theme, context) {
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatBashCall(args, theme));
      return text;
    },
    renderResult: renderBashResult,
  },
  Edit: {
    renderCall(args, theme, context) {
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatEditCall(args, theme));
      return text;
    },
    renderResult: renderEditResult,
  },
  Write: {
    renderCall(args, theme, context) {
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatWriteCall(args, { expanded: context.expanded, isPartial: context.isPartial }, theme));
      return text;
    },
    renderResult: renderWriteResult,
  },
  Glob: {
    renderCall(args, theme, context) {
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatGlobCall(args, theme));
      return text;
    },
    renderResult: renderGlobResult,
  },
  Grep: {
    renderCall(args, theme, context) {
      const text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatGrepCall(args, theme));
      return text;
    },
    renderResult: renderGrepResult,
  },
};

function storeToolResult(toolCallId: string, result: string): void {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${toolCallId}.json`), JSON.stringify(result));
  } catch {}
}

function readToolResult(toolCallId: string): { text: string; is_error: boolean; details: Record<string, unknown> } | null {
  try {
    const p = join(RESULTS_DIR, `${toolCallId}.json`);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      // Handle both old format (plain string) and new format ({text, is_error, details})
      if (typeof raw === "string") return { text: raw, is_error: false, details: {} };
      return { text: raw.text || "", is_error: !!raw.is_error, details: raw.details || {} };
    }
  } catch {}
  return null;
}

function clearToolResults(): void {
  try { rmSync(RESULTS_DIR, { recursive: true }); } catch {}
}

// Per-instance state keyed by a unique instance ID.
// Each Pi session gets its own server process so multiple sessions
// can run concurrently without interfering with each other.
interface AcpInstance {
  process: ChildProcess | null;
  port: number;
  apiKey: string | null;
  sessionId: string | null;
  mcpDir: string | null;
}

const instances = new Map<string, AcpInstance>();
let appendSystemContent: string | null = null;

function getOrCreateInstance(id: string): AcpInstance {
  let inst = instances.get(id);
  if (!inst) {
    inst = { process: null, port: 14319, apiKey: null, sessionId: null, mcpDir: null };
    instances.set(id, inst);
  }
  return inst;
}

function loadAppendSystem(): string | null {
  if (appendSystemContent !== null) return appendSystemContent;
  
  const paths = [
    join(process.env.HOME || "/Users/karrq", ".nixpkgs/profiles/home-manager/karrq/dotfiles/pi-agent/APPEND_SYSTEM.md"),
    join(process.env.HOME || "/Users/karrq", ".pi/agent/APPEND_SYSTEM.md"),
  ];
  
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf8");
        const lines = content.split("\n").filter(line => !line.startsWith("## ") && line.trim() !== "");
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

function generateApiKey(): string {
  return "pi-" + randomBytes(16).toString("hex");
}

function generateSessionId(sessionFile: string | undefined): string {
  if (sessionFile) {
    return "pi-" + createHash("sha256").update(sessionFile).digest("hex").slice(0, 32);
  }
  return "pi-ephemeral-" + randomBytes(8).toString("hex");
}

function findFreePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const net = require("node:net");
    const server = net.createServer();
    server.listen(startPort, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
    server.on("error", () => resolve(findFreePort(startPort + 1)));
  });
}

async function startServer(cwd: string, sessionId: string, inst: AcpInstance): Promise<{ port: number; apiKey: string; process: ChildProcess }> {
  debug(`startServer: cwd=${cwd} sessionId=${sessionId}`);

  // Kill only this instance's old process (if any) before finding a free port.
  if (inst.process && !inst.process.killed) {
    inst.process.kill("SIGKILL");
    inst.process = null;
    debug(`startServer: killed previous process for this instance`);
  }

  const port = await findFreePort(14319);
  debug(`startServer: found free port ${port}`);
  const apiKey = generateApiKey();
  const customPrompt = loadAppendSystem();
  
  const claudeCodeOptions: any = {
    sessionId,
    tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    ...(customPrompt && { systemPrompt: customPrompt }),
  };
  
  debug(`CLAUDE_ACP_OPTIONS: ${JSON.stringify(claudeCodeOptions).slice(0, 300)}`);
  
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    FACADE_API_KEY: apiKey,
    ACP_BACKEND_COMMAND: "npx",
    ACP_BACKEND_ARGS: "-y @agentclientprotocol/claude-agent-acp",
    ACP_BACKEND_CWD: cwd,
    ACP_SESSION_CWD: cwd,
    ACP_PERMISSION_POLICY: "allow_always",
    ACP_PERMISSION_MODE: "bypassPermissions",
    CLAUDE_ACP_SESSION_ID: sessionId,
    CLAUDE_ACP_OPTIONS: JSON.stringify(claudeCodeOptions),
  };
  
  // Resolve server path: the extension lives in pi-extension/ inside the fork repo.
  // Use realpathSync to follow symlinks so it works when loaded via symlink from ~/.pi/agent/.
  const extDir = realpathSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
  const serverPath = join(extDir, '..', 'dist', 'index.js');
  debug(`Using server at: ${serverPath}`);
  debug(`Spawn command: node ${serverPath} PORT=${port} HOST=127.0.0.1`);
  
  const proc = spawn("node", [serverPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  
  debug(`startServer: spawned PID=${proc.pid}`);
  
  // Log ALL stdout/stderr for debugging
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
    proc.on("error", (err) => { clearTimeout(timeout); debug(`startServer: proc error: ${err.message}`); reject(err); });
    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      debug(`startServer: proc exited code=${code} signal=${signal}`);
      if (code) { reject(new Error(`Server exited with code ${code}`)); }
      else if (signal) { reject(new Error(`Server killed by signal ${signal}`)); }
    });
  });
  
  return { port, apiKey, process: proc };
}

async function stopInstance(inst: AcpInstance): Promise<void> {
  if (inst.process && !inst.process.killed) {
    inst.process.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 500));
    if (!inst.process.killed) inst.process.kill("SIGKILL");
    inst.process = null;
    inst.apiKey = null;
  }
  if (inst.mcpDir) {
    try { rmSync(inst.mcpDir, { recursive: true }); } catch {}
    inst.mcpDir = null;
  }
  clearToolResults();
}

// Fetch the model list from a running ACP server and return ProviderModelConfig[].
async function fetchModelsFromBackend(port: number, apiKey: string): Promise<{ id: string; name: string; reasoning: boolean; input: ("text" | "image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number }[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) {
      debug(`fetchModelsFromBackend: HTTP ${res.status}`);
      return [];
    }
    const body = await res.json() as { data?: { id: string; display_name?: string }[] };
    const models = body.data ?? [];
    debug(`fetchModelsFromBackend: got ${models.length} models: ${models.map(m => m.id).join(", ")}`);
    return models.map(m => ({
      id: m.id,
      name: m.display_name || m.id,
      reasoning: false,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    }));
  } catch (err) {
    debug(`fetchModelsFromBackend: ${err}`);
    return [];
  }
}

// Check if the ACP server is reachable.
async function isServerReachable(inst: AcpInstance): Promise<boolean> {
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

// ── Custom streamSimple with session ID cookie jar ──────────────────
// Uses the Anthropic SDK directly with a custom `fetch` that captures
// x-acp-session-id from response headers. The client API key (from
// /v1/register) handles identity and session scoping on the server.
// The session ID cookie jar provides explicit session control for
// forking, resuming, etc.

type SessionIdStore = { current: string | null };

function createSessionCapturingFetch(sessionIdStore: SessionIdStore): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);
    const sid = response.headers.get("x-acp-session-id");
    if (sid && sid !== sessionIdStore.current) {
      debug(`fetch: captured x-acp-session-id=${sid.slice(0, 16)}`);
      sessionIdStore.current = sid;
    }
    return response;
  };
}

function mapStopReason(reason: string): string {
  return reason === "end_turn" ? "stop" : reason === "max_tokens" ? "length" : reason === "tool_use" ? "toolUse" : "stop";
}

function createAcpStreamSimple(sessionIdStore: SessionIdStore) {
  const capturingFetch = createSessionCapturingFetch(sessionIdStore);

  return function acpStreamSimple(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const output: any = {
        role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };

      try {
        const headers: Record<string, string> = {
          ...(model.headers || {}), ...(options?.headers || {}),
        };
        if (sessionIdStore.current) {
          headers["x-acp-session-id"] = sessionIdStore.current;
          debug(`acpStreamSimple: sending x-acp-session-id=${sessionIdStore.current.slice(0, 16)}`);
        }

        const client = new Anthropic({
          apiKey: options?.apiKey || "",
          baseURL: model.baseUrl,
          dangerouslyAllowBrowser: true,
          defaultHeaders: headers,
          fetch: capturingFetch,
        });

        // Strip Pi's system prompt and tools - the ACP server provides its own.
        const params: any = {
          model: model.id,
          messages: context.messages.map((msg: any) => {
            if (msg.role === "user") {
              if (typeof msg.content === "string") return { role: "user", content: msg.content };
              return { role: "user", content: msg.content.map((b: any) =>
                b.type === "text" ? { type: "text", text: b.text }
                : b.type === "image" ? { type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } }
                : b
              )};
            }
            if (msg.role === "assistant") {
              return { role: "assistant", content: msg.content.map((b: any) =>
                b.type === "text" ? { type: "text", text: b.text }
                : b.type === "thinking" ? (b.thinkingSignature?.trim()
                    ? { type: "thinking", thinking: b.thinking, signature: b.thinkingSignature }
                    : { type: "text", text: b.thinking })
                : b.type === "toolCall" ? { type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} }
                : b
              ).filter((b: any) => !(b.type === "text" && !b.text?.trim())) };
            }
            if (msg.role === "toolResult") {
              return { role: "user", content: [{
                type: "tool_result", tool_use_id: msg.toolCallId,
                content: msg.content.map((c: any) => c.type === "text" ? { type: "text", text: c.text } : c),
                is_error: msg.isError,
              }]};
            }
            return msg;
          }).filter((m: any) => {
            if (!Array.isArray(m.content)) return m.content?.trim();
            return m.content.length > 0;
          }),
          max_tokens: options?.maxTokens || (model.maxTokens / 3) | 0,
          stream: true,
        };
        if (options?.temperature !== undefined) params.temperature = options.temperature;

        const sdk = client.messages.stream(params, { signal: options?.signal });
        stream.push({ type: "start", partial: output });

        const blocks = output.content as any[];
        for await (const event of sdk) {
          if (event.type === "message_start") {
            const u = event.message.usage;
            Object.assign(output.usage, { input: u.input_tokens || 0, output: u.output_tokens || 0,
              cacheRead: (u as any).cache_read_input_tokens || 0, cacheWrite: (u as any).cache_creation_input_tokens || 0 });
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          } else if (event.type === "content_block_start") {
            const cb = event.content_block;
            const ci = output.content.length;
            if (cb.type === "text") { blocks.push({ type: "text", text: "", _idx: event.index }); stream.push({ type: "text_start", contentIndex: ci, partial: output }); }
            else if (cb.type === "thinking") { blocks.push({ type: "thinking", thinking: "", thinkingSignature: "", _idx: event.index }); stream.push({ type: "thinking_start", contentIndex: ci, partial: output }); }
            else if (cb.type === "tool_use") { blocks.push({ type: "toolCall", id: cb.id, name: cb.name, arguments: cb.input ?? {}, _json: "", _idx: event.index }); stream.push({ type: "toolcall_start", contentIndex: ci, partial: output }); }
          } else if (event.type === "content_block_delta") {
            const i = blocks.findIndex((b: any) => b._idx === event.index);
            const b = blocks[i];
            if (!b) continue;
            if (event.delta.type === "text_delta" && b.type === "text") { b.text += event.delta.text; stream.push({ type: "text_delta", contentIndex: i, delta: event.delta.text, partial: output }); }
            else if (event.delta.type === "thinking_delta" && b.type === "thinking") { b.thinking += event.delta.thinking; stream.push({ type: "thinking_delta", contentIndex: i, delta: event.delta.thinking, partial: output }); }
            else if (event.delta.type === "input_json_delta" && b.type === "toolCall") { b._json += event.delta.partial_json; try { b.arguments = JSON.parse(b._json); } catch {} stream.push({ type: "toolcall_delta", contentIndex: i, delta: event.delta.partial_json, partial: output }); }
            else if (event.delta.type === "signature_delta" && b.type === "thinking") { b.thinkingSignature = (b.thinkingSignature || "") + event.delta.signature; }
          } else if (event.type === "content_block_stop") {
            const i = blocks.findIndex((b: any) => b._idx === event.index);
            const b = blocks[i];
            if (!b) continue;
            delete b._idx;
            if (b.type === "text") stream.push({ type: "text_end", contentIndex: i, content: b.text, partial: output });
            else if (b.type === "thinking") stream.push({ type: "thinking_end", contentIndex: i, content: b.thinking, partial: output });
            else if (b.type === "toolCall") { try { b.arguments = JSON.parse(b._json); } catch {} delete b._json; stream.push({ type: "toolcall_end", contentIndex: i, toolCall: b, partial: output }); }
          } else if (event.type === "message_delta") {
            if (event.delta.stop_reason) output.stopReason = mapStopReason(event.delta.stop_reason);
            if (event.usage.output_tokens != null) output.usage.output = event.usage.output_tokens;
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }
        }

        if (options?.signal?.aborted) throw new Error("Request was aborted");
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (error) {
        for (const b of output.content) { delete b._idx; delete b._json; }
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}

export default function (pi: ExtensionAPI) {
  // Unique per Pi process. Used as both the instance key (for server
  // lifecycle) and the API key (for server-side session scoping).
  const instanceId = `pi-${process.pid}-${randomBytes(4).toString("hex")}`;
  const clientApiKey = `acp-${randomBytes(16).toString("hex")}`;
  const inst = getOrCreateInstance(instanceId);

  // Session ID store: captures x-acp-session-id from server response headers.
  // Provides explicit session control (fork, resume) while the client API key
  // handles identity and session scoping on the server.
  const sessionIdStore: SessionIdStore = { current: null };

  // Helper: start the server, fetch dynamic models, and register the provider.
  async function startAndRegister(cwd: string, sessionId: string, ctx: any): Promise<void> {
    const { port, process: proc } = await startServer(cwd, sessionId, inst);
    inst.process = proc;
    inst.port = port;
    inst.apiKey = clientApiKey;

    // Reset the session ID store on server (re)start
    sessionIdStore.current = null;

    // Fetch the real model list from the backend
    const backendModels = await fetchModelsFromBackend(port, clientApiKey);
    const models = backendModels.length > 0
      ? backendModels
      : [{ id: "default", name: "Claude ACP", reasoning: false as const, input: ["text", "image"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 }];

    debug(`startAndRegister: registering provider with ${models.length} models`);

    try { pi.unregisterProvider("claude-acp"); } catch {}
    pi.registerProvider("claude-acp", {
      baseUrl: `http://127.0.0.1:${port}`,
      api: "anthropic-messages",
      apiKey,
      streamSimple: createAcpStreamSimple(sessionIdStore),
      models,
    });

    const modelNames = models.map(m => m.name || m.id).join(", ");
    ctx.ui.notify(`Claude ACP ready on port ${port} (${models.length} models: ${modelNames})`, "success");
  }

  // Helper: ensure the server is running, restarting if unreachable.
  async function ensureServerRunning(cwd: string, ctx: any): Promise<void> {
    const reachable = await isServerReachable(inst);
    if (reachable) {
      debug(`ensureServerRunning: server is reachable on port ${inst.port}`);
      return;
    }
    debug(`ensureServerRunning: server unreachable, restarting`);
    ctx.ui.notify("Claude ACP server unreachable, restarting...", "warning");
    const sessionId = inst.sessionId || generateSessionId(ctx.sessionManager.getSessionFile());
    inst.sessionId = sessionId;
    await startAndRegister(cwd, sessionId, ctx);
  }

  // ── Register ACP tools with open schemas ────────────────────────────
  // Pi executes these when it sees tool_use blocks in the response.
  // They return cached results written by the fork's translator.
  const openSchema = Type.Object({}, { additionalProperties: true });
  for (const name of ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]) {
    const renderer = toolRenderers[name];
    pi.registerTool({
      name,
      label: name,
      description: `Already executed by Claude Code`,
      parameters: openSchema,
      async execute(toolCallId, _params, _signal, _onUpdate, _ctx) {
        let cached = readToolResult(toolCallId);
        for (let i = 0; !cached && i < 50; i++) {
          await new Promise(r => setTimeout(r, 100));
          cached = readToolResult(toolCallId);
        }
        const isHit = cached !== null;
        const isError = cached?.is_error ?? false;
        debug(`Tool ${name} (${toolCallId}): ${isHit ? (isError ? "error" : "hit") : "miss"} details=${JSON.stringify(cached?.details || {}).slice(0, 200)}`);
        return {
          content: [{ type: "text", text: cached?.text || "" }],
          details: cached?.details || {},
          ...(isError && { is_error: true }),
        };
      },
      ...(renderer?.renderCall && { renderCall: renderer.renderCall }),
      ...(renderer?.renderResult && { renderResult: renderer.renderResult }),
    });
  }

  // ── Register provider (placeholder until server starts) ───────────
  pi.registerProvider("claude-acp", {
    baseUrl: "http://127.0.0.1:1",
    api: "anthropic-messages",
    apiKey: "not-started",
    streamSimple: createAcpStreamSimple(sessionIdStore),
    models: [{
      id: "default",
      name: "Claude ACP",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }]
  });

  // ── Setup/teardown on model selection ───────────────────────────────
  pi.on("model_select", async (event, ctx) => {
    const wasAcp = event.previousModel?.provider === "claude-acp";
    const isAcp = event.model?.provider === "claude-acp";

    if (wasAcp && !isAcp) {
      await stopInstance(inst);
      ctx.ui.notify("Claude ACP stopped", "info");
      return;
    }

    if (isAcp && !wasAcp) {
      try {
        const sessionId = inst.sessionId || generateSessionId(ctx.sessionManager.getSessionFile());
        inst.sessionId = sessionId;
        debug(`Session ID: ${sessionId.slice(0, 32)}`);
        await startAndRegister(ctx.cwd, sessionId, ctx);
      } catch (err) {
        debug(`Failed to start: ${err}`);
        ctx.ui.notify(`Failed to start Claude ACP: ${err}`, "error");
      }
    }
  });

  // On session start: restart the server for THIS instance if the model is
  // already claude-acp (e.g. after /new, resume, or fork where session_shutdown
  // killed the server but model_select won't fire because the model didn't change).
  pi.on("session_start", async (event, ctx) => {
    if (ctx.model?.provider === "claude-acp") {
      debug(`session_start: model is claude-acp, ensuring server is running`);
      const sessionId = generateSessionId(ctx.sessionManager.getSessionFile());
      inst.sessionId = sessionId;

      try {
        await startAndRegister(ctx.cwd, sessionId, ctx);
      } catch (err) {
        debug(`session_start: failed to restart server: ${err}`);
        ctx.ui.notify(`Failed to start Claude ACP: ${err}`, "error");
      }
    }
  });

  // Auto-restart: before each agent turn, check if the server is still reachable.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "claude-acp") return;
    await ensureServerRunning(ctx.cwd, ctx);
  });

  pi.on("session_shutdown", async () => {
    await stopInstance(inst);
    inst.sessionId = null;
    instances.delete(instanceId);
  });

  // ── Commands ──────────────────────────────────────────────────────
  pi.registerCommand("acp-restart", {
    description: "Restart/start Claude ACP server",
    handler: async (_args, ctx) => {
      await stopInstance(inst);
      const sessionId = inst.sessionId || generateSessionId(ctx.sessionManager.getSessionFile());
      inst.sessionId = sessionId;

      try {
        await startAndRegister(ctx.cwd, sessionId, ctx);
      } catch (err) {
        ctx.ui.notify(`Failed to start: ${err}`, "error");
      }
    }
  });

  pi.registerCommand("acp-stop", {
    description: "Stop Claude ACP server",
    handler: async (_args, ctx) => {
      await stopInstance(inst);
      ctx.ui.notify("Claude ACP stopped", "success");
    }
  });

  pi.registerCommand("acp-status", {
    description: "Show Claude ACP status",
    handler: async (_args, ctx) => {
      const running = inst.process && !inst.process.killed;
      const allInstances = Array.from(instances.entries())
        .map(([id, i]) => `  ${id === instanceId ? ">" : " "} ${id.slice(0, 16)}... port=${i.port} ${i.process && !i.process.killed ? "running" : "stopped"}`)
        .join("\n");
      ctx.ui.notify(
        `${running ? `Running on port ${inst.port}` : "Not running"}\n` +
        `Instance: ${instanceId.slice(0, 16)}...\n` +
        `All instances:\n${allInstances}`,
        "info"
      );
    }
  });

  pi.registerCommand("acp-logs", {
    description: "Show ACP debug logs",
    handler: async (_args, ctx) => {
      const logs: string[] = [];
      try { logs.push(...readFileSync("/tmp/claude-acp-server-debug.log", "utf8").split("\n").slice(-30).filter(l => l.trim())); } catch {}
      try { logs.push(...readFileSync(DEBUG_LOG, "utf8").split("\n").slice(-20).filter(l => l.trim())); } catch {}
      debug(`Logs:\n${logs.join("\n")}`);
      ctx.ui.notify(logs.length ? "Logs written to debug file" : "No logs available", "info");
    }
  });
}
