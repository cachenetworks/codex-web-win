import { isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { CodexParsedRequest, CodexTool } from "../../types";

const ENVIRONMENT_RESOLVER_REVISION = "rev6-2026-08-08";

export type ChatGptSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean };

export interface ChatGptTurnEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  tools: CodexTool[];
}
export interface ChatGptTurnIdentity {
  threadId?: string;
  parentThreadId?: string;
  turnId?: string;
  promptCacheKey?: string;
  sandboxType?: ChatGptSandboxPolicy["type"];
}

type SandboxType = ChatGptSandboxPolicy["type"];

interface EnvironmentAuthority {
  cwd?: string;
  roots?: string[];
  writableRoots?: string[];
  sandboxType?: SandboxType;
}

interface EnvironmentDelta {
  cwd?: string;
  roots?: string[];
  writableRoots?: string[];
  sandboxType?: SandboxType;
  hasPolicy: boolean;
}

interface TrustedEnvironmentEnvelope {
  text: string;
  currentTurn: boolean;
}

export class MissingTrustedCodexEnvironmentError extends Error {
  constructor(field: string) {
    super(`ChatGPT web turn is missing ${field} in trusted Codex environment context`);
    this.name = "MissingTrustedCodexEnvironmentError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uniquePaths(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const normalized = resolve(value);
    if (!unique.has(pathIdentity(normalized))) unique.set(pathIdentity(normalized), normalized);
  }
  return [...unique.values()];
}

function clientTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  const body = record(parsed._rawBody);
  const metadata = record(body?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { throw new Error("ChatGPT web turn has malformed native Codex turn metadata"); }
  }
  return record(raw);
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" && turnId ? turnId : undefined;
}

function nativeItemId(value: unknown): string | undefined {
  const id = record(value)?.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * Codex records explicit skill prompts as user-role items after the real user
 * input. They are native context, not the user half of an environment/user
 * pair, so they must never authenticate a preceding user-authored XML block.
 */
function isNativeSkillPromptItem(value: unknown): boolean {
  const item = record(value);
  if (item?.type !== "message" || item.role !== "user") return false;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.length > 0 && content.every(part => {
    const text = record(part)?.text;
    return typeof text === "string"
      && /^<skill>[\s\S]*<\/skill>$/i.test(text.trim());
  });
}

function environmentTextPart(value: unknown): string | undefined {
  const item = record(value);
  if (item?.type !== "message" || item.role !== "user") return undefined;
  const content = Array.isArray(item.content) ? item.content : [];
  const matches: string[] = [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) matches.push(trimmed);
  }
  if (matches.length > 1) throw new Error("ChatGPT web turn has multiple environment contexts in one native item");
  return matches[0];
}

function hasAssistantOutputBetween(input: unknown[], startIndex: number, endIndex: number): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = record(input[index]);
    if (!item) continue;
    if (item.type === "message" && item.role === "assistant") return true;
    if (item.type === "function_call" || item.type === "reasoning") return true;
  }
  return false;
}

