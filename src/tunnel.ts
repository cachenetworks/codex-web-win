import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { AppConfig, TunnelConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";
import { getTunnelServiceStatus } from "./tunnel-service";

const TUNNEL_VERSION = "0.0.10";
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

interface TunnelInstallManifest {
  version: 1;
  tunnelClientVersion: string;
  asset: string;
  archiveSha256: string;
  binarySha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function platformAsset(): string {
  const os = process.platform === "darwin" ? "darwin"
    : process.platform === "linux" ? "linux"
      : process.platform === "win32" ? "windows"
        : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;
  if (!os || !arch) throw new Error(`openai/tunnel-client has no pinned build for ${process.platform}/${process.arch}`);
  return `tunnel-client-v${TUNNEL_VERSION}-${os}-${arch}.zip`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
  return bytes;
}

function parseExpectedChecksum(text: string, asset: string): string {
  const line = text.split(/\r?\n/).find(candidate => candidate.trim().endsWith(asset));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`);
  return checksum;
}

function binaryPath(): string {
  return join(getConfigDir(), "bin", process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
}

function manifestPath(): string {
  return join(getConfigDir(), "bin", "tunnel-client-manifest.json");
}

export async function installTunnelClient(): Promise<string> {
  const executable = binaryPath();
  const manifestFile = manifestPath();
  if (existsSync(executable) && existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Partial<TunnelInstallManifest>;
    const actual = sha256(readFileSync(executable));
    if (manifest.version === 1 && manifest.tunnelClientVersion === TUNNEL_VERSION && manifest.binarySha256 === actual) {
      return executable;
    }
    throw new Error(`Existing tunnel-client failed integrity validation: ${executable}`);
  }

  const asset = platformAsset();
  const [archive, sums] = await Promise.all([
    fetchBytes(`${RELEASE_BASE}/${asset}`),
    fetchBytes(`${RELEASE_BASE}/SHA256SUMS.txt`),
  ]);
  const expected = parseExpectedChecksum(new TextDecoder().decode(sums), asset);
  const archiveHash = sha256(archive);
  if (archiveHash !== expected) throw new Error(`Checksum mismatch for ${asset}`);
  const files = unzipSync(archive);
  const expectedName = process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  const entry = Object.entries(files).find(([name]) => basename(name) === expectedName);
  if (!entry) throw new Error(`${asset} does not contain ${expectedName}`);
  const binary = entry[1];
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  atomicWriteFile(executable, binary);
  if (process.platform !== "win32") chmodSync(executable, 0o700);
  const manifest: TunnelInstallManifest = {
    version: 1,
    tunnelClientVersion: TUNNEL_VERSION,
    asset,
    archiveSha256: archiveHash,
    binarySha256: sha256(binary),
  };
  atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const version = runChecked(executable, ["--version"]);
  if (!version.stdout.includes(TUNNEL_VERSION) && !version.stderr.includes(TUNNEL_VERSION)) {
    throw new Error(`Installed tunnel-client did not report version ${TUNNEL_VERSION}`);
  }
  return executable;
}

export function installRuntimeKey(sourcePath: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Tunnel runtime key file does not exist: ${sourcePath}`);
  const key = readFileSync(sourcePath);
  if (key.byteLength === 0 || key.byteLength > 64 * 1024) throw new Error("Tunnel runtime key file is empty or unexpectedly large");
  return installRuntimeKeyBytes(key);
}

export function managedRuntimeKeyPath(): string {
  return join(getConfigDir(), "secrets", "tunnel-runtime.key");
}

export function installRuntimeKeyBytes(key: Uint8Array | string): string {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key.trim()) : key;
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("Tunnel runtime key is empty or unexpectedly large");
  const destination = managedRuntimeKeyPath();
  atomicWriteFile(destination, bytes);
  return destination;
}

export function createTunnelConfig(options: {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileName?: string;
  alias?: string;
}): TunnelConfig {
  if (!/^tunnel_[a-f0-9]{32}$/.test(options.tunnelId)) throw new Error("--tunnel-id must be tunnel_ followed by 32 lowercase hexadecimal characters");
  const profileName = options.profileName ?? "codex-chatgpt-web";
  const alias = options.alias ?? "codex-chatgpt-web";
  if (!/^[A-Za-z0-9._-]+$/.test(profileName) || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error("Tunnel profile and alias may contain only letters, digits, dot, underscore, and dash");
  }
  return {
    binaryPath: options.binaryPath,
    tunnelId: options.tunnelId,
    runtimeKeyFile: options.runtimeKeyFile,
    profileDir: join(getConfigDir(), "tunnel", "profiles"),
    profileName,
    alias,
  };
}

/**
 * Quote one argv item for tunnel-client's mcp.command parser.
 *
 * The pinned tunnel-client does not pass this string through cmd.exe on
 * Windows. It parses a small shell-like grammar itself and then calls
 * exec.Command with the resulting argv. Single quotes are therefore
 * intentional: unlike that parser's double quotes, they preserve Windows
 * backslashes verbatim.
 */
export function quoteTunnelCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function mcpCommand(config: AppConfig): string {
  return [...config.runtimeCommand, "mcp", "--broker-socket", config.brokerSocketPath]
    .map(quoteTunnelCommandArgument)
    .join(" ");
}

function tunnel(config: AppConfig): TunnelConfig {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel commands require full mode");
  return config.tunnel;
}

export function connectTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
  runChecked(settings.binaryPath, [
    "runtimes", "connect",
    "--alias", settings.alias,
    "--profile", settings.profileName,
    "--profile-dir", settings.profileDir,
    "--tunnel-client-bin", settings.binaryPath,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", `file:${settings.runtimeKeyFile}`,
    "--mcp-command", mcpCommand(config),
    "--json",
  ]);
}

