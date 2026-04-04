import { RequestError } from "@agentclientprotocol/sdk";
import type { HttpErrorPayload } from "../types.js";

export class HttpError extends Error {
  readonly status: number;
  readonly type: HttpErrorPayload["type"];
  readonly details?: unknown;

  constructor(payload: HttpErrorPayload) {
    super(payload.message);
    this.name = "HttpError";
    this.status = payload.status;
    this.type = payload.type;
    this.details = payload.details;
  }
}

export function requireAnthropicHeaders(
  headers: Headers,
  expectedVersion: string,
  apiKey?: string,
): void {
  const version = headers.get("anthropic-version");
  if (!version) {
    throw new HttpError({
      status: 400,
      type: "invalid_request_error",
      message: "Missing anthropic-version header.",
    });
  }

  if (version !== expectedVersion) {
    throw new HttpError({
      status: 400,
      type: "invalid_request_error",
      message: `Unsupported anthropic-version: ${version}. Expected ${expectedVersion}.`,
    });
  }

  const providedKey =
    headers.get("x-api-key") ??
    headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();

  if (!providedKey) {
    throw new HttpError({
      status: 401,
      type: "authentication_error",
      message: "Missing API key. Provide x-api-key or Authorization: Bearer <key>.",
    });
  }

  if (apiKey && providedKey !== apiKey) {
    throw new HttpError({
      status: 401,
      type: "authentication_error",
      message: "Invalid API key.",
    });
  }
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }

  if (error instanceof RequestError) {
    switch (error.code) {
      case -32000:
        return new HttpError({
          status: 401,
          type: "authentication_error",
          message: error.message,
          details: error.data,
        });
      case -32002:
        return new HttpError({
          status: 404,
          type: "not_found_error",
          message: error.message,
          details: error.data,
        });
      case -32602:
        return new HttpError({
          status: 400,
          type: "invalid_request_error",
          message: error.message,
          details: error.data,
        });
      default:
        return new HttpError({
          status: 500,
          type: "api_error",
          message: error.message,
          details: error.data,
        });
    }
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const raw = error as { code: number; message: string; data?: unknown };
    return toHttpError(new RequestError(raw.code, raw.message, raw.data));
  }

  return new HttpError({
    status: 500,
    type: "api_error",
    message: error instanceof Error ? error.message : "Unexpected server error.",
  });
}

export function anthropicErrorBody(error: HttpError, requestId: string) {
  return {
    type: "error",
    error: {
      type: error.type,
      message: error.message,
    },
    request_id: requestId,
    ...(error.details !== undefined ? { details: error.details } : {}),
  };
}