function trustedEnvironmentTexts(parsed: CodexParsedRequest): TrustedEnvironmentEnvelope[] {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadataTurnId = clientTurnMetadata(parsed)?.turn_id;
  const currentMetadataTurnId = typeof metadataTurnId === "string" ? metadataTurnId : undefined;
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (record(input[index])?.role === "user" && !isNativeSkillPromptItem(input[index])) {
      activeUserIndex = index;
      break;
    }
  }
  const trusted: TrustedEnvironmentEnvelope[] = [];
  for (let userIndex = 1; userIndex < input.length; userIndex += 1) {
    const user = record(input[userIndex]);
    if (user?.type !== "message" || user.role !== "user") continue;
    if (isNativeSkillPromptItem(user)) continue;
    const prior = record(input[userIndex - 1]);
    const candidateIndex = prior?.type === "message" && prior.role === "developer"
      ? userIndex - 2
      : userIndex - 1;
    if (candidateIndex < 0) continue;
    const text = environmentTextPart(input[candidateIndex]);
    if (!text) continue;

    const candidateTurnId = itemTurnId(input[candidateIndex]);
    const userTurnId = itemTurnId(user);
    const turnProvenance = Boolean(candidateTurnId && candidateTurnId === userTurnId);
    const candidateId = nativeItemId(input[candidateIndex]);
    const userId = nativeItemId(user);
    // Released Codex builds do not all copy the per-turn passthrough onto both
    // items. Distinct native Responses item ids still prove this is Codex's
    // adjacent context/user pair; user-authored XML remains inside one item.
    const itemProvenance = Boolean(candidateId && userId && candidateId !== userId);
    const exactCurrentTurn = Boolean(
      currentMetadataTurnId && turnProvenance && candidateTurnId === currentMetadataTurnId,
    );
    const oneSidedCurrentTurn = Boolean(
      currentMetadataTurnId
      && itemProvenance
      && ((candidateTurnId === currentMetadataTurnId && !userTurnId)
        || (userTurnId === currentMetadataTurnId && !candidateTurnId)),
    );
    const metadataCurrentPair = exactCurrentTurn || oneSidedCurrentTurn;
    const currentPair = userIndex === activeUserIndex;
    const replayedCompletedPair = userIndex < activeUserIndex
      && hasAssistantOutputBetween(input, userIndex + 1, activeUserIndex);
    if ((metadataCurrentPair || currentPair || replayedCompletedPair) && (turnProvenance || itemProvenance)) {
      trusted.push({ text, currentTurn: metadataCurrentPair || currentPair });
    }
  }
  return trusted;
}

function normalizedPolicyName(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", "-") : undefined;
}

function canonicalSandboxType(value: unknown): SandboxType | "externalSandbox" | undefined {
  switch (normalizedPolicyName(value)) {
    case "danger-full-access": return "dangerFullAccess";
    case "workspace-write": return "workspaceWrite";
    case "read-only": return "readOnly";
    case "external-sandbox": return "externalSandbox";
    default: return undefined;
  }
}

function canonicalMetadataSandboxType(metadata: Record<string, unknown> | undefined): SandboxType | undefined {
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "sandbox_mode")) return undefined;
  const policy = canonicalSandboxType(metadata.sandbox_mode);
  if (policy === "externalSandbox") {
    throw new Error("ChatGPT web turn uses an unsupported native Codex external-sandbox policy");
  }
  if (!policy) throw new Error("ChatGPT web turn uses an unsupported native Codex sandbox_mode policy");
  return policy;
}

function legacyPolicySandboxType(metadata: Record<string, unknown> | undefined): SandboxType | undefined {
  if (!metadata || Object.prototype.hasOwnProperty.call(metadata, "sandbox_mode")) return undefined;
  const normalized = normalizedPolicyName(metadata.sandbox);
  if (normalized === "external-sandbox") {
    throw new Error("ChatGPT web turn uses an unsupported native Codex external-sandbox policy");
  }
  // `sandbox` is normally an implementation tag (`none`, `windows_elevated`,
  // `windows_sandbox`, `seatbelt`, `seccomp`, or `external`), not a capability.
  // Only old, explicit policy-valued strings are safe as a final fallback.
  if (normalized === "danger-full-access") return "dangerFullAccess";
  if (normalized === "workspace-write") return "workspaceWrite";
  if (normalized === "read-only") return "readOnly";
  return undefined;
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'");
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decodeXmlText(match[1]!.trim()) : undefined;
}

function singleAbsolutePath(values: string[], field: string): string | undefined {
  if (values.length === 0) return undefined;
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.some(value => !isAbsolute(value))) throw new Error(`ChatGPT web ${field} must contain absolute paths`);
  const unique = uniquePaths(decoded);
  if (unique.length !== 1) throw new Error(`ChatGPT web turn has conflicting trusted Codex ${field} values`);
  return unique[0];
}

function absolutePaths(values: string[], field: string): string[] | undefined {
  if (values.length === 0) return undefined;
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.some(value => !isAbsolute(value))) throw new Error(`ChatGPT web ${field} must contain absolute paths`);
  return uniquePaths(decoded);
}

