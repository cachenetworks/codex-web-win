import { existsSync } from "node:fs";
import { stdin } from "node:process";
import { delimiter, join } from "node:path";
import { browserLoginStateExists } from "./browser-login";
import {
  defaultChromeExecutable,
  getConfigDir,
  getConfigPath,
  loadConfig,
  loadConfigForSetup,
  type AppConfig,
} from "./config";
import { inspectCodexIntegration } from "./codex-integration";
import {
  existingFullSetupCredentials,
  setup,
  type SetupOptions,
  type SetupResult,
} from "./setup";
import { VERSION } from "./version";

const MAX_GUI_REQUEST_BYTES = 128 * 1024;
const STATUS_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 5_000;
const STOP_EXIT_TIMEOUT_MS = 12_000;

export interface GuiSetupRequest {
  mode: "browser-only" | "full";
  acknowledgedUnofficial: true;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  replaceCodexRoute?: boolean;
  port?: number;
  chromeExecutablePath?: string;
  appName?: string;
  tunnelId?: string;
  runtimeKeyValue?: string;
}

export interface GuiStatus {
  schemaVersion: 1;
  version: string;
  supported: boolean;
  platform: NodeJS.Platform;
  architecture: string;
  appHome: string;
  configPath: string;
  configured: boolean;
  configError?: string;
  configurationRecoverable: boolean;
  configurationReleaseVersion?: string;
  configurationCurrent: boolean;
  mode?: AppConfig["mode"];
  setup?: {
    port: number;
    appName: string;
    autoApproveToolCalls: boolean;
    fullCredentials: {
      tunnelIdConfigured: boolean;
      runtimeKeyConfigured: boolean;
    };
  };
  chrome: {
    path: string;
    found: boolean;
  };
  loginReady: boolean;
  codex: {
    applicationFound: boolean;
    executablePath?: string;
    installed: boolean;
    repairRequired: boolean;
    configPath?: string;
    errors: string[];
  };
  session: {
    running: boolean;
    healthy: boolean;
    port?: number;
    pid?: number;
    uptimeSeconds?: number;
    acceptingTurns?: boolean;
    activeHttpTurns?: number;
    activeBrowserTurns?: number;
    detail?: string;
  };
  startup: {
    automatic: false;
    description: string;
  };
}

function findCodexExecutable(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .map(part => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map(part => join(part, "codex.exe"));
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    candidates.push(join(localAppData, "Microsoft", "WindowsApps", "codex.exe"));
  }
  return candidates.find(candidate => existsSync(candidate));
}

