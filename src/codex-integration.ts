import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";

const JOURNAL_VERSION = 10 as const;
const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";
const MANAGED_PROVIDER_ID = "codex-chatgpt-web";

type LineEnding = "\n" | "\r\n";
type ManagedAssignmentKey =
  | "openai_base_url"
  | "chatgpt_base_url"
  | "model_provider"
  | "model_catalog_json";

interface PreviousAssignment {
  present: boolean;
  rawLine?: string;
  value?: string;
  index?: number;
}

interface PreviousProviderBlock {
  present: boolean;
  rawText?: string;
  index?: number;
}

interface ProviderTable {
  start: number;
  end: number;
  rawText: string;
}

export interface CodexIntegrationJournal extends Record<string, unknown> {
  version: typeof JOURNAL_VERSION;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousProviderBlock: PreviousProviderBlock;
  migratedFromVersion?: number;
}

export interface InstallCodexIntegrationOptions {
  replaceExistingRoute?: boolean;
}

export interface UninstallCodexIntegrationResult {
  changed: boolean;
}

export interface CodexModelContextOverride {
  model: string;
  contextWindow: number;
}

export function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return resolve(configured || join(homedir(), ".codex"));
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexJournalPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.json");
}

export function getCodexModelsCachePath(): string {
  return join(getCodexHome(), "models_cache.json");
}

function routeUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}/v1`;
}

function clearCodexModelCache(): void {
  try {
    rmSync(getCodexModelsCachePath(), { force: true });
  } catch (error) {
    console.warn(
      `Could not clear Codex model cache at ${getCodexModelsCachePath()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function splitTomlLines(text: string): { lines: string[]; lineEnding: LineEnding } {
  const lineEnding: LineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const body = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  return {
    lines: body.length > 0 ? body.split(/\r?\n/) : [],
    lineEnding,
  };
}

function withTrailingNewline(lines: string[], lineEnding: LineEnding): string {
  return lines.length > 0 ? `${lines.join(lineEnding)}${lineEnding}` : "";
}

function collapseBlankLines(text: string, lineEnding: LineEnding): string {
  return text.replace(/(?:\r?\n){3,}/g, `${lineEnding}${lineEnding}`);
}

function firstTableIndex(lines: string[]): number {
  const index = lines.findIndex(line => /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line));
  return index < 0 ? lines.length : index;
}

