import { createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { adapterErrorEvent } from "./adapters/base";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import { readCodexModelContextOverride, type CodexModelContextOverride } from "./codex-integration";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import { forwardNativeCodexRequest, type NativeFetch } from "./native-passthrough";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { normalizeCodexTurnMetadata } from "./responses/turn-metadata";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import { VERSION } from "./version";

export async function shutdownChatGptRuntime(): Promise<void> {
  chatGptTurnSessions.clear();
  await Promise.all([
    closeChatGptBrowserWorkers(),
    closeTurnBrokers(),
  ]);
}

export class HttpTurnCounter {
  private active = 0;

  count(): number {
    return this.active;
  }

  async track(run: () => Promise<Response>): Promise<Response> {
    this.active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };

    try {
      const response = await run();
      if (!response.body) {
        release();
        return response;
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              release();
              controller.close();
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            release();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            release();
          }
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config.proAvailable);
  parsed.modelId = CHATGPT_WEB_BACKEND_MODEL;
  parsed.options.reasoning = route.adapterEffort;
  return route;
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) return upstream;
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-cache, no-store, must-revalidate");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export async function responseRequest(req: Request, config: AppConfig): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses");
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let normalized: unknown;
  try {
    normalized = normalizeCodexTurnMetadata(raw, req.headers);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const expanded = expandPreviousResponseInput(normalized);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    route = routeChatGptWebRequest(parsed, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  if (parsed._compactionRequest === true) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Codex remote compaction is disabled for ChatGPT Web; ChatGPT owns context compaction inside the browser response",
    );
  }

  const adapter = createChatGptWebAdapter(providerConfig(config));
  try {
    await adapter.validateTurn?.(parsed, { headers: req.headers, abortSignal: req.signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Current codex-rs treats a streamed response.failed with an unknown code as
    // retryable. Fail before committing SSE and use its explicit non-retryable
    // invalid_prompt code so a malformed trust envelope does not reconnect 5x.
    return new Response(JSON.stringify({
      error: { message, type: "invalid_request_error", code: "invalid_prompt" },
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => queue.push(event));
    } catch (error) {
      queue.push(adapterErrorEvent(error));
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        onCompletedResponse: response => rememberResponseState(parsed._rawBody, response, { force: true }),
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
  });
  rememberResponseState(parsed._rawBody, json, { force: true });
  return Response.json(json);
}

export async function compactRequest(req: Request, _config: AppConfig): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact");
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  try {
    requireChatGptWebModelRoute(raw.model, _config.proAvailable);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  return formatErrorResponse(
    400,
    "invalid_request_error",
    "Codex remote compaction is disabled for ChatGPT Web; ChatGPT owns context compaction inside the browser response",
  );
}

export interface AppServer {
  readonly port: number;
  setAcceptingTurns(accepting: boolean): void;
  stop(force?: boolean): Promise<void>;
}

export interface StartServerOptions {
  /**
   * Present only for a foreground owner that can shut down its browser and
   * tunnel children. The authenticated route is unavailable otherwise.
   */
  onShutdownRequest?: () => void;
  /**
   * Full-mode foreground owners bind the local proxy before their tunnel is
   * ready. Keep turn routes closed until that owner explicitly marks the
   * complete session ready.
   */
  initialAcceptingTurns?: boolean;
}

function requestHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function webRequest(
  message: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  port: number,
): Request {
  const abort = new AbortController();
  message.once("aborted", () => abort.abort());
  response.once("close", () => {
    if (!response.writableEnded) abort.abort();
  });
  const method = message.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(message) as unknown as BodyInit;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(message),
    signal: abort.signal,
    ...(body ? { body, duplex: "half" as const } : {}),
  };
  return new Request(`http://${config.host}:${port}${message.url ?? "/"}`, init);
}

async function writeWebResponse(
  response: Response,
  outgoing: ServerResponse,
  requestMethod: string | undefined,
): Promise<void> {
  outgoing.statusCode = response.status;
  const cookies = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
  }
  if (cookies.length > 0) outgoing.setHeader("set-cookie", cookies);
  if (requestMethod === "HEAD" || !response.body) {
    outgoing.end();
    return;
  }
  outgoing.flushHeaders();
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    outgoing,
  );
}

