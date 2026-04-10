/**
 * OpenClaw provider plugin for claude-acp-server.
 *
 * Build note: When packaging as an installable OpenClaw plugin, add
 * `openclaw/plugin-sdk` and `@sinclair/typebox` as peerDependencies
 * and use the real imports instead of the inline stubs below.
 * The inline approach lets this file compile standalone in the repo.
 */

import { randomBytes } from "node:crypto";
import {
  debug,
  readToolResult,
  getOrCreateInstance,
  deleteInstance,
  getInstances,
  generateSessionId,
  startServerAndFetchModels,
  stopInstance,
  isServerReachable,
  ensureServerRunning,
  stripHostAgentContext,
  type AcpInstance,
  type ServerStartOptions,
} from "../shared/index.js";

const PROVIDER_ID = "claude-acp";

// ── Inline type stubs (replace with openclaw/plugin-sdk in hosted builds) ──

type PluginAPI = {
  getConfig(): Record<string, unknown> | null;
  registerProvider(provider: Record<string, unknown>): void;
  updateProvider(id: string, update: Record<string, unknown>): void;
  registerTool(tool: Record<string, unknown>): void;
  registerCommand(name: string, cmd: Record<string, unknown>): void;
  registerHook(
    event: string,
    handler: (event: any, ctx: any) => Promise<any>,
  ): void;
};

// ── Plugin entry ──────────────────────────────────────────────────────