function assignmentRegex(key: string): RegExp {
  return new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*$`);
}

function stripTomlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return value.slice(0, index).trimEnd();
  }
  return value.trimEnd();
}

function decodeTomlString(raw: string, key: string): string {
  const value = stripTomlComment(raw).trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`Could not parse ${key} in Codex config`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  throw new Error(`${key} in Codex config must be a quoted string`);
}

function findTopLevelAssignment(lines: string[], key: string): PreviousAssignment {
  const regex = assignmentRegex(key);
  const matches: PreviousAssignment[] = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) {
      matches.push({
        present: true,
        rawLine: line,
        value: decodeTomlString(match[1]!, key),
        index,
      });
    }
  }
  if (matches.length > 1) {
    throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  }
  return matches[0] ?? { present: false };
}

function findTopLevelPositiveInteger(lines: string[], key: string): number | undefined {
  const regex = assignmentRegex(key);
  const matches: string[] = [];
  for (let index = 0; index < firstTableIndex(lines); index += 1) {
    const line = lines[index]!;
    if (/^\s*#/.test(line)) continue;
    const match = regex.exec(line);
    if (match) matches.push(stripTomlComment(match[1]!).trim());
  }
  if (matches.length > 1) {
    throw new Error(`Codex config contains duplicate top-level ${key} assignments`);
  }
  if (matches.length === 0) return undefined;
  const normalized = matches[0]!.replaceAll("_", "");
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${key} in Codex config must be a positive integer`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} in Codex config must be a positive integer`);
  }
  return value;
}

export function readCodexModelContextOverride(): CodexModelContextOverride | undefined {
  const path = getCodexConfigPath();
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const { lines } = splitTomlLines(text);
  const contextWindow = findTopLevelPositiveInteger(lines, "model_context_window");
  if (contextWindow === undefined) return undefined;
  const model = findTopLevelAssignment(lines, "model").value;
  return model ? { model, contextWindow } : undefined;
}

function assignments(lines: string[]): Record<ManagedAssignmentKey, PreviousAssignment> {
  return {
    openai_base_url: findTopLevelAssignment(lines, "openai_base_url"),
    chatgpt_base_url: findTopLevelAssignment(lines, "chatgpt_base_url"),
    model_provider: findTopLevelAssignment(lines, "model_provider"),
    model_catalog_json: findTopLevelAssignment(lines, "model_catalog_json"),
  };
}

function providerHeaderMatches(line: string): boolean {
  return /^\s*\[\s*model_providers\.(?:"codex-chatgpt-web"|'codex-chatgpt-web'|codex-chatgpt-web)\s*\]\s*(?:#.*)?$/.test(line);
}

function findProviderTable(lines: string[], lineEnding: LineEnding): ProviderTable | undefined {
  const starts = lines
    .map((line, index) => providerHeaderMatches(line) ? index : -1)
    .filter(index => index >= 0);
  if (starts.length > 1) {
    throw new Error(`Codex config contains duplicate [model_providers.${MANAGED_PROVIDER_ID}] tables`);
  }
  const start = starts[0];
  if (start === undefined) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  while (end > start + 1 && lines[end - 1]!.trim() === "") end -= 1;
  return {
    start,
    end,
    rawText: withTrailingNewline(lines.slice(start, end), lineEnding),
  };
}

function removeManagedComments(lines: string[]): void {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.startsWith("# Managed by codex-chatgpt-web")) lines.splice(index, 1);
  }
}

function removeTopLevelAssignments(lines: string[], keys: readonly string[]): void {
  const locations = keys
    .map(key => findTopLevelAssignment(lines, key))
    .filter((assignment): assignment is PreviousAssignment & { index: number } => assignment.index !== undefined)
    .sort((left, right) => right.index - left.index);
  for (const location of locations) lines.splice(location.index, 1);
}

function rawBlockLines(rawText: string): string[] {
  const body = rawText.endsWith("\r\n")
    ? rawText.slice(0, -2)
    : rawText.endsWith("\n")
      ? rawText.slice(0, -1)
      : rawText;
  return body ? body.split(/\r?\n/) : [];
}

function restorePreviousAssignments(
  lines: string[],
  previous: Record<ManagedAssignmentKey, PreviousAssignment>,
): void {
  const items = (Object.entries(previous) as Array<[ManagedAssignmentKey, PreviousAssignment]>)
    .filter(([, assignment]) => assignment.present)
    .sort((left, right) => (
      (left[1].index ?? Number.MAX_SAFE_INTEGER)
      - (right[1].index ?? Number.MAX_SAFE_INTEGER)
    ));
  for (const [key, assignment] of items) {
    if (!assignment.rawLine) {
      throw new Error(`Codex integration journal is missing the prior ${key} line`);
    }
    const index = Math.min(
      assignment.index ?? firstTableIndex(lines),
      firstTableIndex(lines),
    );
    lines.splice(index, 0, assignment.rawLine);
  }
}

function migrateSelectedAlias(lines: string[]): void {
  const selected = findTopLevelAssignment(lines, "model");
  if (!selected.value || selected.index === undefined) return;
  const aliases: Record<string, { model: string; effort: string }> = {
    "gpt-5.6-sol": { model: "chatgpt-web/high", effort: "high" },
    "gpt-5.6-terra": { model: "chatgpt-web/medium", effort: "medium" },
    "gpt-5.6-luna": { model: "chatgpt-web/light", effort: "low" },
    "gpt-5.5": { model: "chatgpt-web/extra-high", effort: "xhigh" },
    "gpt-5.4": { model: "chatgpt-web/pro", effort: "ultra" },
  };
  const replacement = aliases[selected.value];
  if (!replacement) return;
  lines[selected.index] = `model = ${JSON.stringify(replacement.model)}`;
  const effort = findTopLevelAssignment(lines, "model_reasoning_effort");
  if (effort.index !== undefined) {
    lines[effort.index] = `model_reasoning_effort = ${JSON.stringify(replacement.effort)}`;
  }
}

function installRoute(
  text: string,
  installedUrl: string,
  migrateAliases: boolean,
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousProviderBlock: PreviousProviderBlock;
} {
  const { lines, lineEnding } = splitTomlLines(text);
  const previous = assignments(lines);
  const provider = findProviderTable(lines, lineEnding);
  const previousProviderBlock: PreviousProviderBlock = provider
    ? { present: true, rawText: provider.rawText, index: provider.start }
    : { present: false };

  if (provider) lines.splice(provider.start, provider.end - provider.start);
  removeTopLevelAssignments(lines, [
    "openai_base_url",
    "chatgpt_base_url",
    "model_provider",
    "model_catalog_json",
  ]);
  removeManagedComments(lines);
  if (migrateAliases) migrateSelectedAlias(lines);

  const insertion = firstTableIndex(lines);
  lines.splice(
    insertion,
    0,
    MANAGED_COMMENT,
    `openai_base_url = ${JSON.stringify(installedUrl)}`,
  );

  return {
    text: collapseBlankLines(withTrailingNewline(lines, lineEnding), lineEnding),
    previous,
    previousProviderBlock,
  };
}

function verifyInstalledV10(text: string, journal: CodexIntegrationJournal): void {
  const { lines, lineEnding } = splitTomlLines(text);
  const current = assignments(lines);
  if (current.openai_base_url.value !== journal.installed.openai_base_url) {
    throw new Error("Codex openai_base_url changed after setup and no longer matches the installed bridge route");
  }
  if (
    current.chatgpt_base_url.present
    || current.model_provider.present
    || current.model_catalog_json.present
  ) {
    throw new Error("Conflicting Codex model-routing assignments are present");
  }
  if (findProviderTable(lines, lineEnding)) {
    throw new Error(`Conflicting [model_providers.${MANAGED_PROVIDER_ID}] table is present`);
  }
  if (!lines.includes(MANAGED_COMMENT)) {
    throw new Error("Managed Codex route marker is missing");
  }
}

function restoreV10(text: string, journal: CodexIntegrationJournal): string {
  verifyInstalledV10(text, journal);
  const { lines, lineEnding } = splitTomlLines(text);
  removeManagedComments(lines);
  removeTopLevelAssignments(lines, ["openai_base_url"]);
  restorePreviousAssignments(lines, journal.previous);
  if (journal.previousProviderBlock.present) {
    if (!journal.previousProviderBlock.rawText) {
      throw new Error("Codex integration journal is missing the prior provider block");
    }
    const previousLines = rawBlockLines(journal.previousProviderBlock.rawText);
    const index = Math.min(journal.previousProviderBlock.index ?? lines.length, lines.length);
    if (index > 0 && lines[index - 1]?.trim() !== "") previousLines.unshift("");
    lines.splice(index, 0, ...previousLines);
  }
  return collapseBlankLines(withTrailingNewline(lines, lineEnding), lineEnding);
}

function readRawJournal(): Record<string, unknown> | undefined {
  const path = getCodexJournalPath();
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Codex integration journal: ${path}`);
  }
  return parsed as Record<string, unknown>;
}

