#!/usr/bin/env node

import { createFacadeServer, loadServerConfig } from "./lib.js";

const config = loadServerConfig();
const server = createFacadeServer(config, console);

const running = await server.listen();
console.log(
  `[claude-acp-server] listening on http://${running.address.address}:${running.address.port}`,
);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
