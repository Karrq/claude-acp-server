import { HttpError } from "../../helpers/errors.js";

/**
 * Per-client state. Any API key is accepted as a client identity.
 * Sessions are scoped per-client so one client can't hijack another's session.
 */
interface ClientRecord {
  activeSessionId: string | null;
  ownedSessions: Set<string>;
}

/**
 * Tracks per-client session ownership using the API key as identity.
 *
 * Any API key is accepted on first use and gets a client record.
 * Session scoping: a client can only resume sessions it created.
 */
export class ClientRegistry {
  private clients = new Map<string, ClientRecord>();

  /**
   * Get or create a client record for the given API key.
   */
  authenticate(apiKey: string): ClientRecord {
    let client = this.clients.get(apiKey);
    if (!client) {
      client = { activeSessionId: null, ownedSessions: new Set() };
      this.clients.set(apiKey, client);
    }
    return client;
  }

  /**
   * Resolve which ACP session to use for this request.
   *
   * Priority:
   * 1. Explicit x-acp-session-id (validated for ownership)
   * 2. Client's active session (from previous requests)
   * 3. undefined (caller should create a new session)
   */
  resolveSessionId(client: ClientRecord, requestedSessionId: string | undefined): string | undefined {
    if (requestedSessionId) {
      if (!client.ownedSessions.has(requestedSessionId)) {
        throw new HttpError({
          status: 403,
          type: "authentication_error",
          message: "Session does not belong to this client.",
        });
      }
      return requestedSessionId;
    }
    return client.activeSessionId ?? undefined;
  }

  /**
   * Record that a session was created or used by a client.
   */
  recordSession(client: ClientRecord, sessionId: string): void {
    client.ownedSessions.add(sessionId);
    client.activeSessionId = sessionId;
  }
}
