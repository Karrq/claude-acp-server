import { debug } from "./debug-log.js";

export interface AcpModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const DEFAULT_MODELS: AcpModelConfig[] = [
  {
    id: "default",
    name: "Claude ACP",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,
  },
];

export async function fetchModelsFromBackend(
  port: number,
  apiKey: string,
): Promise<AcpModelConfig[]> {
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
    const body = (await res.json()) as {
      data?: { id: string; display_name?: string }[];
    };
    const models = body.data ?? [];
    debug(
      `fetchModelsFromBackend: got ${models.length} models: ${models.map((m) => m.id).join(", ")}`,
    );
    return models.map((m) => ({
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
