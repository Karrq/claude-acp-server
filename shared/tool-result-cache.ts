import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const RESULTS_DIR = "/tmp/claude-acp-tool-results";

export interface ToolResultData {
  text: string;
  is_error: boolean;
  details: Record<string, unknown>;
}

export function storeToolResult(toolCallId: string, result: string | ToolResultData): void {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, `${toolCallId}.json`), JSON.stringify(result));
  } catch {}
}

export function readToolResult(toolCallId: string): ToolResultData | null {
  try {
    const p = join(RESULTS_DIR, `${toolCallId}.json`);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      if (typeof raw === "string") return { text: raw, is_error: false, details: {} };
      return {
        text: raw.text || "",
        is_error: !!raw.is_error,
        details: raw.details || {},
      };
    }
  } catch {}
  return null;
}

export function clearToolResults(): void {
  try {
    rmSync(RESULTS_DIR, { recursive: true });
  } catch {}
}
