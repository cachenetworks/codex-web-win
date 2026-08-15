import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expandUserPath, resolveBrokerSocketPath } from "../../config";
import { namespacedToolName, type AdapterEvent, type CodexContentPart, type CodexParsedRequest, type CodexProviderConfig, type CodexToolResultMessage, type CodexUsage } from "../../types";
import { AdapterTurnError, type ProviderAdapter } from "../base";
import { parseDataUrl } from "../image";
import { ChatGptBrowserWorker, DEFAULT_CHATGPT_TOOL_TURN_TIMEOUT_MS, DEFAULT_CHATGPT_TURN_TIMEOUT_MS } from "./browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "./environment";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "./prompt";
import { TurnBroker, type BrokerToolRequest, type BrokerToolResult } from "./turn-broker";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnExecutionKey, chatGptTurnSessions, type ChatGptBrowserOutcome, type ChatGptTraceEvent, type ChatGptTurnRuntime, type ChatGptTurnSession } from "./turn-execution";
import { estimateChatGptWebUsage } from "./usage";
import { sharedChatGptThreadEnvironmentStore } from "./thread-environment";
const CHATGPT_POST_TOOL_YIELD_MS = 650;

function brokerSocketPath(provider: CodexProviderConfig): string {
  return resolveBrokerSocketPath(provider.chatgptWeb?.brokerSocketPath);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function fatalChatGptWebTurnError(error: unknown): AdapterTurnError {
  if (error instanceof AdapterTurnError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AdapterTurnError(message, {
    status: 400,
    errorType: "invalid_request_error",
    code: "invalid_prompt",
    retryable: false,
  }, error instanceof Error ? { cause: error } : undefined);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolveWait, rejectWait) => {
    const onAbort = () => rejectWait(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function brokerResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function emitToolBatch(requests: BrokerToolRequest[], usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  for (const request of requests) {
    emit({ type: "tool_call_start", id: request.callId, name: request.wireName });
    emit({
      type: "tool_call_delta",
      arguments: request.freeform
        ? JSON.stringify({ input: request.input ?? "" })
        : JSON.stringify(request.arguments ?? {}),
    });
    emit({ type: "tool_call_end" });
  }
  emit({ type: "done", stopReason: "tool_use", endTurn: false, usage });
}

function emitBrowserCompletion(outcome: ChatGptBrowserOutcome, usage: CodexUsage, emit: (event: AdapterEvent) => void): void {
  if (outcome.type === "error") throw outcome.error;
  emit({ type: "done", stopReason: "stop", endTurn: true, usage });
}

function emitTraceEvents(trace: ChatGptTraceEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of trace) {
    if (!event.continuation) emit({ type: "assistant_boundary" });
    if (event.kind === "commentary") {
      emit({ type: "text_delta", text: event.text, phase: "commentary" });
    } else {
      emit({ type: "thinking_delta", thinking: `${event.text}\n` });
    }
  }
}

function emitTextDeltas(deltas: string[], emit: (event: AdapterEvent) => void): void {
  for (const text of deltas) emit({ type: "text_delta", text, phase: "final_answer" });
}

function emitReadOnlyContextWarning(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  // Compaction is an internal summarizer exchange. Emitting the normal
  // browser-only warning here would be accumulated into the synthetic compacted
  // summary and pollute every later replay.
  if (parsed._compactionRequest) return;
  const warning = chatGptReadOnlyContextWarning(parsed, capabilities);
  if (!warning) return;
  emit({ type: "assistant_boundary" });
  emit({ type: "text_delta", text: warning, phase: "commentary" });
  emit({ type: "assistant_boundary" });
}

function replayEvents(events: AdapterEvent[], emit: (event: AdapterEvent) => void): void {
  for (const event of events) emit(event);
}

function beginAndReplayActiveRound(
  session: ChatGptTurnSession,
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  emit: (event: AdapterEvent) => void,
): void {
  if (session.beginActiveRound()) {
    emitReadOnlyContextWarning(parsed, capabilities, event => session.appendActiveRoundEvent(event));
  }
  replayEvents(session.eventsForActiveRoundReplay(), emit);
}

function appendTraceToActiveRound(
  session: ChatGptTurnSession,
  trace: ChatGptTraceEvent[],
  emit: (event: AdapterEvent) => void,
): void {
  for (const traceEvent of trace) {
    let attachReasoning = true;
    emitTraceEvents([traceEvent], event => {
      session.appendActiveRoundEvent(event, attachReasoning ? traceEvent.text : undefined);
      attachReasoning = false;
      emit(event);
    });
  }
}

function appendTextToActiveRound(
  session: ChatGptTurnSession,
  deltas: string[],
  emit: (event: AdapterEvent) => void,
): void {
  emitTextDeltas(deltas, event => {
    session.appendActiveRoundEvent(event);
    emit(event);
  });
}

interface CurrentToolResultGroup {
  toolCallId: string;
  messages: CodexToolResultMessage[];
}

function currentToolResultGroups(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): CurrentToolResultGroup[] {
  const byId = new Map<string, CodexToolResultMessage[]>();
  let historicalReplayCount = 0;

  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult") continue;

    // Results for calls already delivered in an earlier provider round are
    // replay history. They are already represented in the browser-side tool
    // conversation and cannot be completed again because the broker invocation
    // has been resolved. Do not confuse that with pruning current results.
    if (!session.hasOutstanding(message.toolCallId)) {
      historicalReplayCount++;
      continue;
    }

    const group = byId.get(message.toolCallId);
    if (group) group.push(message);
    else byId.set(message.toolCallId, [message]);
  }

  const groups = [...byId.entries()].map(([toolCallId, messages]) => ({
    toolCallId,
    messages,
  }));

  const multiResultGroups = groups.filter(group => group.messages.length > 1);
  if (multiResultGroups.length > 0) {
    console.warn(
      `[chatgpt-web] preserving all Codex tool-result variants for ${multiResultGroups.length} outstanding call(s): `
      + multiResultGroups.map(group => `${group.toolCallId.slice(0, 17)}=${group.messages.length}`).join(", "),
    );
  }
  if (historicalReplayCount > 0) {
    console.info(
      `[chatgpt-web] observed ${historicalReplayCount} historical tool-result replay message(s) for calls already completed`,
    );
  }

  return groups;
}

function brokerResultGroup(group: CurrentToolResultGroup): BrokerToolResult {
  if (group.messages.length === 1) return brokerResult(group.messages[0]!);

  const content: unknown[] = [];
  const total = group.messages.length;

  content.push({
    type: "text",
    text:
      `[Bridge note: Codex supplied ${total} result messages for this single tool call. `
      + "No result payload was discarded; every variant follows in original context order.]",
  });

  group.messages.forEach((message, index) => {
    const wireName = namespacedToolName(message.toolNamespace, message.toolName);
    content.push({
      type: "text",
      text:
        `[Codex result ${index + 1}/${total}; tool=${wireName}; `
        + `status=${message.isError ? "error" : "success"}; timestamp=${message.timestamp}]`,
    });
    content.push(...brokerContent(message.content));
  });

  const errorCount = group.messages.filter(message => message.isError).length;
  return {
    content,
    // Mixed success/error variants are preserved as normal content so the model
    // can inspect every observation instead of the whole composite being
    // collapsed into a generic tool failure. Mark error only if ALL variants
    // are errors.
    ...(errorCount === total ? { isError: true } : {}),
    _meta: {
      codexResultCount: total,
      codexErrorResultCount: errorCount,
      preservedAllResultVariants: true,
    },
  };
}
function validateBatchTools(parsed: CodexParsedRequest, requests: BrokerToolRequest[]): void {
  const available = new Set((parsed.context.tools ?? []).map(tool => namespacedToolName(tool.namespace, tool.name)));
  for (const request of requests) {
    if (!available.has(request.wireName)) {
      throw new Error(`ChatGPT requested a tool that the active Codex round did not advertise: ${request.wireName}`);
    }
  }
}

export function createChatGptWebAdapter(provider: CodexProviderConfig): ProviderAdapter {
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const broker = TurnBroker.forSocket(brokerSocketPath(provider));
  const timeoutMs = provider.chatgptWeb?.turnTimeoutMs ?? DEFAULT_CHATGPT_TURN_TIMEOUT_MS;
  const toolTimeoutMs = Math.max(timeoutMs, DEFAULT_CHATGPT_TOOL_TURN_TIMEOUT_MS);
  const capabilities: ChatGptWebCapabilities = {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
  const executionNamespace = createHash("sha256").update(JSON.stringify({
    baseUrl: provider.baseUrl,
    chatgptWeb: provider.chatgptWeb ?? {},
  })).digest("hex");
  const environmentStore = sharedChatGptThreadEnvironmentStore(
    provider.chatgptWeb?.threadEnvironmentStatePath
      ? resolve(expandUserPath(provider.chatgptWeb.threadEnvironmentStatePath))
      : undefined,
  );
  const validatedEnvironments = new WeakMap<CodexParsedRequest, ReturnType<typeof extractChatGptTurnEnvironment> | undefined>();

  const resolveEnvironment = (parsed: CodexParsedRequest): ReturnType<typeof extractChatGptTurnEnvironment> | undefined => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
    if (!mode.localTools) return undefined;
    try {
      return environmentStore.resolve(parsed);
    } catch (error) {
      const identity = extractChatGptTurnIdentity(parsed);
      console.warn(
        `[chatgpt-web] trusted environment unavailable (thread_id=${identity.threadId ? "present" : "missing"}, client_thread_id=${identity.clientThreadId ? "present" : "missing"}, turn_id=${identity.turnId ? "present" : "missing"}, previous_response_id=${parsed.previousResponseId ?? "none"}, replay_prefix_items=${parsed._replayPrefixLen ?? 0}, context_messages=${parsed.context.messages.length})`,
      );
      throw error;
    }
  };

  const startRuntime = (
    parsed: CodexParsedRequest,
    environment: ReturnType<typeof extractChatGptTurnEnvironment> | undefined,
    traceId: string,
  ): ChatGptTurnRuntime => {
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
    const browserAbort = new AbortController();
    const trace = new ChatGptTraceFeed();
    const text = new ChatGptTextFeed();
    if (!mode.localTools) {
      const browser = worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities,
        prepare: async () => ({ ...compileChatGptWebPrompt(parsed, capabilities), release: () => {} }),
        abortSignal: browserAbort.signal,
        onReasoningSummary: text => trace.push({ kind: "reasoning", text }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
      });
      return {
        mode: "read-only",
        browser,
        trace,
        text,
        cancel: () => browserAbort.abort(),
      };
    }
    if (!environment) throw new Error("Tool-capable ChatGPT web mode requires a trusted Codex environment");
    const token = deferred<string>();
    let tokenSettled = false;
    let activeToken: string | undefined;
    const browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      capabilities,
      prepare: async () => {
        const turnToken = await broker.register(environment, toolTimeoutMs + 60_000, traceId);
        activeToken = turnToken;
        tokenSettled = true;
        token.resolve(turnToken);
        try {
          const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
          return { ...compiled, release: () => {} };
        } catch (error) {
          broker.revoke(turnToken);
          throw error;
        }
      },
      abortSignal: browserAbort.signal,
      onReasoningSummary: text => trace.push({ kind: "reasoning", text }),
      onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
      onTextDelta: delta => text.push(delta),
      pendingToolCount: () => activeToken ? broker.pendingToolCount(activeToken) : 0,
      waitForPendingToolCountChange: (previousCount, timeoutMs) => activeToken
        ? broker.waitForPendingToolCountChange(activeToken, previousCount, timeoutMs, browserAbort.signal)
        : Promise.resolve(0),
    });
    void browser.catch(error => {
      if (!tokenSettled) {
        tokenSettled = true;
        token.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return {
      mode: "tools",
      token: token.promise,
      browser,
      trace,
      text,
      cancel: () => {
        browserAbort.abort();
        if (activeToken) broker.revoke(activeToken);
      },
    };
  };

  return {
    name: "chatgpt-web",
    validateTurn(parsed) {
      validatedEnvironments.set(parsed, resolveEnvironment(parsed));
    },
    async runTurn(parsed, incoming, emit) {
      if (incoming.abortSignal?.aborted) throw abortError();
      const environment = validatedEnvironments.has(parsed)
        ? validatedEnvironments.get(parsed)
        : resolveEnvironment(parsed);
      const executionKey = `${executionNamespace}:${chatGptTurnExecutionKey(parsed)}`;
      const traceId = createHash("sha256").update(executionKey).digest("hex").slice(0, 12);
      const session = chatGptTurnSessions.getOrCreate(executionKey, () => startRuntime(parsed, environment, traceId));
      const heartbeat = setInterval(() => emit({ type: "heartbeat" }), 10_000);
      try {
        emit({ type: "heartbeat" });
        await session.runExclusive(async () => {
          const settled = session.settledOutcome();
          if (settled) {
            if (settled.type === "error") throw settled.error;
            let reasoning = session.reasoningForFinalReplay();
            const replay = session.eventsForFinalReplay();
            if (replay.length > 0) {
              replayEvents(replay, emit);
            } else {
              beginAndReplayActiveRound(session, parsed, capabilities, emit);
              const trace = session.runtime.trace.drain();
              appendTraceToActiveRound(session, trace, emit);
              appendTextToActiveRound(session, session.runtime.text.drain(), emit);
              reasoning = session.reasoningForActiveRoundReplay();
              if (session.runtime.text.value() !== settled.answer) {
                throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
              }
              session.setFinalReasoning(reasoning);
              session.setFinalEvents(session.eventsForActiveRoundReplay());
              session.clearActiveRound();
            }
            emitBrowserCompletion(settled, estimateChatGptWebUsage(parsed, { answer: settled.answer, reasoning }, capabilities), emit);
            return;
          }

          let turnToken: string | undefined;
          if (session.runtime.mode === "tools") {
            turnToken = await withAbort(session.runtime.token, incoming.abortSignal);
            if (!environment) throw new Error("Tool-capable ChatGPT web runtime lost its trusted environment");
            broker.updateEnvironment(turnToken, environment);

            const outstanding = session.outstanding();
            if (outstanding.length > 0) {
              const resultGroups = currentToolResultGroups(parsed, session);
              if (resultGroups.length === 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(
                  outstanding,
                  estimateChatGptWebUsage(parsed, { reasoning, toolRequests: outstanding }, capabilities),
                  emit,
                );
                return;
              }

              // Deliver every payload variant observed for each current call as
              // one composite broker completion. The broker protocol resolves
              // one pending Promise per call id, so this preserves all content
              // without inventing duplicate tool invocations.
              for (const group of resultGroups) {
                broker.completeTool(turnToken, group.toolCallId, brokerResultGroup(group));
                session.markResultDelivered(group.toolCallId);
              }

              // Codex can reconstruct parallel tool batches incrementally.
              // Consume whichever results are present and replay only the calls
              // that are genuinely still outstanding instead of requiring the
              // whole parallel batch to arrive in one request.
              const remaining = session.outstanding();
              if (remaining.length > 0) {
                const reasoning = session.reasoningForOutstandingReplay();
                replayEvents(session.eventsForOutstandingReplay(), emit);
                emitToolBatch(
                  remaining,
                  estimateChatGptWebUsage(parsed, { reasoning, toolRequests: remaining }, capabilities),
                  emit,
                );
                return;
              }

              // The broker completions above have already returned the real
              // local results to ChatGPT. Pause only before accepting a NEW
              // substantive batch so the browser model gets an old-style
              // continuation/commentary opportunity instead of immediately
              // disappearing into another silent tool round.
              console.info(
                "[chatgpt-web] completed Codex tool batch; yielding to ChatGPT for visible commentary before the next tool batch",
              );
              await new Promise(resolveYield => setTimeout(resolveYield, CHATGPT_POST_TOOL_YIELD_MS));
            }
          } else if (session.outstanding().length > 0) {
            throw new Error("Read-only ChatGPT Web runtime cannot own local tool calls");
          }

          const toolWaitAbort = new AbortController();
          try {
            beginAndReplayActiveRound(session, parsed, capabilities, emit);
            const emitNewTrace = (trace: ChatGptTraceEvent[]) => appendTraceToActiveRound(session, trace, emit);
            const emitNewText = (deltas: string[]) => appendTextToActiveRound(session, deltas, emit);
            emitNewTrace(session.runtime.trace.drain());
            emitNewText(session.runtime.text.drain());
            if (session.runtime.mode === "tools") {
              console.info("[chatgpt-web] draining browser continuation after tool-result yield");
            }
            const stagedTools = session.stagedTools();
            const nextTools = turnToken
              ? stagedTools.length > 0
                ? Promise.resolve({ type: "tools" as const })
                : broker.nextToolBatch(turnToken, toolWaitAbort.signal).then(requests => {
                    // Stage before the request-scoped abort race observes this promise. If the
                    // transport detaches at the same moment, the broker's destructive dequeue is
                    // still owned by the session and the replacement request can claim it.
                    session.stageToolBatch(requests);
                    return { type: "tools" as const };
                  })
              : undefined;
            const browserOutcome = session.browserOutcome.then(outcome => ({ type: "browser" as const, outcome }));
            let nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
            let nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
            for (;;) {
              const next = await withAbort(
                Promise.race([
                  ...(nextTools ? [nextTools] : []),
                  browserOutcome,
                  nextTrace,
                  nextText,
                ]),
                incoming.abortSignal,
              );
              if (next.type === "trace") {
                emitNewTrace(session.runtime.trace.drain());
                nextTrace = session.runtime.trace.wait(toolWaitAbort.signal).then(() => ({ type: "trace" as const }));
                continue;
              }
              if (next.type === "text") {
                emitNewText(session.runtime.text.drain());
                nextText = session.runtime.text.wait(toolWaitAbort.signal).then(() => ({ type: "text" as const }));
                continue;
              }
              emitNewTrace(session.runtime.trace.drain());
              emitNewText(session.runtime.text.drain());
              if (next.type === "browser") {
                const roundReasoning = session.reasoningForActiveRoundReplay();
                session.setFinalReasoning(roundReasoning);
                session.setFinalEvents(session.eventsForActiveRoundReplay());
                session.clearActiveRound();
                if (turnToken) broker.revoke(turnToken);
                if (next.outcome.type === "error") throw next.outcome.error;
                if (session.runtime.text.value() !== next.outcome.answer) {
                  throw new Error("ChatGPT browser Markdown stream did not reproduce the completed answer");
                }
                emitBrowserCompletion(
                  next.outcome,
                  estimateChatGptWebUsage(parsed, { answer: next.outcome.answer, reasoning: roundReasoning }, capabilities),
                  emit,
                );
                return;
              }
              if (!turnToken || session.runtime.mode !== "tools") {
                throw new Error("Read-only ChatGPT Web runtime received a broker tool batch");
              }
              const requests = session.takeStagedToolBatch();
              if (requests.length === 0) throw new Error("ChatGPT tool bridge returned an empty batch");
              validateBatchTools(parsed, requests);
              const roundReasoning = session.reasoningForActiveRoundReplay();
              const roundEvents = session.eventsForActiveRoundReplay();
              session.setOutstanding(requests, roundReasoning, roundEvents);
              session.clearActiveRound();
              emitToolBatch(
                requests,
                estimateChatGptWebUsage(parsed, { reasoning: roundReasoning, toolRequests: requests }, capabilities),
                emit,
              );
              return;
            }
          } finally {
            toolWaitAbort.abort();
          }
        });
      } catch (error) {
        if (incoming.abortSignal?.aborted && isAbortError(error)) throw error;
        session.cancel();
        if (session.runtime.mode === "tools") {
          void session.runtime.token.then(turnToken => broker.revoke(turnToken)).catch(() => {});
        }
        if (incoming.abortSignal?.aborted || isAbortError(error)) throw error;
        throw fatalChatGptWebTurnError(error);
      } finally {
        clearInterval(heartbeat);
      }
    },
  };
}