function primaryCwd(text: string): string | undefined {
  const environments = text.match(/<environments\b[^>]*>([\s\S]*?)<\/environments>/i);
  if (!environments) {
    const withoutNested = text.replace(/<environments\b[^>]*>[\s\S]*?<\/environments>/gi, "");
    return singleAbsolutePath(
      [...withoutNested.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? ""),
      "cwd",
    );
  }

  const current: Array<{ primary?: string; body: string }> = [];
  for (const match of environments[1]!.matchAll(/<environment\b([^>]*)>([\s\S]*?)<\/environment>/gi)) {
    current.push({ primary: xmlAttribute(match[1] ?? "", "primary"), body: match[2] ?? "" });
  }
  if (current.some(environment => environment.primary !== "true" && environment.primary !== "false")) {
    throw new Error("ChatGPT web turn has a malformed multi-environment primary marker");
  }
  const explicitPrimary = current.filter(environment => environment.primary?.toLowerCase() === "true");
  if (explicitPrimary.length > 1) throw new Error("ChatGPT web turn has multiple primary Codex environments");
  const selected = explicitPrimary[0];
  if (!selected) return undefined; // A secondary-only world-state delta keeps the prior primary cwd.
  return singleAbsolutePath(
    [...selected.body.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? ""),
    "cwd",
  );
}

function writeRootsFromProfile(body: string, roots: string[]): { type: SandboxType; writableRoots: string[] } {
  const entries = [...body.matchAll(/<entry\b([^>]*)>([\s\S]*?)<\/entry>/gi)];
  const rootWrite = entries.some(match => {
    if (xmlAttribute(match[1] ?? "", "access")?.toLowerCase() !== "write") return false;
    const entryBody = match[2] ?? "";
    const special = entryBody.match(/<special>([^<]+)<\/special>/i)?.[1];
    return Boolean(special && decodeXmlText(special.trim()) === ":root");
  });
  if (rootWrite) {
    // Codex's ordered permission engine does not call `:root` write full access
    // when a narrower read/deny carve-out is also present. This compact harness
    // cannot preserve that precedence, so reject instead of widening it.
    if (entries.length !== 1) {
      throw new Error("ChatGPT web cannot safely represent a Codex root-write profile with permission carve-outs");
    }
    return { type: "dangerFullAccess", writableRoots: roots };
  }
  const writable: string[] = [];
  for (const match of entries) {
    if (xmlAttribute(match[1] ?? "", "access")?.toLowerCase() !== "write") continue;
    const entryBody = match[2] ?? "";
    const path = entryBody.match(/<path>([^<]+)<\/path>/i)?.[1];
    if (path) {
      const decoded = decodeXmlText(path.trim());
      if (!isAbsolute(decoded)) throw new Error("ChatGPT web managed write path must be absolute");
      const normalized = resolve(decoded);
      writable.push(normalized);
      continue;
    }
    const special = entryBody.match(/<special>([^<]+)<\/special>/i)?.[1];
    if (special) {
      const decoded = decodeXmlText(special.trim());
      if (decoded === ":workspace_roots") writable.push(...roots);
      else if (decoded.startsWith(":workspace_roots/")) {
        const subpath = decoded.slice(":workspace_roots/".length);
        for (const root of roots) {
          const candidate = resolve(root, subpath);
          const rel = relative(resolve(root), candidate);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error("ChatGPT web managed workspace write path escapes its workspace root");
          }
          writable.push(candidate);
        }
      } else if (decoded === ":tmpdir" || decoded === ":slash_tmp") writable.push(resolve(tmpdir()));
      else throw new Error("ChatGPT web cannot safely represent an unknown Codex managed write special");
      continue;
    }
    // A write glob is still writable authority even when it cannot be reduced
    // to a safe absolute broker root. Preserve workspaceWrite but do not widen.
    if (/<glob>[^<]+<\/glob>/i.test(entryBody)) {
      throw new Error("ChatGPT web cannot safely reduce a Codex managed write glob to broker roots");
    }
    throw new Error("ChatGPT web managed write entry has no recognized path");
  }
  return writable.length > 0
    ? { type: "workspaceWrite", writableRoots: uniquePaths(writable) }
    : { type: "readOnly", writableRoots: [] };
}

