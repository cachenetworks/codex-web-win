import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { CodexProviderConfig } from "./types";
import { VERSION } from "./version";

export type RuntimeMode = "browser-only" | "full";

export function defaultAppName(machineName = hostname()): string {
  const suffix = machineName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return suffix ? `Codex Native ${suffix}` : "Codex Native";
}

export interface TunnelConfig {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileDir: string;
  profileName: string;
  alias: string;
}

export interface AppConfig {
  version: 2;
  releaseVersion: string;
  mode: RuntimeMode;
  host: "127.0.0.1";
  port: number;
  contextWindow: number;
  appName: string;
  chromeExecutablePath: string;
  storageStatePath: string;
  brokerSocketPath: string;
  headed: boolean;
  proAvailable: boolean;
  autoApproveToolCalls: boolean;
  controlToken: string;
  runtimeCommand: string[];
  acknowledgedUnofficialAt?: string;
  tunnel?: TunnelConfig;
}

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex-chatgpt-web")));
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function isWindowsNamedPipePath(value: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(value);
}

function windowsNamedPipePath(seed: string): string {
  const normalized = resolve(seed).toLowerCase();
  const suffix = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\codex-chatgpt-web-${suffix}-turn-broker`;
}

export function defaultBrokerSocketPath(platform: NodeJS.Platform = process.platform): string {
  const filesystemPath = join(getConfigDir(), "runtime", "turn-broker.sock");
  return platform === "win32" ? windowsNamedPipePath(filesystemPath) : filesystemPath;
}

export function resolveBrokerSocketPath(
  value?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const expanded = expandUserPath(value?.trim() || defaultBrokerSocketPath(platform));
  if (isWindowsNamedPipePath(expanded)) {
    if (platform !== "win32") throw new Error(`Windows named pipe is not valid on ${platform}: ${expanded}`);
    return expanded;
  }
  const resolved = resolve(expanded);
  return platform === "win32" ? windowsNamedPipePath(resolved) : resolved;
}

export function atomicWriteFile(path: string, data: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the installer. */ }
}

export function defaultConfig(mode: RuntimeMode = "browser-only"): AppConfig {
  const home = getConfigDir();
  return {
    version: 2,
    releaseVersion: VERSION,
    mode,
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    // A machine-specific connector name prevents one ChatGPT account from
    // silently selecting another computer's Full-mode tunnel. Existing configs
    // retain their configured name; this affects fresh setups only.
    appName: defaultAppName(),
    chromeExecutablePath: defaultChromeExecutable(),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerSocketPath(),
    headed: false,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
    runtimeCommand: currentRuntimeCommand(),
  };
}

export function currentRuntimeCommand(): string[] {
  const configuredRuntime = process.env.CODEX_CHATGPT_WEB_RUNTIME?.trim();
  const configuredEntrypoint = process.env.CODEX_CHATGPT_WEB_ENTRYPOINT?.trim();
  if (Boolean(configuredRuntime) !== Boolean(configuredEntrypoint)) {
    throw new Error("CODEX_CHATGPT_WEB_RUNTIME and CODEX_CHATGPT_WEB_ENTRYPOINT must be set together");
  }
  if (configuredRuntime && configuredEntrypoint) {
    const command = [
      resolve(expandUserPath(configuredRuntime)),
      resolve(expandUserPath(configuredEntrypoint)),
    ];
    assertDurableRuntimeCommand(command);
    if (!existsSync(command.at(-1)!)) throw new Error(`Runtime entrypoint does not exist: ${command.at(-1)}`);
    return command;
  }

  const launcher = process.env.CODEX_CHATGPT_WEB_LAUNCHER?.trim();
  if (launcher) {
    const resolvedLauncher = resolve(expandUserPath(launcher));
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolvedLauncher)) {
      const bundleRoot = resolve(dirname(resolvedLauncher), "..");
      const runtime = join(bundleRoot, "runtime", "node.exe");
      const entrypoint = join(bundleRoot, "app", "cli.js");
      if (!existsSync(runtime) || !existsSync(entrypoint)) {
        throw new Error(
          "The Windows launcher must provide direct runtime paths via "
          + "CODEX_CHATGPT_WEB_RUNTIME and CODEX_CHATGPT_WEB_ENTRYPOINT",
        );
      }
      const command = [runtime, entrypoint];
      assertDurableRuntimeCommand(command);
      return command;
    }
    const command = [resolvedLauncher];
    assertDurableRuntimeCommand(command);
    return command;
  }
  const executable = resolve(process.execPath);
  const executableName = basename(executable).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    const entry = typeof Bun !== "undefined" ? Bun.main : process.argv[1];
    if (!entry || /(?:^|[\\/])\[eval\]$/.test(entry)) {
      throw new Error("Cannot install a service from an evaluated Bun script");
    }
    return [executable, resolve(entry)];
  }
  const entry = process.argv[1];
  if (!entry || /(?:^|[\\/])\[eval\]$/.test(entry)) {
    throw new Error("Cannot install a service from an evaluated Node script");
  }
  const command = [executable, resolve(entry)];
  assertDurableRuntimeCommand(command);
  if (!existsSync(command[1]!)) throw new Error(`Runtime entrypoint does not exist: ${command[1]}`);
  return command;
}

function inside(path: string, root: string): boolean {
  const normalize = (value: string) => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function assertDurableRuntimeCommandStructure(command: string[]): void {
  if (command.length === 0) throw new Error("Runtime command is empty");
  const executable = command[0]!;
  if (!isAbsolute(executable)) throw new Error(`Runtime executable must be absolute: ${executable}`);
  const ephemeralRoots = process.platform === "win32"
    ? [tmpdir()]
    : [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  for (const part of command) {
    if (!isAbsolute(part)) continue;
    if (ephemeralRoots.some(root => inside(part, root))) {
      throw new Error(`Runtime command must not reference an ephemeral path: ${part}`);
    }
  }
}

function assertRuntimeExecutableExists(command: string[]): void {
  const executable = command[0]!;
  if (!existsSync(executable)) throw new Error(`Runtime executable does not exist: ${executable}`);
}

export function assertDurableRuntimeCommand(command: string[]): void {
  assertDurableRuntimeCommandStructure(command);
  assertRuntimeExecutableExists(command);
}

export function defaultChromeExecutable(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (platform === "win32") {
    const candidates = [
      environment.PROGRAMW6432,
      environment.PROGRAMFILES,
      environment["PROGRAMFILES(X86)"],
      environment.LOCALAPPDATA,
    ]
      .filter((root): root is string => Boolean(root?.trim()))
      .map(root => join(root, "Google", "Chrome", "Application", "chrome.exe"));
    const installed = candidates.find(candidate => existsSync(candidate));
    return installed ?? candidates[0]
      ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  }
  return "/usr/bin/google-chrome";
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run codex-chatgpt-web setup first.`);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
}

