import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { BRIDGE_COMPACTION_READ_WIRE, readLocalCompactionSnapshot } from "../../responses/compaction-snapshot";
import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt: number };
}

interface ResolvedTurn {
  environment: ChatGptTurnEnvironment & { expiresAt: number };
}

const bindingSchema = z.string().min(20).max(256).describe("Opaque binding_id returned by codex_bind_turn.");
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
export const SHARED_TUNNEL_ROUTE_MISS = "CODEX_SHARED_TUNNEL_ROUTE_MISS";

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function requestOwnershipScopeKey(extra: { sessionId?: string; _meta?: unknown }): string | undefined {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? extra._meta as Record<string, unknown>
    : undefined;
  const openAiSession = typeof meta?.["openai/session"] === "string" ? meta["openai/session"] : undefined;
  const source = extra.sessionId || openAiSession;
  return source ? scopeHash(source) : undefined;
}

export function isPotentialNonOwnerBrokerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // Only capability lookup misses are ambiguous under redundant tunnel
  // pollers. Broker availability/timeouts are real local failures and must not
  // be disguised as routing misses.
  return /turn token is invalid, expired, or revoked|binding id is invalid or expired/i.test(message);
}

export function shouldReroutePotentialNonOwner(error: unknown, capabilityOwnedHere: boolean): boolean {
  return isPotentialNonOwnerBrokerError(error) && !capabilityOwnedHere;
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
}): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

/**
 * Native Codex function tools have historically been advertised either at the
 * top level or under the built-in `functions` namespace. Treat those two wire
 * shapes as equivalent for the dedicated bridge wrappers. Arbitrary MCP/app
 * namespaces stay isolated so a third-party tool cannot accidentally satisfy a
 * native capability check merely by reusing a name such as `exec_command`.
 */
function nativeFunctionTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => (
    tool.name === name
    && tool.freeform !== true
    && (!tool.namespace || tool.namespace === "functions")
  ));
}

function namedTool(environment: ChatGptTurnEnvironment, requestedWireName: string): CodexTool {
  const tool = environment.tools.find(candidate => wireName(candidate) === requestedWireName);
  if (!tool) throw new Error(`Codex tool is not available in this turn: ${requestedWireName}`);
  return tool;
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt: number }): number {
  return Math.max(1, environment.expiresAt - Date.now());
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  // Responses Lite may advertise the built-in freeform gateway either at the
  // top level or inside the default `functions` namespace. Do not accept an
  // arbitrary app/MCP namespace merely because it also contains `exec`.
  return environment.tools.find(tool => (
    tool.name === "exec"
    && tool.freeform === true
    && (!tool.namespace || tool.namespace === "functions")
  ));
}

export interface GatewayNestedTool {
  wireName: string;
  description: string;
  declaration?: string;
  freeform: boolean;
}

// The outer Codex tool registry is stable for one bound turn. A one-second
// cache caused repeated ALL_TOOLS probes whenever the web model paused between
// inventory and invocation, wasting both latency and web-context tokens. Keep a
// modest cache while still fingerprinting the directly advertised tool set so
// environment/tool changes naturally invalidate it.
const GATEWAY_INVENTORY_CACHE_TTL_MS = 60_000;

export function shellCommandInvocationArgs(options: {
  cmd: string;
  workdir?: string;
  yieldTimeMs?: number;
  timeoutMs?: number;
  resumable?: boolean;
}): Record<string, unknown> {
  // `shell_command.timeout_ms` is a hard runtime deadline, while Codex's
  // `yield_time_ms` is only a request to hand back a resumable session early.
  // A yield request must never shorten the command lifetime. Older Windows
  // harnesses expose `shell_command` without a resumable wait cell and otherwise
  // inherit a very short native timeout, which makes healthy builds look frozen
  // or fail at roughly the requested yield interval. Use the bridge's maximum
  // command budget unless the caller explicitly supplied a hard deadline.
  const timeoutMs = options.timeoutMs ?? 300_000;
  return {
    command: options.cmd,
    ...(options.workdir ? { workdir: options.workdir } : {}),
    timeout_ms: timeoutMs,
  };
}