function permissionProfile(text: string, roots: string[]): { type: SandboxType; writableRoots: string[] } | undefined {
  const profiles = [...text.matchAll(/<permission_profile\b([^>]*)>([\s\S]*?)<\/permission_profile>/gi)];
  if (profiles.length === 0) return undefined;
  if (profiles.length !== 1) throw new Error("ChatGPT web turn has multiple Codex permission profiles");
  const type = xmlAttribute(profiles[0]![1] ?? "", "type")?.toLowerCase();
  const body = profiles[0]![2] ?? "";
  const fileSystems = [...body.matchAll(/<file_system\b([^>]*)(?:\/>|>([\s\S]*?)<\/file_system>)/gi)];
  if (fileSystems.length !== 1) throw new Error("ChatGPT web Codex permission profile has no unique file-system policy");
  const fileSystemType = xmlAttribute(fileSystems[0]![1] ?? "", "type")?.toLowerCase();
  const fileSystemBody = fileSystems[0]![2] ?? "";

  if ((type === "disabled" || type === "managed") && fileSystemType === "unrestricted") {
    return { type: "dangerFullAccess", writableRoots: roots };
  }
  if (type === "managed" && fileSystemType === "restricted") {
    return writeRootsFromProfile(fileSystemBody, roots);
  }
  if (type === "external" && fileSystemType === "external") {
    throw new Error("ChatGPT web turn uses an unsupported native Codex external-sandbox policy");
  }
  throw new Error("ChatGPT web turn has an unsupported or malformed Codex permission profile");
}

function legacyXmlSandboxType(text: string): SandboxType | undefined {
  const matches = [...text.matchAll(/<sandbox_mode>([^<]+)<\/sandbox_mode>/gi)];
  if (matches.length === 0) return undefined;
  const policies = [...new Set(matches.map(match => normalizedPolicyName(decodeXmlText(match[1] ?? ""))))];
  if (policies.length !== 1) throw new Error("ChatGPT web turn has conflicting legacy Codex sandbox_mode values");
  const type = canonicalSandboxType(policies[0]);
  if (type === "externalSandbox") throw new Error("ChatGPT web turn uses an unsupported native Codex external-sandbox policy");
  if (!type) throw new Error("ChatGPT web turn uses an unsupported legacy Codex sandbox_mode policy");
  return type;
}

function environmentDelta(text: string, priorRoots: string[]): EnvironmentDelta {
  const cwd = primaryCwd(text);
  const rootMatches = [...text.matchAll(/<workspace_roots\b[^>]*>([\s\S]*?)<\/workspace_roots>/gi)]
    .flatMap(section => [...section[1]!.matchAll(/<root>([^<]+)<\/root>/gi)].map(match => match[1] ?? ""));
  const roots = rootMatches.length > 0
    ? absolutePaths(rootMatches, "workspace_roots")
    : /<filesystem\b/i.test(text)
      ? []
      : undefined;
  const effectiveRoots = roots ?? priorRoots;
  const profile = permissionProfile(text, effectiveRoots);
  const legacy = legacyXmlSandboxType(text);
  if (profile && legacy && profile.type !== legacy) {
    throw new Error("ChatGPT web turn has conflicting Codex sandbox policies");
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(roots ? { roots } : {}),
    ...(profile?.writableRoots ? { writableRoots: profile.writableRoots } : {}),
    ...(profile?.type || legacy ? { sandboxType: profile?.type ?? legacy } : {}),
    hasPolicy: Boolean(profile || legacy),
  };
}

function initialAuthority(previous?: Pick<ChatGptTurnEnvironment, "cwd" | "roots" | "writableRoots" | "sandboxPolicy">): EnvironmentAuthority {
  if (!previous) return {};
  return {
    cwd: previous.cwd,
    roots: [...previous.roots],
    writableRoots: [...previous.writableRoots],
    sandboxType: previous.sandboxPolicy.type,
  };
}

function applyDelta(authority: EnvironmentAuthority, delta: EnvironmentDelta): void {
  if (delta.cwd) authority.cwd = delta.cwd;
  if (delta.roots) authority.roots = delta.roots;
  if (delta.sandboxType) {
    authority.sandboxType = delta.sandboxType;
    authority.writableRoots = delta.sandboxType === "dangerFullAccess"
      ? [...(authority.roots ?? [])]
      : delta.sandboxType === "readOnly"
        ? []
        : delta.writableRoots === undefined
          ? authority.writableRoots
          : [...delta.writableRoots];
  } else if (delta.roots && authority.sandboxType === "dangerFullAccess") {
    authority.writableRoots = [...delta.roots];
  }
}

