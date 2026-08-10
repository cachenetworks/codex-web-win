import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { atomicWriteFile } from "../../config";
import type { CodexParsedRequest } from "../../types";
import {
  extractChatGptTurnEnvironment,
  extractChatGptTurnIdentity,
  MissingTrustedCodexEnvironmentError,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
} from "./environment";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 512;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;
const sharedStores = new Map<string, ChatGptThreadEnvironmentStore>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathKey(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function absolutePaths(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  const paths = new Map<string, string>();
  for (const path of value) {
    const normalized = resolve(path as string);
    paths.set(pathKey(normalized), normalized);
  }
  return [...paths.values()];
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    if (writableRoots.length !== roots.length || writableRoots.some(path => !roots.some(root => samePath(root, path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    if (typeof parsed.networkAccess !== "boolean") {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: false };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: false };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots", true);
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
  };
}

function clientStorageKey(clientThreadId: string): string {
  // Preserve legacy native thread-id keys so existing version-1 stores remain
  // usable; the stable client identity is an additional alias only.
  return `client:${clientThreadId}`;
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    const storedForThread = identity.threadId ? this.get(identity.threadId) : undefined;
    const storedForClient = !storedForThread && identity.clientThreadId
      ? this.get(clientStorageKey(identity.clientThreadId))
      : undefined;
    const parent = !storedForThread && !storedForClient && identity.parentThreadId
      ? this.get(identity.parentThreadId)
      : undefined;
    // Lineage proves where the child came from, not that it kept the same
    // permissions. Inherit only when current canonical policy independently
    // proves equality; older implementation-only sandbox tags are ambiguous.
    const inheritedFromParent = parent
      && identity.sandboxType
      && identity.sandboxType === parent.sandboxPolicy.type
      ? parent
      : undefined;
    const stored = storedForThread ?? storedForClient ?? inheritedFromParent;
    const storedSource = storedForThread
      ? "thread"
      : storedForClient
        ? "client"
        : inheritedFromParent
          ? "parent"
          : "none";
    console.info(
      `[chatgpt-web] trusted environment store lookup: source=${storedSource} thread_id=${identity.threadId ? "present" : "missing"} client_thread_id=${identity.clientThreadId ? "present" : "missing"} parent_thread_id=${identity.parentThreadId ? "present" : "missing"}`,
    );
    try {
      const environment = extractChatGptTurnEnvironment(parsed, stored);
      if (identity.threadId) this.set(identity.threadId, environment);
      if (identity.clientThreadId) this.set(clientStorageKey(identity.clientThreadId), environment);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError)) throw error;
      if (!stored) throw error;
      if (identity.sandboxType && identity.sandboxType !== stored.sandboxPolicy.type) {
        throw new Error("Codex sandbox policy changed without a trusted environment context");
      }
      const environment = {
        cwd: stored.cwd,
        roots: stored.roots,
        writableRoots: stored.writableRoots,
        sandboxPolicy: stored.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      // A stable client alias can bridge a missing/rotated native thread id.
      // Once a new native id appears, bind it to the same already-trusted
      // authority rather than inventing cwd or permissions.
      if (identity.threadId && !storedForThread) this.set(identity.threadId, environment);
      if (identity.clientThreadId) this.set(clientStorageKey(identity.clientThreadId), environment);
      return environment;
    }
  }
  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment): void {
    this.load();
    this.threads.delete(threadId);
    this.threads.set(threadId, authority(environment, this.now()));
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
    }
    this.persist();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredThreadEnvironmentFile>;
    const rawThreads = record(parsed.threads);
    if (parsed.version !== 1 || !rawThreads) {
      throw new Error(`Invalid ChatGPT thread environment store: ${this.path}`);
    }
    const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
    const entries = Object.entries(rawThreads)
      .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
      .filter(([, environment]) => environment.updatedAt >= cutoff)
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
      .slice(-MAX_THREAD_ENVIRONMENTS);
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

/** One in-memory authority map per durable state file prevents concurrent HTTP
 * adapters from independently loading and last-writer-wins overwriting it. */
export function sharedChatGptThreadEnvironmentStore(path?: string): ChatGptThreadEnvironmentStore {
  if (!path) return new ChatGptThreadEnvironmentStore();
  const normalized = resolve(path);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const existing = sharedStores.get(key);
  if (existing) return existing;
  const created = new ChatGptThreadEnvironmentStore(normalized);
  sharedStores.set(key, created);
  return created;
}