export default {
  id: "claude-acp",
  name: "Claude ACP Provider",
  description:
    "OpenClaw provider plugin for claude-acp-server — runs Claude Code via the ACP protocol behind an Anthropic-compatible HTTP facade",

  register(api: PluginAPI) {
    const instanceId = `openclaw-${process.pid}-${randomBytes(4).toString("hex")}`;
    const inst = getOrCreateInstance(instanceId);

    function getServerOptions(): ServerStartOptions {
      const cfg = api.getConfig();
      return {
        backendCommand: (cfg?.backendCommand as string) || undefined,
        backendArgs: (cfg?.backendArgs as string) || undefined,
        serverDistPath: (cfg?.serverDistPath as string) || undefined,
      };
    }

    // ── Register ACP tools ──────────────────────────────────────────
    const toolNames = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];

    for (const name of toolNames) {
      api.registerTool({
        name,
        description: `Already executed by Claude Code (ACP proxy)`,
        parameters: { type: "object", additionalProperties: true },
        async execute(toolCallId: string, _params: unknown) {
          let cached = readToolResult(toolCallId);
          for (let i = 0; !cached && i < 50; i++) {
            await new Promise((r) => setTimeout(r, 100));
            cached = readToolResult(toolCallId);
          }
          const isHit = cached !== null;
          const isError = cached?.is_error ?? false;
          debug(
            `Tool ${name} (${toolCallId}): ${isHit ? (isError ? "error" : "hit") : "miss"}`,
          );
          return {
            content: [{ type: "text" as const, text: cached?.text || "" }],
            ...(isError && { is_error: true }),
          };
        },
      });
    }

    // ── Register provider ────────────────────────────────────────────
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Claude ACP",
      docsPath: "/providers/claude-acp",
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx: any) => {
          // If a server is already running for this instance, use it
          if (
            inst.apiKey &&
            inst.port &&
            (await isServerReachable(inst))
          ) {
            const { fetchModelsFromBackend } = await import(
              "../shared/model-fetcher.js"
            );
            const models = await fetchModelsFromBackend(
              inst.port,
              inst.apiKey,
            );
            if (models.length > 0) {
              return {
                provider: {
                  baseUrl: `http://127.0.0.1:${inst.port}`,
                  apiKey: inst.apiKey,
                  api: "anthropic-messages",
                  models,
                },
              };
            }
          }

          // Placeholder until the server starts on model selection
          return {
            provider: {
              baseUrl: "http://127.0.0.1:1",
              apiKey: "not-started",
              api: "anthropic-messages",
              models: [
                {
                  id: "default",
                  name: "Claude ACP",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 200000,
                  maxTokens: 16384,
                },
              ],
            },
          };
        },
      },
    });

    // ── Hook: strip host-agent context before forwarding ────────────
    api.registerHook("before_provider_request", async (event: any, ctx: any) => {
      if (ctx.model?.provider !== PROVIDER_ID) return;
      return stripHostAgentContext(
        event.payload as Record<string, unknown>,
      );
    });

    // ── Hook: start server when model is selected ───────────────────
    api.registerHook("model_select", async (event: any, ctx: any) => {
      const wasAcp = event.previousModel?.provider === PROVIDER_ID;
      const isAcp = event.model?.provider === PROVIDER_ID;

      if (wasAcp && !isAcp) {
        await stopInstance(inst);
        return;
      }

      if (isAcp && !wasAcp) {
        try {
          const sessionId =
            inst.sessionId ||
            generateSessionId(ctx.sessionManager?.getSessionFile());
          inst.sessionId = sessionId;
          const result = await startServerAndFetchModels(
            ctx.cwd,
            sessionId,
            inst,
            getServerOptions(),
          );

          api.updateProvider(PROVIDER_ID, {
            baseUrl: `http://127.0.0.1:${result.port}`,
            apiKey: result.apiKey,
            api: "anthropic-messages",
            models: result.models,
          });
        } catch (err) {
          debug(`Failed to start ACP server: ${err}`);
        }
      }
    });

    // ── Hook: restart on session start if model is already ACP ──────
    api.registerHook("session_start", async (_event: any, ctx: any) => {
      if (ctx.model?.provider !== PROVIDER_ID) return;
      const sessionId = generateSessionId(
        ctx.sessionManager?.getSessionFile(),
      );
      inst.sessionId = sessionId;
      try {
        const result = await startServerAndFetchModels(
          ctx.cwd,
          sessionId,
          inst,
          getServerOptions(),
        );
        api.updateProvider(PROVIDER_ID, {
          baseUrl: `http://127.0.0.1:${result.port}`,
          apiKey: result.apiKey,
          api: "anthropic-messages",
          models: result.models,
        });
      } catch (err) {
        debug(`session_start: failed to start ACP server: ${err}`);
      }
    });

    // ── Hook: auto-restart before each turn ─────────────────────────
    api.registerHook(
      "before_agent_start",
      async (_event: any, ctx: any) => {
        if (ctx.model?.provider !== PROVIDER_ID) return;
        const { restarted, models } = await ensureServerRunning(
          ctx.cwd,
          inst,
          () =>
            inst.sessionId ||
            generateSessionId(ctx.sessionManager?.getSessionFile()),
          getServerOptions(),
        );
        if (restarted && models.length > 0) {
          api.updateProvider(PROVIDER_ID, {
            baseUrl: `http://127.0.0.1:${inst.port}`,
            apiKey: inst.apiKey!,
            api: "anthropic-messages",
            models,
          });
        }
      },
    );

    // ── Hook: cleanup on session shutdown ───────────────────────────
    api.registerHook("session_shutdown", async () => {
      await stopInstance(inst);
      inst.sessionId = null;
      deleteInstance(instanceId);
    });

    // ── Commands ────────────────────────────────────────────────────
    api.registerCommand("acp-restart", {
      description: "Restart/start the Claude ACP server",
      handler: async (_args: any, ctx: any) => {
        await stopInstance(inst);
        const sessionId =
          inst.sessionId ||
          generateSessionId(ctx.sessionManager?.getSessionFile());
        inst.sessionId = sessionId;
        try {
          const result = await startServerAndFetchModels(
            ctx.cwd,
            sessionId,
            inst,
            getServerOptions(),
          );
          api.updateProvider(PROVIDER_ID, {
            baseUrl: `http://127.0.0.1:${result.port}`,
            apiKey: result.apiKey,
            api: "anthropic-messages",
            models: result.models,
          });
        } catch (err) {
          debug(`acp-restart failed: ${err}`);
        }
      },
    });

    api.registerCommand("acp-stop", {
      description: "Stop the Claude ACP server",
      handler: async () => {
        await stopInstance(inst);
      },
    });

    api.registerCommand("acp-status", {
      description: "Show Claude ACP server status",
      handler: async () => {
        const running = inst.process && !inst.process.killed;
        const allInstances = Array.from(getInstances().entries())
          .map(
            ([id, i]) =>
              `  ${id === instanceId ? ">" : " "} ${id.slice(0, 16)}... port=${i.port} ${i.process && !i.process.killed ? "running" : "stopped"}`,
          )
          .join("\n");
        return `${running ? `Running on port ${inst.port}` : "Not running"}\nInstance: ${instanceId.slice(0, 16)}...\nAll instances:\n${allInstances}`;
      },
    });
  },
};
