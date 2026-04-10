import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import {
  highlightCode,
  getLanguageFromPath,
  keyHint,
} from "@mariozechner/pi-coding-agent";
import { randomBytes } from "node:crypto";
import {
  debug,
  readToolResult,
  getOrCreateInstance,
  deleteInstance,
  generateSessionId,
  startServerAndFetchModels,
  stopInstance,
  isServerReachable,
  stripHostAgentContext,
  type AcpInstance,
} from "../shared/index.js";

// ── Tool rendering helpers ───────────────────────────────────────────
// Mimics Pi's built-in tool renderers for the 6 ACP tools.
import { homedir } from "node:os";

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

  const edits = args?.edits;
  if (Array.isArray(edits) && edits.length > 0) {
    text += theme.fg("muted", ` (${edits.length} edit${edits.length > 1 ? "s" : ""})`);
  } else {
    const oldText = str(args?.oldText);
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
  return theme.fg("toolTitle", theme.bold("glob")) +
    " " +
    (pattern === null ? theme.fg("error", "[invalid arg]") : theme.fg("accent", pattern || "")) +
    theme.fg("toolOutput", ` in ${path === null ? "." : path}`);
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
  if (context.isError) {
    const errorText = (result.content?.[0]?.text ?? "").trim();
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(errorText ? `\n${theme.fg("error", errorText)}` : "");
    return text;
  }
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
  if (context.isError) {
    const errorText = (result.content?.[0]?.text ?? "").trim();
    const text = context.lastComponent ?? new Text("", 0, 0);
    text.setText(errorText ? `\n${theme.fg("error", errorText)}` : "");
    return text;
  }
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

// ── Pi extension entry point ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const instanceId = `pi-${process.pid}-${randomBytes(4).toString("hex")}`;
  const inst = getOrCreateInstance(instanceId);

  async function startAndRegister(cwd: string, sessionId: string, ctx: any): Promise<void> {
    const result = await startServerAndFetchModels(cwd, sessionId, inst);
    const { port, apiKey, models } = result;

    debug(`startAndRegister: registering provider with ${models.length} models: ${models.map(m => m.id).join(", ")}`);

    try { pi.unregisterProvider("claude-acp"); } catch {}
    pi.registerProvider("claude-acp", {
      baseUrl: `http://127.0.0.1:${port}`,
      api: "anthropic-messages",
      apiKey,
      models,
    });

    const modelNames = models.map(m => m.name || m.id).join(", ");
    ctx.ui.notify(`Claude ACP ready on port ${port} (${models.length} models: ${modelNames})`, "success");
  }

  async function ensureRunning(cwd: string, ctx: any): Promise<void> {
    const { restarted, models } = await ensureServerRunning(
      cwd,
      inst,
      () => inst.sessionId || generateSessionId(ctx.sessionManager?.getSessionFile()),
    );
    if (restarted) {
      ctx.ui.notify("Claude ACP server unreachable, restarting...", "warning");
      if (models.length > 0) {
        try { pi.unregisterProvider("claude-acp"); } catch {}
        pi.registerProvider("claude-acp", {
          baseUrl: `http://127.0.0.1:${inst.port}`,
          api: "anthropic-messages",
          apiKey: inst.apiKey!,
          models,
        });
      }
    }
  }

  // ── Register ACP tools with open schemas ────────────────────────────
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
    if (ctx.model?.provider !== "claude-acp") return;
    return stripHostAgentContext(event.payload);
  });

  // ── Register provider (placeholder until server starts) ───────────
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
      maxTokens: 16384,
    }],
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

  pi.on("before_agent_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "claude-acp") return;
    await ensureRunning(ctx.cwd, ctx);
  });

  pi.on("session_shutdown", async () => {
    await stopInstance(inst);
    inst.sessionId = null;
    deleteInstance(instanceId);
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
    },
  });

  pi.registerCommand("acp-stop", {
    description: "Stop Claude ACP server",
    handler: async (_args, ctx) => {
      await stopInstance(inst);
      ctx.ui.notify("Claude ACP stopped", "success");
    },
  });

  pi.registerCommand("acp-status", {
    description: "Show Claude ACP status",
    handler: async (_args, ctx) => {
      const running = inst.process && !inst.process.killed;
      const allInstances = Array.from(getInstances().entries())
        .map(([id, i]) => `  ${id === instanceId ? ">" : " "} ${id.slice(0, 16)}... port=${i.port} ${i.process && !i.process.killed ? "running" : "stopped"}`)
        .join("\n");
      ctx.ui.notify(
        `${running ? `Running on port ${inst.port}` : "Not running"}\n` +
        `Instance: ${instanceId.slice(0, 16)}...\n` +
        `All instances:\n${allInstances}`,
        "info",
      );
    },
  });

  pi.registerCommand("acp-logs", {
    description: "Show ACP debug logs",
    handler: async (_args, ctx) => {
      const { readFileSync: readLogs } = await import("node:fs");
      const logs: string[] = [];
      try { logs.push(...readLogs("/tmp/claude-acp-server-debug.log", "utf8").split("\n").slice(-30).filter(l => l.trim())); } catch {}
      try { logs.push(...readLogs("/tmp/claude-acp-ext-debug.log", "utf8").split("\n").slice(-20).filter(l => l.trim())); } catch {}
      debug(`Logs:\n${logs.join("\n")}`);
      ctx.ui.notify(logs.length ? "Logs written to debug file" : "No logs available", "info");
    },
  });
}
