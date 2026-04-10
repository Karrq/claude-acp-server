import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { highlightCode, getLanguageFromPath, keyHint } from "@mariozechner/pi-coding-agent";
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

// Global state
let serverProcess: ChildProcess | null = null;
let serverPort = 14319;
let ephemeralApiKey: string | null = null;
let currentSessionId: string | null = null;
let mcpDir: string | null = null;
let appendSystemContent: string | null = null;

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

async function startServer(cwd: string, sessionId: string): Promise<{ port: number; apiKey: string; process: ChildProcess }> {
  debug(`startServer: cwd=${cwd} sessionId=${sessionId} serverPort=${serverPort}`);
  
  // Free the port by killing anything still bound to it (handles orphans from
  // crashed Pi sessions that stopServer couldn't clean up).
  try {
    const { execSync } = require("node:child_process");
    const result = execSync(`lsof -ti :${serverPort} 2>/dev/null`, { encoding: "utf8" }).trim();
    if (result) {
      for (const pid of result.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
      debug(`startServer: killed processes on port ${serverPort}: ${result}`);
    }
  } catch {}
  
  const port = await findFreePort(serverPort);
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

async function stopServer(): Promise<void> {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 500));
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    serverProcess = null;
    ephemeralApiKey = null;
  }
  // Kill ALL lingering ACP server processes (not just the one we tracked)
  // This handles orphans from previous Pi sessions or extension reloads.
  try {
    const { execSync } = require("node:child_process");
    // Kill by the server script path — matches any node process running our server
    const result = execSync(
      `pgrep -f "node.*claude-acp-server-fork/dist/index.js" 2>/dev/null`,
      { encoding: "utf8" }
    ).trim();
    if (result) {
      for (const pid of result.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
          debug(`Killed orphan ACP server PID ${pid}`);
        } catch {}
      }
    }
  } catch {}
  // Also free up the port if anything survived
  try {
    const { execSync } = require("node:child_process");
    const result = execSync(`lsof -ti :${serverPort} 2>/dev/null`, { encoding: "utf8" }).trim();
    if (result) {
      for (const pid of result.split("\n").filter(Boolean)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
      debug(`Killed lingering processes on port ${serverPort}: ${result}`);
    }
  } catch {}
  if (mcpDir) {
    try { rmSync(mcpDir, { recursive: true }); } catch {}
    mcpDir = null;
  }
  clearToolResults();
}

export default function (pi: ExtensionAPI) {
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

  // ── Strip Pi context from ACP requests ─────────────────────────────
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload;
    
    if (ctx.model?.provider !== "claude-acp") return;
    
    debug(`=== REQUEST === model=${(payload as any).model} msgs=${payload.messages?.length} tools=${payload.tools?.length}`);
    
    if (payload.messages && payload.messages.length > 0) {
      const lastMsg = payload.messages[payload.messages.length - 1];
      const lastContent = Array.isArray(lastMsg.content) 
        ? lastMsg.content.map((b: any) => b.type).join(", ")
        : typeof lastMsg.content === "string" ? "text" : "unknown";
      debug(`Last msg: role=${lastMsg.role} types=[${lastContent}]`);
      
      if (lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
        const hasToolResult = lastMsg.content.some((b: any) => b.type === "tool_result");
        const hasUserText = lastMsg.content.some((b: any) => b.type === "text" && b.text?.trim());
        debug(`tool_result=${hasToolResult} user_text=${hasUserText}`);
      }
    }
    
    // Remove Pi system prompt
    if (payload.system) {
      delete payload.system;
      debug("Stripped system prompt");
    }
    
    // Clear Pi tools
    if (payload.tools && Array.isArray(payload.tools)) {
      payload.tools = [];
    }
    
    return payload;
  });

  // ── Register provider ─────────────────────────────────────────────
  pi.registerProvider("claude-acp", {
    baseUrl: "http://127.0.0.1:1",
    api: "anthropic-messages",
    apiKey: "not-started",
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
      await stopServer();
      ctx.ui.notify("Claude ACP stopped", "info");
      return;
    }
    
    if (isAcp && !wasAcp) {
      try {
        const sessionId = currentSessionId || generateSessionId(ctx.sessionManager.getSessionFile());
        currentSessionId = sessionId;
        debug(`Session ID: ${sessionId.slice(0, 32)}`);

        const { port, apiKey, process: proc } = await startServer(ctx.cwd, sessionId);
        serverProcess = proc;
        serverPort = port;
        ephemeralApiKey = apiKey;

        pi.unregisterProvider("claude-acp");
        pi.registerProvider("claude-acp", {
          baseUrl: `http://127.0.0.1:${port}`,
          api: "anthropic-messages",
          apiKey: apiKey,
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

        ctx.ui.notify(`Claude ACP ready on port ${port}`, "success");
      } catch (err) {
        debug(`Failed to start: ${err}`);
        ctx.ui.notify(`Failed to start Claude ACP: ${err}`, "error");
      }
    }
  });
  
  // Kill any orphan ACP servers from previous sessions on startup
  pi.on("session_start", async () => {
    try {
      const { execSync } = require("node:child_process");
      const result = execSync(
        `pgrep -f "node.*claude-acp-server-fork/dist/index.js" 2>/dev/null`,
        { encoding: "utf8" }
      ).trim();
      if (result) {
        for (const pid of result.split("\n").filter(Boolean)) {
          try { process.kill(Number(pid), "SIGKILL"); } catch {}
        }
        debug(`session_start: killed orphan ACP servers: ${result}`);
      }
    } catch {}
  });

  pi.on("session_shutdown", async () => {
    await stopServer();
    currentSessionId = null;
  });
  
  // ── Commands ──────────────────────────────────────────────────────
  pi.registerCommand("acp-restart", {
    description: "Restart/start Claude ACP server",
    handler: async (_args, ctx) => {
      if (serverProcess && !serverProcess.killed) await stopServer();
      const sessionId = currentSessionId || generateSessionId(ctx.sessionManager.getSessionFile());
      currentSessionId = sessionId;
      
      try {
        const { port, apiKey, process: proc } = await startServer(ctx.cwd, sessionId);
        serverProcess = proc;
        serverPort = port;
        ephemeralApiKey = apiKey;

        try { pi.unregisterProvider("claude-acp"); } catch {}
        pi.registerProvider("claude-acp", {
          baseUrl: `http://127.0.0.1:${port}`,
          api: "anthropic-messages",
          apiKey,
          models: [{ id: "default", name: "Claude ACP", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 }]
        });

        ctx.ui.notify(`Claude ACP restarted on port ${port}`, "success");
      } catch (err) {
        ctx.ui.notify(`Failed to start: ${err}`, "error");
      }
    }
  });
  
  pi.registerCommand("acp-stop", {
    description: "Stop Claude ACP server",
    handler: async (_args, ctx) => {
      await stopServer();
      ctx.ui.notify("Claude ACP stopped", "success");
    }
  });
  
  pi.registerCommand("acp-status", {
    description: "Show Claude ACP status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(serverProcess && !serverProcess.killed ? `Running on port ${serverPort}` : "Not running", "info");
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