function isV10Journal(value: Record<string, unknown> | undefined): value is CodexIntegrationJournal {
  return Boolean(
    value
    && value.version === JOURNAL_VERSION
    && value.installed
    && value.previous
    && value.previousProviderBlock
    && typeof value.configPath === "string",
  );
}

function legacyJournalVersion(value: Record<string, unknown> | undefined): number | undefined {
  return typeof value?.version === "number" && Number.isInteger(value.version)
    ? value.version
    : undefined;
}

function backUpLegacyJournal(value: Record<string, unknown> | undefined): void {
  if (!value || isV10Journal(value)) return;
  const path = getCodexJournalPath();
  const backup = `${path}.pre-v10-${Date.now()}.bak`;
  copyFileSync(path, backup);
}

export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const currentText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const existing = readRawJournal();
  const installedUrl = routeUrl(config);

  if (isV10Journal(existing)) {
    try {
      verifyInstalledV10(currentText, existing);
      const { lines, lineEnding } = splitTomlLines(currentText);
      const current = findTopLevelAssignment(lines, "openai_base_url");
      lines[current.index!] = `openai_base_url = ${JSON.stringify(installedUrl)}`;
      const updated: CodexIntegrationJournal = {
        ...existing,
        installed: { openai_base_url: installedUrl },
      };
      atomicWriteFile(configPath, withTrailingNewline(lines, lineEnding));
      atomicWriteFile(getCodexJournalPath(), `${JSON.stringify(updated, null, 2)}\n`);
      clearCodexModelCache();
      return updated;
    } catch (error) {
      if (!options.replaceExistingRoute) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}; rerun with --replace-codex-route to repair it`);
      }

      // A foreground owner may repair a stale route, but it must retain the
      // original pre-install baseline so uninstall remains fully reversible.
      const repaired = installRoute(currentText, installedUrl, false);
      const updated: CodexIntegrationJournal = {
        ...existing,
        installed: { openai_base_url: installedUrl },
      };
      atomicWriteFile(configPath, repaired.text);
      atomicWriteFile(getCodexJournalPath(), `${JSON.stringify(updated, null, 2)}\n`);
      clearCodexModelCache();
      return updated;
    }
  }

  backUpLegacyJournal(existing);
  const migratedFromVersion = legacyJournalVersion(existing);
  if (!existing && !options.replaceExistingRoute) {
    const { lines, lineEnding } = splitTomlLines(currentText);
    const current = assignments(lines);
    const hasExistingRoute = Object.values(current).some(assignment => assignment.present)
      || Boolean(findProviderTable(lines, lineEnding));
    if (hasExistingRoute) {
      throw new Error(
        "Codex already has model-routing settings; rerun with --replace-codex-route to replace them reversibly",
      );
    }
  }
  const patched = installRoute(currentText, installedUrl, Boolean(existing));
  const journal: CodexIntegrationJournal = {
    version: JOURNAL_VERSION,
    configPath,
    installed: { openai_base_url: installedUrl },
    previous: patched.previous,
    previousProviderBlock: patched.previousProviderBlock,
    ...(migratedFromVersion !== undefined ? { migratedFromVersion } : {}),
  };
  atomicWriteFile(configPath, patched.text);
  atomicWriteFile(getCodexJournalPath(), `${JSON.stringify(journal, null, 2)}\n`);
  clearCodexModelCache();
  return journal;
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const raw = readRawJournal();
  if (!raw) return { changed: false };
  const configPath = getCodexConfigPath();
  if (!existsSync(configPath)) throw new Error(`Codex config is missing: ${configPath}`);
  const current = readFileSync(configPath, "utf8");

  if (isV10Journal(raw)) {
    atomicWriteFile(configPath, restoreV10(current, raw));
  } else {
    const { lines, lineEnding } = splitTomlLines(current);
    const provider = findProviderTable(lines, lineEnding);
    if (provider) lines.splice(provider.start, provider.end - provider.start);
    removeManagedComments(lines);
    removeTopLevelAssignments(lines, [
      "openai_base_url",
      "chatgpt_base_url",
      "model_provider",
      "model_catalog_json",
    ]);
    atomicWriteFile(configPath, collapseBlankLines(withTrailingNewline(lines, lineEnding), lineEnding));
  }

  rmSync(getCodexJournalPath(), { force: true });
  clearCodexModelCache();
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: Record<string, unknown>;
  errors: string[];
} {
  const journal = readRawJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      if (isV10Journal(journal)) {
        const text = readFileSync(journal.configPath, "utf8");
        verifyInstalledV10(text, journal);
      } else {
        errors.push("Legacy Codex route state will be repaired automatically when the bridge session starts");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(isV10Journal(journal) ? { routeUrl: journal.installed.openai_base_url } : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