function gatewayNestedToolFromSection(wireName: string, section: string): GatewayNestedTool {
  const declaration = /exec tool declaration:\s*```(?:ts|typescript)?\s*([\s\S]*?)```/i.exec(section)?.[1]?.trim();
  const description = section.split(/\r?\n\s*exec tool declaration:/i, 1)[0]!.trim();
  return {
    wireName,
    description,
    ...(declaration ? { declaration } : {}),
    freeform: /\bFREEFORM\s+tool\b/i.test(section),
  };
}

/**
 * Newer Codex harnesses expose most native/app/MCP tools behind one freeform `exec`
 * gateway instead of putting every tool in the top-level Responses tool list. The
 * gateway description is generated from the live registry and contains one
 * `### `<tool>` section per nested tool, followed by its TypeScript declaration.
 *
 * Keep this parser deliberately conservative: only markdown headings shaped exactly
 * like tool headings are considered. In particular, the prose example near the top
 * of the gateway currently mentions `tools.exec_command(...)` even on harnesses whose
 * actual command tool is `shell_command`, so substring matching would select a tool
 * that does not exist.
 */
export function gatewayNestedTools(environment: ChatGptTurnEnvironment): GatewayNestedTool[] {
  const gateway = execGateway(environment);
  if (!gateway?.description) return [];

  const source = gateway.description;
  const heading = /^### `([^`\r\n]+)`\s*$/gm;
  const matches = [...source.matchAll(heading)];
  const tools: GatewayNestedTool[] = [];

  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const wireName = match[1]!.trim();
    if (!wireName) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? source.length;
    const section = source.slice(start, end).trim();
    tools.push(gatewayNestedToolFromSection(wireName, section));
  }

  return tools;
}

export function parseGatewayRuntimeTools(value: unknown): GatewayNestedTool[] {
  if (!Array.isArray(value)) return [];
  const tools: GatewayNestedTool[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !candidate.name.trim()) continue;
    if (typeof candidate.description !== "string") continue;
    tools.push(gatewayNestedToolFromSection(candidate.name.trim(), candidate.description));
  }
  return tools;
}

function gatewayNestedTool(environment: ChatGptTurnEnvironment, wireName: string): GatewayNestedTool | undefined {
  return gatewayNestedTools(environment).find(tool => tool.wireName === wireName);
}

export function resolveCommandToolName(environment: ChatGptTurnEnvironment): "exec_command" | "shell_command" | undefined {
  return resolveCommandToolNameFromInventory(environment, gatewayNestedTools(environment));
}

export function resolveCommandToolNameFromInventory(
  environment: ChatGptTurnEnvironment,
  nestedTools: GatewayNestedTool[],
): "exec_command" | "shell_command" | undefined {
  if (nativeFunctionTool(environment, "exec_command")) return "exec_command";
  if (nativeFunctionTool(environment, "shell_command")) return "shell_command";
  if (nestedTools.some(tool => tool.wireName === "exec_command")) return "exec_command";
  if (nestedTools.some(tool => tool.wireName === "shell_command")) return "shell_command";
  return undefined;
}

export function resolveSessionContinuationToolName(
  environment: ChatGptTurnEnvironment,
): "write_stdin" | "wait" | undefined {
  return resolveSessionContinuationToolNameFromInventory(environment, gatewayNestedTools(environment));
}

export function resolveSessionContinuationToolNameFromInventory(
  environment: ChatGptTurnEnvironment,
  nestedTools: GatewayNestedTool[],
): "write_stdin" | "wait" | undefined {
  if (nativeFunctionTool(environment, "write_stdin")) return "write_stdin";
  if (nativeFunctionTool(environment, "wait")) return "wait";
  if (nestedTools.some(tool => tool.wireName === "write_stdin")) return "write_stdin";
  if (nestedTools.some(tool => tool.wireName === "wait")) return "wait";
  return undefined;
}

