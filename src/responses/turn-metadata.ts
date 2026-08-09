import { isDeepStrictEqual } from "node:util";

export const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata";

const CODEX_OWNED_TURN_METADATA_KEYS = [
  "installation_id",
  "session_id",
  "thread_id",
  "turn_id",
  "window_id",
  "request_kind",
  "compaction",
  "code_mode_tool_names",
  "tool_namespaces_info",
  "turn_started_at_unix_ms",
  "forked_from_thread_id",
  "parent_thread_id",
  "parent_turn_id",
  "subagent_kind",
  "thread_source",
  "sandbox",
  "sandbox_mode",
  "workspaces",
] as const;

const FLAT_IDENTITY_KEYS = ["session_id", "thread_id", "turn_id"] as const;
const STRING_TURN_METADATA_KEYS = [
  "installation_id",
  "session_id",
  "thread_id",
  "turn_id",
  "window_id",
  "request_kind",
  "forked_from_thread_id",
  "parent_thread_id",
  "parent_turn_id",
  "subagent_kind",
  "sandbox",
  "sandbox_mode",
] as const;
const OBJECT_TURN_METADATA_KEYS = ["compaction", "tool_namespaces_info", "workspaces"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function owns(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseTurnMetadata(value: unknown, source: string): Record<string, unknown> {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new Error(`${source} must contain valid JSON`);
    }
  }
  const parsed = record(decoded);
  if (!parsed) throw new Error(`${source} must contain a JSON object`);
  for (const key of STRING_TURN_METADATA_KEYS) {
    if (owns(parsed, key) && typeof parsed[key] !== "string") {
      throw new Error(`${source}.${key} must be a string`);
    }
  }
  for (const key of OBJECT_TURN_METADATA_KEYS) {
    if (owns(parsed, key) && !record(parsed[key])) {
      throw new Error(`${source}.${key} must be a JSON object`);
    }
  }
  if (owns(parsed, "turn_started_at_unix_ms")
      && (typeof parsed.turn_started_at_unix_ms !== "number" || !Number.isFinite(parsed.turn_started_at_unix_ms))) {
    throw new Error(`${source}.turn_started_at_unix_ms must be a finite number`);
  }
  return parsed;
}

function mergeOwnedProjection(
  canonical: Record<string, unknown>,
  projection: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...canonical };
  for (const key of CODEX_OWNED_TURN_METADATA_KEYS) {
    if (!owns(projection, key)) continue;
    if (owns(canonical, key) && !isDeepStrictEqual(canonical[key], projection[key])) {
      throw new Error(`Conflicting Codex turn metadata field: ${key}`);
    }
    if (!owns(canonical, key)) merged[key] = projection[key];
  }
  return merged;
}

/**
 * Normalize Codex's canonical Responses `client_metadata` blob and its bounded
 * compatibility header into the request body consumed by routed adapters.
 * Native requests are dispatched before this function is called and remain byte-for-byte passthrough.
 */
export function normalizeCodexTurnMetadata(body: unknown, headers: Headers): unknown {
  const request = record(body);
  if (!request) return body;

  const hasClientMetadata = owns(request, "client_metadata");
  const clientMetadata = hasClientMetadata ? record(request.client_metadata) : undefined;
  if (hasClientMetadata && !clientMetadata) {
    throw new Error("Codex client_metadata must be a JSON object");
  }

  const hasBodyBlob = clientMetadata !== undefined && owns(clientMetadata, CODEX_TURN_METADATA_KEY);
  const bodyBlob = hasBodyBlob
    ? parseTurnMetadata(clientMetadata![CODEX_TURN_METADATA_KEY], `client_metadata.${CODEX_TURN_METADATA_KEY}`)
    : undefined;
  const headerValue = headers.get(CODEX_TURN_METADATA_KEY);
  const headerBlob = headerValue !== null
    ? parseTurnMetadata(headerValue, `${CODEX_TURN_METADATA_KEY} header`)
    : undefined;

  let normalized = bodyBlob
    ? headerBlob ? mergeOwnedProjection(bodyBlob, headerBlob) : { ...bodyBlob }
    : headerBlob ? { ...headerBlob } : undefined;

  for (const key of FLAT_IDENTITY_KEYS) {
    if (!clientMetadata || !owns(clientMetadata, key)) continue;
    const flat = clientMetadata[key];
    if (typeof flat !== "string") {
      throw new Error(`Codex client_metadata.${key} must be a string`);
    }
    normalized ??= {};
    if (owns(normalized, key) && !isDeepStrictEqual(normalized[key], flat)) {
      throw new Error(`Conflicting Codex turn metadata field: ${key}`);
    }
    if (!owns(normalized, key)) normalized[key] = flat;
  }

  if (!normalized) return body;
  return {
    ...request,
    client_metadata: {
      ...clientMetadata,
      [CODEX_TURN_METADATA_KEY]: JSON.stringify(normalized),
    },
  };
}