export function extractChatGptTurnEnvironment(
  parsed: CodexParsedRequest,
  previous?: Pick<ChatGptTurnEnvironment, "cwd" | "roots" | "writableRoots" | "sandboxPolicy">,
): ChatGptTurnEnvironment {
  const metadata = clientTurnMetadata(parsed);
  const canonicalType = canonicalMetadataSandboxType(metadata);
  const legacyMetadataType = legacyPolicySandboxType(metadata);
  const envelopes = trustedEnvironmentTexts(parsed);
  if (envelopes.length === 0) throw new MissingTrustedCodexEnvironmentError("environment context");

  const authority = initialAuthority(previous);
  let xmlPolicySeen = false;
  let currentXmlPolicy: SandboxType | undefined;
  for (const envelope of envelopes) {
    const delta = environmentDelta(envelope.text, authority.roots ?? []);
    if (delta.hasPolicy) xmlPolicySeen = true;
    if (envelope.currentTurn && delta.sandboxType) currentXmlPolicy = delta.sandboxType;
    applyDelta(authority, delta);
  }

  if (canonicalType && currentXmlPolicy && canonicalType !== currentXmlPolicy) {
    throw new Error("ChatGPT web turn has conflicting native Codex sandbox policies");
  }
  const metadataType = canonicalType ?? (!xmlPolicySeen ? legacyMetadataType : undefined);
  if (metadataType) {
    authority.sandboxType = metadataType;
    authority.writableRoots = metadataType === "dangerFullAccess"
      ? [...(authority.roots ?? [])]
      : metadataType === "readOnly"
        ? []
        : authority.writableRoots;
  }

  if (!authority.cwd) throw new MissingTrustedCodexEnvironmentError("cwd");
  if (!authority.roots) throw new MissingTrustedCodexEnvironmentError("workspace roots");
  if (!authority.sandboxType) throw new MissingTrustedCodexEnvironmentError("sandbox mode");
  if (authority.sandboxType === "workspaceWrite" && authority.writableRoots === undefined) {
    throw new MissingTrustedCodexEnvironmentError("writable roots");
  }
  const writableRoots = uniquePaths(authority.writableRoots ?? []);
  // Current Codex does not serialize PermissionProfile.network in the trusted
  // environment XML. Its separate <network> block describes config-layer
  // domain requirements, not effective sandbox capability, so stay conservative.
  const networkAccess = false;
  const tools = parsed.context.tools ?? [];
  const source = canonicalType ? "native-metadata" : xmlPolicySeen ? "permission-profile" : legacyMetadataType ? "legacy-metadata" : "stored-delta";

  console.info(
    `[chatgpt-web] environment resolver ${ENVIRONMENT_RESOLVER_REVISION}: source=${source} sandbox=${authority.sandboxType} envelopes=${envelopes.length}`,
  );

  if (authority.sandboxType === "dangerFullAccess") {
    return {
      cwd: authority.cwd,
      roots: authority.roots,
      writableRoots: authority.roots,
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    };
  }
  if (authority.sandboxType === "workspaceWrite") {
    return {
      cwd: authority.cwd,
      roots: authority.roots,
      writableRoots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess },
      tools,
    };
  }
  return {
    cwd: authority.cwd,
    roots: authority.roots,
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess },
    tools,
  };
}

export function extractChatGptTurnIdentity(parsed: CodexParsedRequest): ChatGptTurnIdentity {
  const body = record(parsed._rawBody);
  const metadata = clientTurnMetadata(parsed);
  const sandboxType = canonicalMetadataSandboxType(metadata) ?? legacyPolicySandboxType(metadata);
  return {
    ...(typeof metadata?.thread_id === "string" ? { threadId: metadata.thread_id } : {}),
    ...(typeof metadata?.parent_thread_id === "string"
      ? { parentThreadId: metadata.parent_thread_id }
      : typeof metadata?.forked_from_thread_id === "string"
        ? { parentThreadId: metadata.forked_from_thread_id }
        : {}),
    ...(typeof metadata?.turn_id === "string" ? { turnId: metadata.turn_id } : {}),
    ...(typeof body?.prompt_cache_key === "string" ? { promptCacheKey: body.prompt_cache_key } : {}),
    ...(sandboxType ? { sandboxType } : {}),
  };
}
