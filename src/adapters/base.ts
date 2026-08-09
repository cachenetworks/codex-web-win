import type { AdapterEvent, CodexParsedRequest } from "../types";

export interface AdapterTurnErrorDetails {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
}

/**
 * A structured adapter failure that must retain its Responses error semantics
 * after the server has already committed a streaming HTTP response.
 */
export class AdapterTurnError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: AdapterTurnErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AdapterTurnError";
    this.status = details.status;
    this.errorType = details.errorType;
    this.code = details.code;
    this.retryable = details.retryable;
  }
}

export function adapterErrorEvent(error: unknown): Extract<AdapterEvent, { type: "error" }> {
  if (error instanceof AdapterTurnError) {
    return {
      type: "error",
      message: error.message,
      status: error.status,
      errorType: error.errorType,
      code: error.code,
      retryable: error.retryable,
    };
  }
  return { type: "error", message: error instanceof Error ? error.message : String(error) };
}

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
}

export interface ProviderAdapter {
  name: string;
  /** Fail-fast validation that must complete before the server commits an SSE 200 response. */
  validateTurn?(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
  ): void | Promise<void>;
  runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}