export async function startServer(
  config: AppConfig,
  options: StartServerOptions = {},
): Promise<AppServer> {
  const startedAt = Date.now();
  let acceptingTurns = options.initialAcceptingTurns ?? true;
  let listeningPort = config.port;
  let stopPromise: Promise<void> | undefined;
  const httpTurns = new HttpTurnCounter();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount(),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const route = (req: Request): Response | Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return Response.json({
        status: "ok",
        service: "codex-chatgpt-web",
        version: VERSION,
        mode: config.mode,
        pid: process.pid,
        port: listeningPort,
        uptime: (Date.now() - startedAt) / 1_000,
        accepting_turns: acceptingTurns,
        ...activity(),
      });
    }
    if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      acceptingTurns = url.pathname === "/admin/resume";
      return Response.json({ status: "ok", accepting_turns: acceptingTurns, ...activity() });
    }
    if (req.method === "POST" && url.pathname === "/admin/cancel-browser-turns") {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const cancelled = chatGptTurnSessions.clear();
      return Response.json({ status: "ok", cancelled_browser_turns: cancelled, ...activity() });
    }
    if (req.method === "POST" && url.pathname === "/admin/shutdown") {
      if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      if (!options.onShutdownRequest) {
        return Response.json(
          { status: "unavailable", message: "This runtime has no foreground shutdown owner" },
          { status: 409 },
        );
      }
      acceptingTurns = false;
      // Let the acknowledgement flush before the foreground owner closes the
      // HTTP listener. The timer does not keep a stopped runtime alive.
      const shutdownTimer = setTimeout(options.onShutdownRequest, 100);
      shutdownTimer.unref();
      return Response.json(
        { status: "stopping", accepting_turns: false, ...activity() },
        { status: 202 },
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return modelsRequest(req, config, undefined, readCodexModelContextOverride);
    }
    if (req.method === "GET" && url.pathname === "/v1/responses") {
      return new Response("Responses WebSocket transport is not enabled on this local route", {
        status: 426,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (!acceptingTurns) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is not ready to accept turns");
      return httpTurns.track(() => responseRequest(req, config));
    }
    if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
      if (!acceptingTurns) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is not ready to accept turns");
      return httpTurns.track(() => compactRequest(req, config));
    }
    return new Response("Not found", { status: 404 });
  };
  const server: NodeHttpServer = createServer((incoming, outgoing) => {
    void Promise.resolve()
      .then(() => webRequest(incoming, outgoing, config, listeningPort))
      .then(route)
      .then(response => writeWebResponse(response, outgoing, incoming.method))
      .catch(error => {
        if (outgoing.destroyed) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!outgoing.headersSent) {
          outgoing.statusCode = 500;
          outgoing.setHeader("content-type", "application/json");
          outgoing.end(JSON.stringify({ error: { type: "server_error", message } }));
        } else {
          outgoing.destroy(error instanceof Error ? error : new Error(message));
        }
      });
  });
  // Browser turns can run for tens of minutes. Keep header parsing bounded while
  // disabling request and socket inactivity deadlines for active SSE streams.
  server.headersTimeout = 60_000;
  server.requestTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Responses proxy did not bind a TCP port");
  }
  listeningPort = address.port;

  const stop = (force = false): Promise<void> => {
    if (stopPromise) {
      if (force) server.closeAllConnections();
      return stopPromise;
    }
    acceptingTurns = false;
    stopPromise = (async () => {
      const close = new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => {
          if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
          else rejectClose(error);
        });
        if (force) server.closeAllConnections();
      });
      const results = await Promise.allSettled([
        close,
        Promise.resolve().then(() => flushResponseState()),
        shutdownChatGptRuntime(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
      if (failures.length > 0) throw new Error(`shutdown failed: ${failures.join("; ")}`);
    })();
    return stopPromise;
  };
  return {
    port: listeningPort,
    setAcceptingTurns(accepting: boolean): void {
      acceptingTurns = accepting;
    },
    stop,
  };
}
