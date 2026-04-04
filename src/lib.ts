import { loadServerConfig } from "./configs.js";
import { AnthropicHttpServer } from "./logic/anthropic-api/server.js";
import { AnthropicAcpFacade } from "./logic/anthropic-api/facade.js";
import { AnthropicPromptTranslator } from "./logic/anthropic-api/translator.js";
import { AcpBackendManager } from "./logic/acp-client/backend-manager.js";
import type { FacadeHttpServer, Logger } from "./interfaces.js";
import type { ServerConfig } from "./types.js";

export function createFacadeServer(
  config: ServerConfig = loadServerConfig(),
  logger: Logger = console,
): FacadeHttpServer {
  const backend = new AcpBackendManager(config, logger);
  const translator = new AnthropicPromptTranslator();
  const facade = new AnthropicAcpFacade(backend, translator, config, logger);
  const server = new AnthropicHttpServer(facade, config, logger);

  return {
    listen: async () => {
      await backend.initialize();
      return server.listen();
    },
    close: async () => {
      await backend.close();
      await server.close();
    },
  };
}

export { AcpBackendManager } from "./logic/acp-client/backend-manager.js";
export { AnthropicAcpFacade } from "./logic/anthropic-api/facade.js";
export { AnthropicHttpServer } from "./logic/anthropic-api/server.js";
export { AnthropicPromptTranslator } from "./logic/anthropic-api/translator.js";
export { loadServerConfig } from "./configs.js";
export type * from "./types.js";
export type * from "./interfaces.js";
