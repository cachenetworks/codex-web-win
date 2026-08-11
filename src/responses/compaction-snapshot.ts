// V15.1 local compaction archive.
// Compaction is deterministic local bookkeeping, not a second ChatGPT browser turn.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "../config";

export const BRIDGE_COMPACTION_READ_WIRE = "__bridge_read_compaction";
export const LOCAL_COMPACTION_MARKER = "[CODEX_BRIDGE_LOCAL_COMPACTION";
const SNAPSHOT_ID_RE = /^[a-f0-9]{32}$/;
const RECENT_TAIL_CHARS = 32_000;
const DEFAULT_READ_CHARS = 40_000;
const MAX_READ_CHARS = 100_000;
const MAX_ARCHIVED_STRING_CHARS = 256_000;

export interface LocalCompactionSnapshot {
  snapshotId: string;
  manifest: string;
  archivedChars: number;
  recentChars: number;
}

export interface LocalCompactionReadArgs {
  snapshotId: string;
  query?: string;
  offset?: number;
  maxChars?: number;
}

function compactionDirectory(): string {
  return path.join(getConfigDir(), "compactions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value: string, key?: string): string {
  if (value.startsWith("data:") && value.includes(";base64,")) {
    return `[binary data URL omitted from text archive; chars=${value.length}]`;
  }
  if (key && /(?:image|attachment|file)_?(?:url|data|bytes)?/i.test(key) && value.length > 250_000) {
    return `[large ${key} payload omitted from text archive; chars=${value.length}]`;
  }
  if (value.length > MAX_ARCHIVED_STRING_CHARS) {
    const marker = `\n...[oversized text payload compacted locally; original_chars=${value.length}]...\n`;
    const retained = MAX_ARCHIVED_STRING_CHARS - marker.length;
    const head = Math.floor(retained / 2);
    const tail = retained - head;
    return value.slice(0, head) + marker + value.slice(-tail);
  }
  return value;
}

function sanitizeForSnapshot(value: unknown, key?: string, depth = 0): unknown {
  if (depth > 100) return "[snapshot depth limit]";
  if (typeof value === "string") return sanitizeString(value, key);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .filter(item => !(isRecord(item) && item.type === "compaction_trigger"))
      .map(item => sanitizeForSnapshot(item, undefined, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === "tools" || childKey === "tool_choice" || childKey === "parallel_tool_calls") continue;
      out[childKey] = sanitizeForSnapshot(childValue, childKey, depth + 1);
    }
    return out;
  }
  if (value === undefined) return undefined;
  return String(value);
}

function snapshotPayload(rawRequest: unknown): unknown {
  if (!isRecord(rawRequest)) return sanitizeForSnapshot(rawRequest);
  return sanitizeForSnapshot({
    model: rawRequest.model,
    instructions: rawRequest.instructions,
    input: rawRequest.input,
    previous_response_id: rawRequest.previous_response_id,
    metadata: rawRequest.metadata,
  });
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export async function createLocalCompactionSnapshot(
  rawRequest: unknown,
  metadata: { kind: "responses-v2" | "responses-compact-v1"; model?: string },
): Promise<LocalCompactionSnapshot> {
  const snapshotId = randomBytes(16).toString("hex");
  const createdAt = new Date().toISOString();
  const payload = snapshotPayload(rawRequest);
  const historyJson = JSON.stringify(payload, null, 2);
  const recent = historyJson.length <= RECENT_TAIL_CHARS
    ? historyJson
    : `...[recent tail begins ${historyJson.length - RECENT_TAIL_CHARS} chars into the archived history]...\n`
      + historyJson.slice(-RECENT_TAIL_CHARS);

  const archiveText = [
    "CODEX BRIDGE LOCAL COMPACTION SNAPSHOT",
    "=======================================",
    `snapshot_id: ${snapshotId}`,
    `created_at: ${createdAt}`,
    `kind: ${metadata.kind}`,
    `model: ${metadata.model ?? "unknown"}`,
    "",
    "This is a local read-only historical archive produced by codex-chatgpt-web V15.1.",
    "It lets the normal ChatGPT/Codex turn recover older details without launching a second",
    "browser-based compaction request.",
    "",
    "<history_json>",
    historyJson,
    "</history_json>",
    "",
  ].join("\n");

  const directory = compactionDirectory();
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700).catch(() => {});
  const file = path.join(directory, `${snapshotId}.txt`);
  const temporaryFile = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporaryFile, archiveText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryFile, file);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }

  const manifest = [
    `${LOCAL_COMPACTION_MARKER} snapshot_id=${snapshotId}]`,
    "The bridge archived earlier expanded task history locally instead of launching another ChatGPT compaction turn.",
    "Continue from the recent history below.",
    "If an older fact, decision, command result, path, error, or prior instruction is needed after codex_bind_turn, use the existing codex_tool_call action with:",
    `wire_name: "${BRIDGE_COMPACTION_READ_WIRE}"`,
    `arguments: {"snapshot_id":"${snapshotId}","query":"optional search phrase","max_chars":40000}`,
    "For sequential paging, omit query and pass offset plus max_chars.",
    "This bridge-private read is read-only and intentionally does not appear in codex_tool_inventory.",
    "",
    "<recent_history_tail>",
    recent,
    "</recent_history_tail>",
  ].join("\n");

  return { snapshotId, manifest, archivedChars: archiveText.length, recentChars: recent.length };
}

export async function readLocalCompactionSnapshot(args: LocalCompactionReadArgs): Promise<{
  snapshot_id: string;
  matched: boolean;
  match_index: number | null;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  text: string;
}> {
  const snapshotId = args.snapshotId.trim().toLowerCase();
  if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error("Invalid local compaction snapshot_id");

  const file = path.join(compactionDirectory(), `${snapshotId}.txt`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code === "ENOENT") throw new Error(`Local compaction snapshot not found: ${snapshotId}`);
    throw error;
  }

  const maxChars = boundedInteger(args.maxChars, DEFAULT_READ_CHARS, 1_000, MAX_READ_CHARS);
  const requestedOffset = boundedInteger(args.offset, 0, 0, text.length);
  const query = args.query?.trim().slice(0, 2_000) ?? "";

  let matched = false;
  let matchIndex: number | null = null;
  let start = requestedOffset;

  if (query) {
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    let found = haystack.indexOf(needle, requestedOffset);
    if (found < 0 && requestedOffset > 0) found = haystack.indexOf(needle);
    if (found >= 0) {
      matched = true;
      matchIndex = found;
      start = Math.max(0, found - Math.floor(maxChars / 4));
    }
  }

  const end = Math.min(text.length, start + maxChars);
  return {
    snapshot_id: snapshotId,
    matched,
    match_index: matchIndex,
    offset: start,
    next_offset: end < text.length ? end : null,
    total_chars: text.length,
    text: text.slice(start, end),
  };
}
