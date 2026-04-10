import { appendFileSync } from "node:fs";

const DEBUG_LOG = "/tmp/claude-acp-ext-debug.log";

export function debug(msg: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG, `[${ts}] ${msg}\n`);
  } catch {}
}