export function yieldedSessionId(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") continue;
    // Only trust the native exec status line itself. Command output can legitimately
    // contain this phrase (for example when reading our own tests or docs); an
    // unanchored match turns that ordinary output into a fake resumable session and
    // hides the real command result from the web model. Exclude backslashes too so
    // escaped "\\n" text cannot become part of a synthetic cell id.
    const match = /^\s*Script running with cell ID\s+([^\s.\\]+)/i.exec(block.text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function withYieldedSessionId<T extends { content?: unknown; structuredContent?: Record<string, unknown> }>(value: T): T {
  const sessionId = yieldedSessionId(value.content);
  if (!sessionId) return value;
  return {
    ...value,
    structuredContent: {
      ...(value.structuredContent ?? {}),
      session_id: /^\d+$/.test(sessionId) ? Number(sessionId) : sessionId,
    },
  };
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

export function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  options: { yieldTimeMs?: number; maxOutputTokens?: number } = {},
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  const execOptions = {
    ...(options.yieldTimeMs !== undefined ? { yield_time_ms: options.yieldTimeMs } : {}),
    ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
  };
  return [
    ...(Object.keys(execOptions).length > 0 ? [`// @exec: ${JSON.stringify(execOptions)}`] : []),
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

export function execGatewayCommandProgram(options: {
  cmd: string;
  workdir?: string;
  yieldTimeMs?: number;
  timeoutMs?: number;
  maxOutputTokens?: number;
  tty?: boolean;
}): string {
  const continuationOutputTokens = options.maxOutputTokens ?? 10_000;
  const execArguments = {
    cmd: options.cmd,
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.yieldTimeMs !== undefined ? { yield_time_ms: options.yieldTimeMs } : {}),
    ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
    ...(options.tty !== undefined ? { tty: options.tty } : {}),
  };
  const shellArguments = shellCommandInvocationArgs({
    cmd: options.cmd,
    ...(options.workdir ? { workdir: options.workdir } : {}),
    ...(options.yieldTimeMs !== undefined ? { yieldTimeMs: options.yieldTimeMs } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const execOptions = {
    ...(options.yieldTimeMs !== undefined ? { yield_time_ms: options.yieldTimeMs } : {}),
    ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
  };
  return [
    ...(Object.keys(execOptions).length > 0 ? [`// @exec: ${JSON.stringify(execOptions)}`] : []),
    "const commandNames = new Set(ALL_TOOLS.map(tool => tool.name));",
    "const commandName = commandNames.has(\"exec_command\") ? \"exec_command\" : commandNames.has(\"shell_command\") ? \"shell_command\" : undefined;",
    "if (!commandName) throw new Error(\"This Codex turn has no exec_command or shell_command in the native exec gateway\");",
    `const commandArguments = commandName === "exec_command" ? ${JSON.stringify(execArguments)} : ${JSON.stringify(shellArguments)};`,
    "let commandResult = await tools[commandName](commandArguments);",
    "const commandOutput = [];",
    "const captureCommandOutput = value => {",
    "  if (value && typeof value === \"object\" && typeof value.output === \"string\" && value.output.length > 0) commandOutput.push(value.output);",
    "};",
    "captureCommandOutput(commandResult);",
    "while (commandResult && typeof commandResult === \"object\" && commandResult.session_id !== undefined) {",
    "  const commandSessionId = commandResult.session_id;",
    "  if (commandNames.has(\"write_stdin\")) {",
    `    commandResult = await tools.write_stdin({ session_id: commandSessionId, chars: "", yield_time_ms: 30000, max_output_tokens: ${continuationOutputTokens} });`,
    "  } else if (commandNames.has(\"wait\")) {",
    `    commandResult = await tools.wait({ cell_id: String(commandSessionId), yield_time_ms: 30000, max_tokens: ${continuationOutputTokens} });`,
    "  } else {",
    "    throw new Error(\"Native command yielded a session but the exec gateway exposes no write_stdin/wait continuation tool\");",
    "  }",
    "  captureCommandOutput(commandResult);",
    "}",
    "const result = commandOutput.length > 0 && commandResult && typeof commandResult === \"object\"",
    "  ? { ...commandResult, output: commandOutput.join(\"\") }",
    "  : commandResult;",
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

export function waitCellInvocationArgs(options: {
  sessionId: string | number;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
  terminate?: boolean;
}): Record<string, unknown> {
  return {
    cell_id: String(options.sessionId),
    ...(options.yieldTimeMs !== undefined ? { yield_time_ms: options.yieldTimeMs } : {}),
    ...(options.maxOutputTokens !== undefined ? { max_tokens: options.maxOutputTokens } : {}),
    ...(options.terminate !== undefined ? { terminate: options.terminate } : {}),
  };
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "codex-native", version: "4.0.0" });
  // A connector/session id is broader than one Codex turn. In redundant
  // same-tunnel deployments the same ChatGPT session can legitimately dispatch
  // consecutive turns to different machines, so remembering ownership by MCP
  // session scope causes false "local expiry" classifications on non-owners.
  // Track only capabilities this exact broker process has successfully claimed.
  // Hashes avoid retaining bearer capability values in the MCP child longer than
  // the broker needs them.
  const ownedTurnTokens = new Map<string, number>();
  const ownedBindingIds = new Map<string, number>();
  const gatewayInventoryCache = new Map<string, {
    fingerprint: string;
    createdAt: number;
    tools: Promise<GatewayNestedTool[]>;
  }>();

  const capabilityKey = (value: string) => createHash("sha256").update(value).digest("hex");

  const pruneOwnedCapabilities = () => {
    const now = Date.now();
    for (const [key, expiresAt] of ownedTurnTokens) {
      if (expiresAt <= now) ownedTurnTokens.delete(key);
    }
    for (const [key, expiresAt] of ownedBindingIds) {
      if (expiresAt <= now) ownedBindingIds.delete(key);
    }
  };

  const rememberOwnedCapability = (store: Map<string, number>, value: string, expiresAt: number) => {
    pruneOwnedCapabilities();
    store.set(capabilityKey(value), expiresAt);
  };

  const ownsCapability = (store: Map<string, number>, value: string): boolean => {
    pruneOwnedCapabilities();
    return store.has(capabilityKey(value));
  };

  const reroutePotentialNonOwner = (
    error: unknown,
    extra: { sessionId?: string; _meta?: unknown },
    capabilityOwnedHere: boolean,
  ): unknown => {
    if (!shouldReroutePotentialNonOwner(error, capabilityOwnedHere)) return error;
    const scopeKey = requestOwnershipScopeKey(extra);
    console.warn(`[chatgpt-web-mcp] shared-tunnel route miss scope=${scopeKey ?? "unknown"}`);
    return new Error(
      `${SHARED_TUNNEL_ROUTE_MISS}: this tunnel-client process does not own the Codex turn for scope=${scopeKey ?? "unknown"}. `
      + "Retry the exact same Codex Native tool call unchanged; a fresh tunnel command can be claimed by the owning redundant poller. "
      + "Do not regenerate or alter turn_token or binding_id. A miss immediately after a local tunnel/MCP restart can be a stale in-flight call; "
      + "if repeated misses persist without a restart, verify that no other computer is polling this tunnel. Each concurrently running computer "
      + "still needs its own tunnel ID and uniquely named ChatGPT custom app/connector.",
    );
  };

  const environment = async (
    bindingId: string,
    extra: { signal?: AbortSignal; sessionId?: string; _meta?: unknown },
  ): Promise<ChatGptTurnEnvironment & { expiresAt: number }> => {
    let resolved: ResolvedTurn;
    try {
      resolved = await callTurnBroker<ResolvedTurn>(options.brokerSocketPath, { method: "resolve", bindingId });
    } catch (error) {
      throw reroutePotentialNonOwner(error, extra, ownsCapability(ownedBindingIds, bindingId));
    }
    if (resolved.environment.expiresAt <= Date.now()) throw new Error("Codex turn binding expired");
    rememberOwnedCapability(ownedBindingIds, bindingId, resolved.environment.expiresAt);
    return resolved.environment;
  };

  const invokeRaw = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ): Promise<BrokerToolResult> => callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
      method: "invoke",
      bindingId,
      wireName: wireName(tool),
      freeform: tool.freeform === true,
      ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    }, invocationTimeout(bound));

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => asMcpResult(await invokeRaw(bindingId, bound, tool, payload));

  const discoverGatewayTools = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
  ): Promise<GatewayNestedTool[]> => {
    const fingerprint = createHash("sha256").update(JSON.stringify(bound.tools.map(tool => ({
      wireName: wireName(tool),
      description: tool.description,
      parameters: tool.parameters,
      freeform: tool.freeform === true,
      toolSearch: tool.toolSearch === true,
    })))).digest("hex");
    const cached = gatewayInventoryCache.get(bindingId);
    if (cached
      && cached.fingerprint === fingerprint
      && Date.now() - cached.createdAt < GATEWAY_INVENTORY_CACHE_TTL_MS) return cached.tools;
    const pending = (async () => {
      const fallback = gatewayNestedTools(bound);
      const gateway = execGateway(bound);
      if (!gateway) return fallback;
      try {
        const response = await invokeRaw(bindingId, bound, gateway, {
          input: "text(ALL_TOOLS.map(tool => ({ name: tool.name, description: tool.description })));",
        });
        const textBlock = response.content.find((item): item is { type: string; text: string } => (
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
          && (item as Record<string, unknown>).type === "text"
          && typeof (item as Record<string, unknown>).text === "string"
        ));
        if (!textBlock) return fallback;
        const runtime = parseGatewayRuntimeTools(JSON.parse(textBlock.text));
        if (runtime.length === 0) return fallback;
        const merged = new Map(fallback.map(tool => [tool.wireName, tool]));
        for (const tool of runtime) {
          const existing = merged.get(tool.wireName);
          merged.set(tool.wireName, existing
            ? {
                ...tool,
                description: tool.description || existing.description,
                declaration: tool.declaration ?? existing.declaration,
                freeform: tool.freeform || existing.freeform,
              }
            : tool);
        }
        return [...merged.values()];
      } catch {
        return fallback;
      }
    })();
    gatewayInventoryCache.set(bindingId, { fingerprint, createdAt: Date.now(), tools: pending });
    return pending;
  };

  const invokeNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => invoke(bindingId, bound, tool, payload);

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    options: { yieldTimeMs?: number; maxOutputTokens?: number } = {},
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, options),
    });
  };

  server.registerTool(
    "codex_bind_turn",
    {
      title: "Bind this response to its Codex turn",
      description: "Idempotently claim the capability for the current outer Codex turn before calling its native tools.",
      inputSchema: { turn_token: z.string().min(20).max(256) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token }, extra) => {
      console.error(`[chatgpt-web-mcp] codex_bind_turn scope=${requestScopeSummary(extra)}`);
      let claimed: ClaimedTurn;
      try {
        claimed = await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, { method: "claim", token: turn_token });
      } catch (error) {
        throw reroutePotentialNonOwner(error, extra, ownsCapability(ownedTurnTokens, turn_token));
      }
      rememberOwnedCapability(ownedTurnTokens, turn_token, claimed.environment.expiresAt);
      rememberOwnedCapability(ownedBindingIds, claimed.bindingId, claimed.environment.expiresAt);
      const commandTool = nativeFunctionTool(claimed.environment, "exec_command") ?? nativeFunctionTool(claimed.environment, "shell_command");
      const gateway = execGateway(claimed.environment);
      // Keep binding a pure ownership/capability handshake. Live ALL_TOOLS
      // discovery can execute a nested native round and previously made the
      // mandatory bootstrap vulnerable to long tool-registry stalls. Inventory
      // still performs live discovery on demand; bind reports the declarations
      // already advertised by the gateway without blocking on another call.
      const discovered = gateway ? gatewayNestedTools(claimed.environment) : [];
      const commandToolName = resolveCommandToolNameFromInventory(claimed.environment, discovered);
      const directToolNames = new Set(claimed.environment.tools.map(tool => wireName(tool)));
      const nestedToolNames = new Set(discovered
        .map(tool => tool.wireName)
        .filter(name => !directToolNames.has(name)));
      const hasWireTool = (name: string) => directToolNames.has(name) || nestedToolNames.has(name);
      const hasNativeFunction = (name: string) => Boolean(
        nativeFunctionTool(claimed.environment, name) ?? discovered.find(tool => tool.wireName === name),
      );
      const capabilities = ["native_tool_loop", "tool_registry"];
      // The exec gateway can defer its nested registry instead of spelling every
      // tool out in its markdown description. The dedicated wrappers discover
      // command/apply-patch tools inside that gateway at invocation time, so do
      // not make the web model incorrectly conclude that local work is impossible.
      if (commandToolName || gateway) capabilities.push("exec");
      if (hasNativeFunction("write_stdin") || hasNativeFunction("wait")) capabilities.push("session_history");
      if (hasNativeFunction("wait")) capabilities.push("session_termination");
      if (hasWireTool("apply_patch") || gateway) capabilities.push("apply_patch");
      if (hasNativeFunction("view_image")) capabilities.push("images");
      if (hasNativeFunction("request_user_input")) capabilities.push("user_input");
      if (hasNativeFunction("update_plan")) capabilities.push("planning");
      if (hasWireTool("web__run")) capabilities.push("web");
      if (hasWireTool("list_mcp_resources") && hasWireTool("read_mcp_resource")) capabilities.push("mcp_resources");
      if (hasWireTool("collaboration__spawn_agent")) capabilities.push("collaboration");
      if (hasWireTool("create_goal") && hasWireTool("update_goal")) capabilities.push("goals");
      return result({
        binding_id: claimed.bindingId,
        harness_version: 4,
        execution: "outer_codex_native",
        cwd: claimed.environment.cwd,
        roots: claimed.environment.roots,
        writable_roots: claimed.environment.writableRoots,
        sandbox: claimed.environment.sandboxPolicy.type,
        expires_at: new Date(claimed.environment.expiresAt).toISOString(),
        tool_count: directToolNames.size + nestedToolNames.size,
        direct_tool_count: directToolNames.size,
        nested_tool_count: nestedToolNames.size,
        command_tool: commandTool ? wireName(commandTool) : commandToolName ?? (gateway ? "deferred" : null),
        outer_tool_gateway: gateway ? wireName(gateway) : null,
        capabilities,
      authorization: {
        sandbox: claimed.environment.sandboxPolicy.type,
        local_mutations_preapproved: claimed.environment.sandboxPolicy.type === "dangerFullAccess",
        permission_source: "trusted_outer_codex_environment",
        note: claimed.environment.sandboxPolicy.type === "dangerFullAccess"
          ? "Ordinary local development commands and mutations needed for the active task are already authorized by the user. Real native runtime refusals remain authoritative."
          : "Honor the writable roots and sandbox restrictions reported above.",
      },
      });
    },
  );

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: "Invoke the command tool advertised by the current outer Codex harness. Permission is governed by the trusted bound Codex environment; dangerFullAccess pre-authorizes ordinary task-required local development commands and mutations, while real native runtime refusals/approvals remain authoritative. A long-running command returns its native session_id when the outer harness supports resumable sessions; otherwise use timeout_ms for a blocking command.",
      inputSchema: {
        binding_id: bindingSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        timeout_ms: z.number().int().min(1_000).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, cmd, workdir, yield_time_ms, timeout_ms, max_output_tokens, tty }, extra) => {
      console.error(`[chatgpt-web-mcp] codex_exec scope=${requestScopeSummary(extra)}`);
      const bound = await environment(binding_id, extra);
      const tool = nativeFunctionTool(bound, "exec_command") ?? nativeFunctionTool(bound, "shell_command");
      if (tool) {
        const args = tool.name === "exec_command"
          ? {
              cmd,
              ...(workdir ? { workdir } : {}),
              ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
              ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
              ...(tty !== undefined ? { tty } : {}),
            }
          : shellCommandInvocationArgs({
              cmd,
              ...(workdir ? { workdir } : {}),
              ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
              ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
            });
        return withYieldedSessionId(await invokeNative(binding_id, bound, tool, { arguments: args }));
      }

      const gateway = execGateway(bound);
      if (!gateway) throw new Error("This Codex turn did not advertise exec_command, shell_command, or a compatible native exec gateway");
      // Discover and execute in one native gateway round. This avoids a separate
      // ALL_TOOLS probe whose failure used to erase command capability on some
      // Windows harness/plugin combinations even though the command tool existed.
      const response = invokeNative(binding_id, bound, gateway, {
        input: execGatewayCommandProgram({
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
          ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
          ...(max_output_tokens !== undefined ? { maxOutputTokens: max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
        }),
      });
      return withYieldedSessionId(await response);
    },
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: "Write characters to, poll, or terminate a session_id returned by codex_exec or codex_tool_call. Harnesses exposing a wait/cell primitive support polling/termination but not stdin writes.",
      inputSchema: {
        binding_id: bindingSchema,
        session_id: z.union([z.number().int().nonnegative(), z.string().min(1).max(256)]),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        terminate: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, session_id, chars, yield_time_ms, max_output_tokens, terminate }, extra) => {
      const bound = await environment(binding_id, extra);
      const tool = nativeFunctionTool(bound, "write_stdin");
      const directWait = tool ? undefined : nativeFunctionTool(bound, "wait");
      const declared = tool || directWait ? [] : gatewayNestedTools(bound);
      const declaredContinuation = tool || directWait
        ? undefined
        : resolveSessionContinuationToolNameFromInventory(bound, declared);
      const discovered = tool || directWait || declaredContinuation ? declared : await discoverGatewayTools(binding_id, bound);
      const nestedWrite = discovered.find(candidate => candidate.wireName === "write_stdin");
      const nestedWait = nestedWrite ? undefined : discovered.find(candidate => candidate.wireName === "wait");
      if (!tool && !directWait && !nestedWrite && !nestedWait) {
        throw new Error(
          "This Codex harness has no resumable write_stdin or wait/cell capability. Run the command with codex_exec timeout_ms instead, and call codex_write_stdin only when codex_exec actually returned a session_id.",
        );
      }

      const waitMode = Boolean(directWait || nestedWait);
      if (waitMode && chars !== undefined && chars.length > 0) {
        throw new Error("This Codex harness exposes polling-only wait cells; it cannot write stdin to the yielded command");
      }
      if (waitMode) {
        const waitPayload = { arguments: waitCellInvocationArgs({
          sessionId: session_id,
          ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { maxOutputTokens: max_output_tokens } : {}),
          ...(terminate !== undefined ? { terminate } : {}),
        }) };
        const response = directWait
          ? invokeNative(binding_id, bound, directWait, waitPayload)
          : invokeNestedNative(binding_id, bound, "wait", false, waitPayload);
        return withYieldedSessionId(await response);
      }
      if (terminate) {
        throw new Error("This Codex harness exposes write_stdin but not a wait/cell termination primitive");
      }
      const payload = { arguments: {
        session_id,
        ...(chars !== undefined ? { chars } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
      } };
      return tool
        ? invokeNative(binding_id, bound, tool, payload)
        : invokeNestedNative(binding_id, bound, "write_stdin", false, payload);
    },
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task. When the trusted bound environment is dangerFullAccess, task-required project edits are already locally authorized; real native runtime refusals remain authoritative.",
      inputSchema: { binding_id: bindingSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, patch }, extra) => {
      const bound = await environment(binding_id, extra);
      const tool = exactTool(bound, "apply_patch");
      if (!tool) return invokeNestedNative(binding_id, bound, "apply_patch", true, { input: patch });
      return tool.freeform
        ? invokeNative(binding_id, bound, tool, { input: patch })
        : invokeNative(binding_id, bound, tool, { arguments: { input: patch } });
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response.",
      inputSchema: {
        binding_id: bindingSchema,
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, path, detail }, extra) => {
      const bound = await environment(binding_id, extra);
      const tool = nativeFunctionTool(bound, "view_image");
      const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
      return tool
        ? invokeNative(binding_id, bound, tool, payload)
        : invokeNestedNative(binding_id, bound, "view_image", false, payload);
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        binding_id: bindingSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, query, offset, limit, include_schema }, extra) => {
      const bound = await environment(binding_id, extra);
      const direct = bound.tools.map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: tool.description,
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: tool.parameters } : {}),
      }));
      const directNames = new Set(direct.map(tool => tool.wire_name));
      const mapNested = (tools: GatewayNestedTool[]) => tools
        .filter(tool => !directNames.has(tool.wireName))
        .map(tool => ({
          wire_name: tool.wireName,
          name: tool.wireName,
          namespace: null,
          description: tool.description,
          kind: tool.freeform ? "freeform" : "function",
          ...(include_schema && tool.freeform
            ? { parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } }
            : {}),
          ...(include_schema && tool.declaration ? { declaration: tool.declaration } : {}),
        }));
      const declaredNested = mapNested(gatewayNestedTools(bound));
      const needle = query?.trim().toLowerCase();
      // Exact-name lookups are the dominant model path and are already complete
      // when the tool is directly advertised or present in the gateway
      // declaration. Avoid a full deferred ALL_TOOLS round in that case.
      const exactKnown = needle
        ? [...direct, ...declaredNested].filter(tool => (
            tool.wire_name.toLowerCase() === needle || tool.name.toLowerCase() === needle
          ))
        : [];
      if (exactKnown.length > 0) {
        const page = exactKnown.slice(offset, offset + limit);
        return result({
          tools: page,
          total: exactKnown.length,
          next_offset: offset + page.length < exactKnown.length ? offset + page.length : null,
        });
      }
      const nested = mapNested(await discoverGatewayTools(binding_id, bound));
      const matches = [...direct, ...nested].filter(tool => !needle || [
        tool.wire_name,
        tool.name,
        tool.namespace ?? "",
        tool.description,
        "declaration" in tool ? tool.declaration ?? "" : "",
      ].join("\n").toLowerCase().includes(needle));
      const page = matches.slice(offset, offset + limit);
      return result({
        tools: page,
        total: matches.length,
        next_offset: offset + page.length < matches.length ? offset + page.length : null,
      });
    },
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
      inputSchema: {
        binding_id: bindingSchema,
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ binding_id, wire_name, arguments: args, input, yield_time_ms, max_output_tokens }, extra) => {
      const bound = await environment(binding_id, extra);

      // V15.1 bridge-private history recovery. This stays behind the existing
      // codex_tool_call schema, so the ChatGPT plugin does not gain a new action.
      if (wire_name === BRIDGE_COMPACTION_READ_WIRE) {
        if (input !== undefined) {
          throw new Error(`${BRIDGE_COMPACTION_READ_WIRE} accepts JSON arguments, not freeform input`);
        }
        const snapshotId = typeof args?.snapshot_id === "string" ? args.snapshot_id : "";
        const query = typeof args?.query === "string" ? args.query : undefined;
        const offset = typeof args?.offset === "number" ? args.offset : undefined;
        const maxChars = typeof args?.max_chars === "number" ? args.max_chars : undefined;
        const page = await readLocalCompactionSnapshot({
          snapshotId,
          ...(query !== undefined ? { query } : {}),
          ...(offset !== undefined ? { offset } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });
        return result({ bridge_tool: BRIDGE_COMPACTION_READ_WIRE, read_only: true, ...page });
      }
      const tool = bound.tools.find(candidate => wireName(candidate) === wire_name);
      const declaredNested = tool ? undefined : gatewayNestedTool(bound, wire_name);
      const nested = tool
        ? undefined
        : declaredNested ?? (await discoverGatewayTools(binding_id, bound)).find(candidate => candidate.wireName === wire_name);
      if (!tool && !nested) throw new Error(`Codex tool is not available in this turn: ${wire_name}`);
      const freeform = tool?.freeform === true || nested?.freeform === true;
      if (freeform) {
        if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
        const response = tool
          ? invokeNative(binding_id, bound, tool, { input })
          : invokeNestedNative(binding_id, bound, wire_name, true, { input }, {
              ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
              ...(max_output_tokens !== undefined ? { maxOutputTokens: max_output_tokens } : {}),
            });
        return withYieldedSessionId(await response);
      }
      if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
      const response = tool
        ? invokeNative(binding_id, bound, tool, { arguments: args ?? {} })
        : invokeNestedNative(binding_id, bound, wire_name, false, { arguments: args ?? {} }, {
            ...(yield_time_ms !== undefined ? { yieldTimeMs: yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { maxOutputTokens: max_output_tokens } : {}),
          });
      return withYieldedSessionId(await response);
    },
  );

  // tunnel-client owns this subprocess's stdio. During a tunnel recycle it can
  // close stdout while an MCP response is in flight; Node otherwise treats the
  // resulting EPIPE as an unhandled stream error and prints a crash stack. There
  // is no usable transport after a broken pipe, so terminate cleanly and let the
  // tunnel supervisor spawn a fresh MCP child for the next command.
  const onStdoutError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  };
  process.stdout.on("error", onStdoutError);
  // `connect()` resolves once the transport is started; it does not represent
  // the transport's full lifetime. Keep the listener installed for the process
  // lifetime so a later dispatcher-side pipe close is handled as well.
  await server.connect(new StdioServerTransport());
}