function ownString(
  value: Record<string, unknown>,
  key: keyof GuiSetupRequest,
  maximumLength: number,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") throw new Error(`${key} must be a string`);
  const trimmed = candidate.trim();
  if (!trimmed) throw new Error(`${key} must not be empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximumLength) {
    throw new Error(`${key} is unexpectedly large`);
  }
  return trimmed;
}

function ownBoolean(
  value: Record<string, unknown>,
  key: keyof GuiSetupRequest,
): boolean | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "boolean") throw new Error(`${key} must be a boolean`);
  return candidate;
}

export function parseGuiSetupRequest(value: unknown): GuiSetupRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GUI setup input must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set<keyof GuiSetupRequest>([
    "mode",
    "acknowledgedUnofficial",
    "forceLogin",
    "autoApproveToolCalls",
    "replaceCodexRoute",
    "port",
    "chromeExecutablePath",
    "appName",
    "tunnelId",
    "runtimeKeyValue",
  ]);
  const unknown = Object.keys(raw).filter(key => !allowed.has(key as keyof GuiSetupRequest));
  if (unknown.length > 0) throw new Error(`Unknown GUI setup fields: ${unknown.join(", ")}`);
  if (raw.mode !== "browser-only" && raw.mode !== "full") {
    throw new Error("mode must be browser-only or full");
  }
  if (raw.acknowledgedUnofficial !== true) {
    throw new Error("The unofficial-browser-automation notice must be acknowledged");
  }

  const port = raw.port;
  if (port !== undefined && (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535)) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  const tunnelId = ownString(raw, "tunnelId", 128);
  const runtimeKeyValue = ownString(raw, "runtimeKeyValue", 64 * 1024);
  if (raw.mode === "full" && tunnelId && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
    throw new Error("tunnelId must be tunnel_ followed by 32 lowercase hexadecimal characters");
  }
  const forceLogin = ownBoolean(raw, "forceLogin");
  const autoApproveToolCalls = ownBoolean(raw, "autoApproveToolCalls");
  const replaceCodexRoute = ownBoolean(raw, "replaceCodexRoute");
  const chromeExecutablePath = ownString(raw, "chromeExecutablePath", 32 * 1024);
  const appName = ownString(raw, "appName", 512);

  return {
    mode: raw.mode,
    acknowledgedUnofficial: true,
    ...(forceLogin !== undefined ? { forceLogin } : {}),
    ...(autoApproveToolCalls !== undefined ? { autoApproveToolCalls } : {}),
    ...(replaceCodexRoute !== undefined ? { replaceCodexRoute } : {}),
    ...(port !== undefined ? { port: port as number } : {}),
    ...(chromeExecutablePath ? { chromeExecutablePath } : {}),
    ...(appName ? { appName } : {}),
    ...(tunnelId ? { tunnelId } : {}),
    ...(runtimeKeyValue ? { runtimeKeyValue } : {}),
  };
}

export async function readGuiSetupRequest(
  input: NodeJS.ReadableStream = stdin,
  maximumBytes = MAX_GUI_REQUEST_BYTES,
): Promise<GuiSetupRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) throw new Error(`GUI setup input exceeds ${maximumBytes} bytes`);
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("GUI setup input is empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("GUI setup input is not valid JSON");
  }
  return parseGuiSetupRequest(parsed);
}

export async function runGuiSetup(request: GuiSetupRequest): Promise<SetupResult> {
  const options: SetupOptions = {
    mode: request.mode,
    acknowledgedUnofficial: true,
    forceLogin: request.forceLogin,
    autoApproveToolCalls: request.autoApproveToolCalls,
    replaceCodexRoute: request.replaceCodexRoute,
    port: request.port,
    chromeExecutablePath: request.chromeExecutablePath,
    appName: request.appName,
    tunnelId: request.tunnelId,
    quiet: true,
    // This value arrives through an inherited anonymous stdin pipe. It is
    // never placed in argv, the environment, GUI logs, or an intermediate file.
    runtimeKeyValue: request.runtimeKeyValue,
  };
  return await setup(options);
}

async function sessionHealth(config: AppConfig): Promise<GuiStatus["session"]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        running: true,
        healthy: false,
        port: config.port,
        detail: `Responses proxy returned HTTP ${response.status}`,
      };
    }
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web") {
      return {
        running: true,
        healthy: false,
        port: config.port,
        detail: "The configured port belongs to another program",
      };
    }
    const exactRuntime = body.mode === config.mode && body.version === config.releaseVersion;
    return {
      running: true,
      healthy: exactRuntime && body.status === "ok",
      port: typeof body.port === "number" ? body.port : config.port,
      ...(typeof body.pid === "number" ? { pid: body.pid } : {}),
      ...(typeof body.uptime === "number" ? { uptimeSeconds: body.uptime } : {}),
      ...(typeof body.accepting_turns === "boolean" ? { acceptingTurns: body.accepting_turns } : {}),
      ...(typeof body.active_http_turns === "number" ? { activeHttpTurns: body.active_http_turns } : {}),
      ...(typeof body.active_browser_turns === "number" ? { activeBrowserTurns: body.active_browser_turns } : {}),
      ...(!exactRuntime ? { detail: "The running session does not match the saved mode or version" } : {}),
    };
  } catch (error) {
    return {
      running: false,
      healthy: false,
      port: config.port,
      detail: error instanceof Error && error.name !== "AbortError"
        ? error.message
        : "No foreground session is running",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getGuiStatus(): Promise<GuiStatus> {
  let config: AppConfig | undefined;
  let configError: string | undefined;
  let configurationRecoverable = false;
  if (existsSync(getConfigPath())) {
    try {
      config = loadConfig();
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
      try {
        // Keep setup fields and shutdown coordinates available after an
        // upgrade removes the executable referenced by the saved release.
        config = loadConfigForSetup();
        configurationRecoverable = true;
      } catch {
        // The strict error is the most useful status detail. Structurally
        // invalid configuration remains unavailable and fails closed.
      }
    }
  }
  const chromePath = config?.chromeExecutablePath ?? defaultChromeExecutable();
  const codexExecutable = findCodexExecutable();
  let codex: GuiStatus["codex"];
  try {
    const inspected = inspectCodexIntegration();
    codex = {
      applicationFound: Boolean(codexExecutable),
      ...(codexExecutable ? { executablePath: codexExecutable } : {}),
      installed: inspected.installed,
      repairRequired: inspected.installed && inspected.errors.length > 0,
      configPath: inspected.configPath,
      errors: inspected.errors,
    };
  } catch (error) {
    codex = {
      applicationFound: Boolean(codexExecutable),
      ...(codexExecutable ? { executablePath: codexExecutable } : {}),
      installed: false,
      repairRequired: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
  const session = config
    ? await sessionHealth(config)
    : { running: false, healthy: false, detail: "Complete setup before starting the session" };
  const reusableFullCredentials = existingFullSetupCredentials(config);
  return {
    schemaVersion: 1,
    version: VERSION,
    supported: process.platform === "win32",
    platform: process.platform,
    architecture: process.arch,
    appHome: getConfigDir(),
    configPath: getConfigPath(),
    configured: Boolean(config) && !configError,
    ...(configError ? { configError } : {}),
    configurationRecoverable,
    ...(config ? { configurationReleaseVersion: config.releaseVersion } : {}),
    configurationCurrent: !configError && config?.releaseVersion === VERSION,
    ...(config ? { mode: config.mode } : {}),
    ...(config ? {
      setup: {
        port: config.port,
        appName: config.appName,
        autoApproveToolCalls: config.autoApproveToolCalls,
        fullCredentials: {
          tunnelIdConfigured: reusableFullCredentials.tunnelId,
          runtimeKeyConfigured: reusableFullCredentials.runtimeKey,
        },
      },
    } : {}),
    chrome: {
      path: chromePath,
      found: existsSync(chromePath),
    },
    loginReady: config ? browserLoginStateExists(config) : false,
    codex,
    session,
    startup: {
      automatic: false,
      description: "The app runs only when the user opens it and never registers boot or sign-in startup.",
    },
  };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Foreground runtime process ${pid} did not exit within ${timeoutMs}ms`);
}