export interface TunnelSession {
  readonly status: TunnelRuntimeStatus;
  stop: () => Promise<void>;
}

export interface TunnelSessionOperations {
  start: () => void | Promise<void>;
  status: () => Promise<TunnelRuntimeStatus>;
  stop: () => void | Promise<void>;
}

let activeTunnelSession: TunnelSession | undefined;
let tunnelSessionStarting = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function negotiateTunnelSession(operations: TunnelSessionOperations): Promise<TunnelSession> {
  // Clean up an interrupted earlier launcher before creating a runtime owned by
  // this foreground session.
  await operations.stop();
  try {
    await operations.start();
    const status = await operations.status();
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
    let stopPromise: Promise<void> | undefined;
    return {
      status,
      stop: () => {
        if (!stopPromise) {
          stopPromise = Promise.resolve()
            .then(() => operations.stop())
            .catch(error => {
              stopPromise = undefined;
              throw error;
            });
        }
        return stopPromise;
      },
    };
  } catch (error) {
    try {
      await operations.stop();
    } catch (cleanupError) {
      throw new Error(`${errorMessage(error)}; tunnel cleanup also failed: ${errorMessage(cleanupError)}`);
    }
    throw error;
  }
}

/**
 * Start the tunnel runtime as a descendant of the current session launcher.
 *
 * The Windows package launcher assigns the process tree to a kill-on-close Job
 * Object. That hard boundary covers terminal closure and launcher crashes even
 * after the short-lived `runtimes connect` command exits; the explicit stop
 * path remains responsible for normal graceful shutdown.
 */
export async function startTunnelSession(config: AppConfig, timeoutMs = 30_000): Promise<TunnelSession> {
  if (activeTunnelSession || tunnelSessionStarting) {
    throw new Error("A tunnel session is already active in this process");
  }
  tunnelSessionStarting = true;
  try {
    const owned = await negotiateTunnelSession({
      start: () => connectTunnel(config),
      status: () => waitForTunnelReady(config, timeoutMs),
      stop: () => stopTunnel(config),
    });
    const session: TunnelSession = {
      status: owned.status,
      stop: async () => {
        await owned.stop();
        if (activeTunnelSession === session) activeTunnelSession = undefined;
      },
    };
    activeTunnelSession = session;
    return session;
  } finally {
    tunnelSessionStarting = false;
  }
}

export function stopTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  const result = runCommand(settings.binaryPath, ["runtimes", "stop", settings.alias, "--json"]);
  if (result.status !== 0 && !isTunnelAlreadyStopped(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Failed to stop tunnel runtime: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export function isTunnelAlreadyStopped(output: string): boolean {
  return /not found|not running|not known|unknown alias/i.test(output);
}

export interface TunnelRuntimeStatus {
  ok: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  state?: string;
  detail: string;
}

function safeTunnelDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 2_000);
}

export function parseTunnelStatus(output: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(output) };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const processRunning = parsed.process_running === true;
    const healthy = parsed.healthy === true;
    const ready = parsed.ready === true;
    const state = typeof parsed.runtime_state === "string" ? parsed.runtime_state
      : typeof parsed.status === "string" ? parsed.status
        : undefined;
    const issues = parsed.local && typeof parsed.local === "object" && Array.isArray((parsed.local as { issues?: unknown }).issues)
      ? ((parsed.local as { issues: unknown[] }).issues).filter(issue => typeof issue === "string").slice(0, 3)
      : [];
    const explicitError = typeof parsed.error === "string" && parsed.error ? parsed.error : undefined;
    const ok = processRunning && healthy && ready;
    const detail = ok
      ? "process_running=true healthy=true ready=true"
      : safeTunnelDetail([`process_running=${processRunning}`, `healthy=${healthy}`, `ready=${ready}`, ...(state ? [`state=${state}`] : []), ...(explicitError ? [explicitError] : []), ...issues].join("; "));
    return { ok, processRunning, healthy, ready, ...(state ? { state } : {}), detail };
  } catch {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `tunnel-client returned non-JSON status: ${safeTunnelDetail(output)}` };
  }
}

export function tunnelStatus(config: AppConfig): TunnelRuntimeStatus {
  const settings = tunnel(config);
  if (!existsSync(settings.binaryPath)) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `Missing ${settings.binaryPath}` };
  }
  const result = runCommand(settings.binaryPath, ["runtimes", "status", settings.alias, "--json"]);
  let output = (result.stdout || result.stderr).trim();
  const service = getTunnelServiceStatus();
  if (result.status === 0 && (service.running || process.platform === "win32")) {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      // `runtimes status` probes the configured health and readiness endpoints
      // on every call. A foreground Windows runtime outlives the short
      // `runtimes connect` command while remaining inside the package
      // launcher's Job Object, so a successful live probe is stronger evidence
      // than stale supervisor PID metadata.
      if (service.running || (parsed.healthy === true && parsed.ready === true)) {
        parsed.process_running = true;
      }
      if (parsed.process_running === true && parsed.healthy === true && parsed.ready === true) {
        parsed.runtime_state = "ready";
      }
      output = JSON.stringify(parsed);
    } catch {
      // parseTunnelStatus owns the diagnostic for malformed output.
    }
  }
  return parseTunnelStatus(output, result.status);
}

export async function waitForTunnelReady(config: AppConfig, timeoutMs = 30_000): Promise<TunnelRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = tunnelStatus(config);
  while (!status.ok && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    status = tunnelStatus(config);
  }
  return status;
}

export function tunnelClientVersion(): string {
  return TUNNEL_VERSION;
}