export function loadConfigForSetup(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run codex-chatgpt-web setup first.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw.version === 1 && raw.mode === "pro-only") {
    raw.version = 2;
    raw.mode = "browser-only";
  }
  // An upgrade or clean reinstall can legitimately remove the release named
  // by the saved command. Setup preserves that old command for change
  // detection, then replaces it with currentRuntimeCommand before saving.
  return parseConfig(raw, path, { allowMissingRuntimeExecutable: true });
}

function parseConfig(
  value: unknown,
  path: string,
  options: { allowMissingRuntimeExecutable?: boolean } = {},
): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid configuration object in ${path}`);
  const parsed = value as Partial<AppConfig>;
  if (parsed.version !== 2) throw new Error(`Unsupported configuration version in ${path}; rerun setup to migrate it`);
  if (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion.trim()) throw new Error(`Missing releaseVersion in ${path}`);
  if (parsed.mode !== "browser-only" && parsed.mode !== "full") throw new Error(`Invalid runtime mode in ${path}`);
  if (parsed.host !== "127.0.0.1") throw new Error("The Responses proxy must bind to 127.0.0.1");
  if (!Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65_535) throw new Error(`Invalid port in ${path}`);
  const requiredStrings: Array<keyof AppConfig> = [
    "appName", "chromeExecutablePath", "storageStatePath", "brokerSocketPath", "controlToken",
  ];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error(`Missing ${key} in ${path}`);
  }
  if (!/^[A-Za-z0-9_-]{40,}$/.test(parsed.controlToken!)) throw new Error(`Invalid controlToken in ${path}`);
  if (parsed.mode === "full" && !parsed.tunnel) throw new Error("Full mode requires tunnel configuration");
  if (!Array.isArray(parsed.runtimeCommand) || parsed.runtimeCommand.length === 0
    || parsed.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error(`Invalid runtimeCommand in ${path}`);
  }
  assertDurableRuntimeCommandStructure(parsed.runtimeCommand as string[]);
  if (!options.allowMissingRuntimeExecutable) {
    assertRuntimeExecutableExists(parsed.runtimeCommand as string[]);
  }
  if (parsed.proAvailable !== undefined && typeof parsed.proAvailable !== "boolean") {
    throw new Error(`Invalid proAvailable in ${path}`);
  }
  return {
    ...parsed,
    brokerSocketPath: resolveBrokerSocketPath(parsed.brokerSocketPath),
    proAvailable: parsed.proAvailable === true,
  } as AppConfig;
}

export function saveConfig(config: AppConfig): void {
  atomicWriteFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function providerConfig(config: AppConfig): CodexProviderConfig {
  const models = ["gpt-5.6-sol"];
  const efforts = ["low", "medium", "high", "xhigh", ...(config.proAvailable ? ["max"] : [])];
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: "gpt-5.6-sol",
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(models.map(model => [model, ["text", "image"]])),
    modelReasoningEfforts: { "gpt-5.6-sol": efforts },
    modelDefaultReasoningEfforts: { "gpt-5.6-sol": "high" },
    noReasoningModels: [],
    chatgptWeb: {
      appName: config.appName,
      storageStatePath: config.storageStatePath,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      // Runtime automation is always headless. Interactive setup/login uses the
      // dedicated visible Chrome path in browser-login.ts and is unaffected.
      headed: false,
      localToolsEnabled: config.mode === "full",
      proAvailable: config.proAvailable,
      autoApproveToolCalls: config.autoApproveToolCalls,
    },
  };
}