export async function requestGuiSessionStop(
  options: { waitForExit?: boolean } = {},
): Promise<{
  stopped: true;
  alreadyStopped: boolean;
  detail: string;
}> {
  if (!existsSync(getConfigPath())) {
    return { stopped: true, alreadyStopped: true, detail: "No configured session exists" };
  }
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (strictError) {
    try {
      config = loadConfigForSetup();
    } catch {
      throw strictError;
    }
  }

  let runtimePid: number | undefined;
  const healthController = new AbortController();
  const healthTimeout = setTimeout(() => healthController.abort(), STATUS_TIMEOUT_MS);
  try {
    const health = await fetch(`http://${config.host}:${config.port}/healthz`, {
      signal: healthController.signal,
      cache: "no-store",
    });
    if (!health.ok) throw new Error(`The configured port returned HTTP ${health.status}`);
    const body = await health.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web"
      || body.status !== "ok"
      || body.mode !== config.mode
      || (typeof body.port === "number" && body.port !== config.port)) {
      throw new Error("Refusing to stop the unrelated program using the configured port");
    }
    if (typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0) {
      runtimePid = body.pid;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { stopped: true, alreadyStopped: true, detail: "No foreground session is running" };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed|ECONNREFUSED|No foreground session/i.test(message)) {
      return { stopped: true, alreadyStopped: true, detail: "No foreground session is running" };
    }
    throw error;
  } finally {
    clearTimeout(healthTimeout);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STOP_TIMEOUT_MS);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/admin/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Foreground session refused shutdown with HTTP ${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    if (body.status !== "stopping" || body.accepting_turns !== false) {
      throw new Error("Foreground session returned an invalid shutdown acknowledgement");
    }
    if (options.waitForExit && runtimePid) {
      await waitForProcessExit(runtimePid, STOP_EXIT_TIMEOUT_MS);
    }
    return {
      stopped: true,
      alreadyStopped: false,
      detail: "Graceful foreground shutdown accepted",
    };
  } finally {
    clearTimeout(timeout);
  }
}
