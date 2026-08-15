import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { extractChatGptTurnIdentity } from "./environment";

const MAX_ACTIVE_ROUND_EVENTS = 100_000;
const MAX_ACTIVE_ROUND_BYTES = 16 * 1024 * 1024;

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    this.queued.push(normalizedEvent);
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  /** Compatibility helper. Adapter streaming uses notification-only `wait` so abort races cannot consume an event. */
  async next(signal?: AbortSignal): Promise<ChatGptTraceEvent> {
    await this.wait(signal);
    const queued = this.queued.shift();
    if (queued === undefined) throw new Error("ChatGPT trace notification arrived without a queued event");
    return queued;
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private readonly textChunks: string[] = [];
  private cachedText?: string;

  push(delta: string): void {
    if (!delta) return;
    // Keep deltas as chunks while the browser is streaming. Repeatedly doing
    // `text += delta` makes a long answer form an ever-growing string/rope that
    // eventually has to be flattened; joining once at settlement is cheaper and
    // keeps peak copying lower on memory-constrained machines.
    this.textChunks.push(delta);
    this.cachedText = undefined;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.cachedText ??= this.textChunks.join("");
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  cancel: () => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string> })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId && !parsed._compactionRequest) {
    throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  }
  // Compaction is an independent summarizer exchange. Some Codex compact
  // transports omit turn_id, and a v2 compaction subrequest may reuse the parent
  // turn id. Give it a distinct deterministic key so it never reattaches to an
  // in-flight browser/tool session for the real task turn.
  const payload = parsed._compactionRequest
    ? {
        compaction: true,
        threadId: identity.threadId,
        turnId: identity.turnId,
        requestHash: createHash("sha256").update(JSON.stringify(parsed._rawBody ?? {})).digest("hex"),
      }
    : { threadId: identity.threadId, turnId: identity.turnId };
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

export class ChatGptTurnSession {
  readonly createdAt = Date.now();
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private stagedToolBatch?: BrokerToolRequest[];
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private activeRound?: { events: AdapterEvent[]; reasoning: string[]; bytes: number };
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly runtime: ChatGptTurnRuntime) {
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  /**
   * Begin one provider round, or resume the journal left by a detached HTTP/SSE request.
   * Returns true only for a new round so one-shot prelude events are not appended twice.
   */
  beginActiveRound(): boolean {
    if (this.activeRound) return false;
    this.activeRound = { events: [], reasoning: [], bytes: 0 };
    return true;
  }

  appendActiveRoundEvent(event: AdapterEvent, reasoning?: string): void {
    if (!this.activeRound) throw new Error("cannot append an event before beginning the ChatGPT provider round");
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    const reasoningBytes = reasoning ? Buffer.byteLength(reasoning, "utf8") : 0;
    const nextBytes = this.activeRound.bytes + eventBytes + reasoningBytes;
    if (this.activeRound.events.length >= MAX_ACTIVE_ROUND_EVENTS || nextBytes > MAX_ACTIVE_ROUND_BYTES) {
      throw new Error("ChatGPT browser replay journal exceeded its bounded 16 MiB/100000-event limit");
    }
    this.activeRound.events.push(event);
    if (reasoning !== undefined) this.activeRound.reasoning.push(reasoning);
    this.activeRound.bytes = nextBytes;
  }

  eventsForActiveRoundReplay(): AdapterEvent[] {
    return [...(this.activeRound?.events ?? [])];
  }

  reasoningForActiveRoundReplay(): string[] {
    return [...(this.activeRound?.reasoning ?? [])];
  }

  clearActiveRound(): void {
    this.activeRound = undefined;
  }

  stageToolBatch(requests: BrokerToolRequest[]): void {
    if (this.stagedToolBatch || this.outstandingById.size > 0) {
      throw new Error("cannot stage a ChatGPT tool batch while another batch is pending");
    }
    this.stagedToolBatch = [...requests];
  }

  stagedTools(): BrokerToolRequest[] {
    return [...(this.stagedToolBatch ?? [])];
  }

  takeStagedToolBatch(): BrokerToolRequest[] {
    const requests = this.stagedToolBatch;
    if (!requests) throw new Error("ChatGPT tool batch was delivered without being staged");
    this.stagedToolBatch = undefined;
    return requests;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  cancel(): void {
    this.runtime.cancel();
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();

  constructor(
    private readonly ttlMs = 4 * 60 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(key: string, start: () => ChatGptTurnRuntime): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) return existing;
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start());
    this.entries.set(key, session);
    return session;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    return cancelled;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      // Browser/broker runtimes own active-turn timeouts. Registry TTL only
      // cleans up old settled sessions; it must not cancel legitimate work.
      if (session.createdAt >= cutoff || session.isActive()) continue;
      session.cancel();
      this.entries.delete(key);
    }
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
