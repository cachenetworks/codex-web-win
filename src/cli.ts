#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { existsSync, rmSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { checkBrowserEngine, loginToChatGpt } from "./browser-login";
import { getConfigDir, getConfigPath, loadConfig, loadConfigForSetup, saveConfig } from "./config";
import { installCodexIntegration, uninstallCodexIntegration } from "./codex-integration";
import { formatDoctorReport, runDoctor } from "./doctor";
import { runChatGptMcpMain } from "./adapters/chatgpt-web/mcp-main";
import { externalUrlOpenCommand, runCommand } from "./process";
import { startServer } from "./server";
import {
  getGuiStatus,
  readGuiSetupRequest,
  requestGuiSessionStop,
  runGuiSetup,
} from "./gui-control";
import { assertServiceIdle, cancelBrowserTurns, getServiceStatus, installService, restartService, startService, stopService, uninstallService } from "./service";
import { existingFullSetupCredentials, setup, type SetupOptions } from "./setup";
import {
  installRuntimeKeyBytes,
  managedRuntimeKeyPath,
  startTunnelSession,
  stopTunnel,
  tunnelStatus,
  waitForTunnelReady,
  type TunnelSession,
} from "./tunnel";
import { getTunnelServiceStatus, restartTunnelService, startTunnelService, stopTunnelService, uninstallTunnelService } from "./tunnel-service";
import { VERSION } from "./version";

const HELP = `codex-chatgpt-web ${VERSION}

Focused ChatGPT web-backed models for the native Codex harness.

Usage:
  codex-chatgpt-web setup --browser-only [options]
  codex-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH [options]
  codex-chatgpt-web login
  codex-chatgpt-web doctor [--json]
  codex-chatgpt-web browser check
  codex-chatgpt-web gui <status|setup|stop-session>
  codex-chatgpt-web session
  codex-chatgpt-web serve
  codex-chatgpt-web mcp [--broker-socket PATH]
  codex-chatgpt-web service <status|install|start|restart|stop|cancel-turns>
  codex-chatgpt-web tunnel <status|start|restart|stop|key-import>
  codex-chatgpt-web open <tunnels|runtime-keys|connectors>
  codex-chatgpt-web uninstall --yes

Setup options:
  --browser-only               Fixed Instant–Pro models, full context/images, no local tools or tunnel
  --full                       Fixed Instant–Extra High tool models plus read-only Pro
  --port NUMBER                Loopback Responses port (default: 17841)
  --chrome PATH                Google Chrome executable
  --app-name NAME              ChatGPT connector name (default: Codex Native <computer>)
  --tunnel-id ID               Existing OpenAI tunnel id (full mode)
  --runtime-key-file PATH      File containing a Tunnels Read+Use runtime key
  --replace-codex-route        Reversibly replace an existing openai_base_url
  --restart-service            Explicitly restart this project's daemon after an update
  --login                      Refresh the stored ChatGPT login even if one exists
  --auto-approve-tool-calls    Opt in to per-call browser clicks on "Allow once" prompts
  --acknowledge-unofficial     Accept the one-time unofficial-browser-automation notice

Global:
  --home PATH                  Override ~/.codex-chatgpt-web
  -h, --help
  -v, --version
`;

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

async function confirm(question: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await reader.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

async function prompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  const reader = createInterface({ input: stdin, output: stdout });
  try { return (await reader.question(question)).trim(); }
  finally { reader.close(); }
}

async function secretPrompt(question: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) return "";
  stdout.write(question);
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const reader = createInterface({ input: stdin, output: muted, terminal: true });
  try { return (await reader.question("")).trim(); }
  finally {
    reader.close();
    stdout.write("\n");
  }
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

async function setupCommand(args: string[]): Promise<void> {
  const browserOnly = takeFlag(args, "--browser-only");
  const full = takeFlag(args, "--full");
  if (browserOnly === full) throw new Error("Choose exactly one setup mode: --browser-only or --full");
  const portRaw = takeOption(args, "--port");
  let acknowledged = takeFlag(args, "--acknowledge-unofficial");
  const options: SetupOptions = {
    mode: full ? "full" : "browser-only",
    ...(portRaw ? { port: Number(portRaw) } : {}),
  };
  const appName = takeOption(args, "--app-name");
  const tunnelId = takeOption(args, "--tunnel-id");
  const runtimeKeyFile = takeOption(args, "--runtime-key-file");
  const chrome = takeOption(args, "--chrome");
  if (chrome) options.chromeExecutablePath = chrome;
  if (appName) options.appName = appName;
  if (tunnelId) options.tunnelId = tunnelId;
  if (runtimeKeyFile) options.runtimeKeyFile = runtimeKeyFile;
  options.forceLogin = takeFlag(args, "--login");
  options.autoApproveToolCalls = takeFlag(args, "--auto-approve-tool-calls");
  options.replaceCodexRoute = takeFlag(args, "--replace-codex-route");
  options.restartService = takeFlag(args, "--restart-service");
  assertNoArgs(args);

  if (!acknowledged) {
    stdout.write(
      "This is independent, unofficial software. It automates your ChatGPT web session, can break when the UI changes, "
      + "and must not be used to evade usage limits or access controls.\n",
    );
    acknowledged = await confirm("Continue and store this acknowledgement?");
  }
  if (!acknowledged) throw new Error("Setup cancelled: acknowledgement was not provided");
  options.acknowledgedUnofficial = true;

  const existing = existsSync(getConfigPath()) ? loadConfigForSetup() : undefined;
  const reusableCredentials = existingFullSetupCredentials(existing);
  const needsTunnelId = !options.tunnelId && !reusableCredentials.tunnelId;
  const needsRuntimeKey = !options.runtimeKeyFile
    && !reusableCredentials.runtimeKey
    && !existsSync(managedRuntimeKeyPath());

  if (full && (needsTunnelId || needsRuntimeKey) && stdin.isTTY) {
    stdout.write("Full mode needs an OpenAI tunnel and a runtime key with Tunnels Read + Use.\n");
    stdout.write("Tunnels: https://platform.openai.com/settings/organization/tunnels\n");
    stdout.write("Runtime keys: https://platform.openai.com/settings/organization/api-keys\n");
    if (needsTunnelId) options.tunnelId = await prompt("Tunnel id: ");
    if (needsRuntimeKey) {
      options.runtimeKeyValue = await secretPrompt("Runtime key (hidden): ");
    }
  }

  const result = await setup(options);
  stdout.write(`Setup complete: ${result.mode}\n`);
  stdout.write(`Config: ${result.configPath}\n`);
  if (result.connectorSetupRequired) {
    stdout.write("One account-level step remains: attach the tunnel to the ChatGPT connector named in config.\n");
    stdout.write("Open: https://chatgpt.com/#settings/Connectors\n");
  }
  if (process.platform === "win32") {
    stdout.write("Start the on-demand runtime from the Codex ChatGPT Web desktop app.\n");
    stdout.write("Advanced users can instead run `codex-chatgpt-web session` in an independent terminal.\n");
    stdout.write("Windows startup remains disabled; closing the app or session stops the proxy and all descendants.\n");
  }
  stdout.write("Restart the Codex app once so its native model catalog refreshes through the installed route.\n");
}

async function doctorCommand(args: string[]): Promise<void> {
  const json = takeFlag(args, "--json");
  assertNoArgs(args);
  const report = await runDoctor();
  stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (!report.ok) process.exitCode = 1;
}

async function serviceCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  const config = action === "status" ? undefined : loadConfig();
  if (action === "cancel-turns") {
    const cancelled = await cancelBrowserTurns(config!);
    stdout.write(`${JSON.stringify({ cancelledBrowserTurns: cancelled }, null, 2)}\n`);
    return;
  }
  const status = action === "status" ? getServiceStatus()
    : action === "install" ? installService(config!)
      : action === "start" ? startService()
        : action === "restart" ? await restartService(config!)
          : action === "stop" ? await stopService(config!)
            : undefined;
  if (!status) throw new Error(`Unknown service action: ${action}`);
  stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function tunnelCommand(args: string[]): Promise<void> {
  const action = args.shift() ?? "status";
  assertNoArgs(args);
  if (action === "key-import") {
    const key = await secretPrompt("Runtime key (hidden): ");
    if (!key) throw new Error("A non-empty runtime key is required");
    installRuntimeKeyBytes(key);
    stdout.write(`Runtime key stored privately at ${managedRuntimeKeyPath()}\n`);
    return;
  }
  const config = loadConfig();
  if (action === "start") startTunnelService();
  else if (action === "restart") {
    await assertServiceIdle(config);
    await restartTunnelService();
  }
  else if (action === "stop") {
    await assertServiceIdle(config);
    await stopTunnelService();
    stopTunnel(config);
  }
  else if (action !== "status") throw new Error(`Unknown tunnel action: ${action}`);
  const status = action === "start" || action === "restart"
    ? await waitForTunnelReady(config)
    : tunnelStatus(config);
  const service = getTunnelServiceStatus();
  stdout.write(`${JSON.stringify({ service, runtime: status }, null, 2)}\n`);
  if (action !== "stop" && ((service.supported && !service.running) || !status.ok)) process.exitCode = 1;
}

async function openCommand(args: string[]): Promise<void> {
  const target = args.shift();
  assertNoArgs(args);
  const urls: Record<string, string> = {
    tunnels: "https://platform.openai.com/settings/organization/tunnels",
    "runtime-keys": "https://platform.openai.com/settings/organization/api-keys",
    connectors: "https://chatgpt.com/#settings/Connectors",
  };
  const url = target ? urls[target] : undefined;
  if (!url) throw new Error("Choose one of: tunnels, runtime-keys, connectors");
  const opener = externalUrlOpenCommand(url);
  if (opener) {
    const result = runCommand(opener.command, opener.args, { windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr.trim() || `Could not open ${url}`);
  } else {
    stdout.write(`${url}\n`);
  }
}

async function guiCommand(args: string[]): Promise<void> {
  const action = args.shift();
  assertNoArgs(args);
  if (process.platform !== "win32") {
    throw new Error("The guided desktop app is available on Windows only");
  }
  if (action === "status") {
    stdout.write(`${JSON.stringify(await getGuiStatus())}\n`);
    return;
  }
  if (action === "setup") {
    const request = await readGuiSetupRequest();
    const result = await runGuiSetup(request);
    stdout.write(`${JSON.stringify({ schemaVersion: 1, status: "complete", ...result })}\n`);
    return;
  }
  if (action === "stop-session") {
    stdout.write(`${JSON.stringify(await requestGuiSessionStop({ waitForExit: true }))}\n`);
    return;
  }
  throw new Error("GUI command must be one of: status, setup, stop-session");
}

async function uninstallCommand(args: string[]): Promise<void> {
  const yes = takeFlag(args, "--yes");
  const keepData = takeFlag(args, "--keep-data");
  assertNoArgs(args);
  if (!yes && !await confirm("Restore Codex config, stop services, and remove this installation?")) {
    throw new Error("Uninstall cancelled");
  }
  let config: ReturnType<typeof loadConfig> | undefined;
  if (existsSync(getConfigPath())) {
    try {
      config = loadConfig();
    } catch (strictError) {
      try {
        // A removed prior release must not make its own state impossible to
        // stop and uninstall. The recovery loader still rejects malformed,
        // relative, or ephemeral runtime commands.
        config = loadConfigForSetup();
      } catch {
        throw strictError;
      }
    }
  }
  if (!config && process.platform === "darwin" && getServiceStatus().installed) {
    throw new Error("Service exists but configuration is missing; refusing an unverifiable uninstall");
  }
  if (config && process.platform === "win32") {
    await requestGuiSessionStop({ waitForExit: true });
  }
  if (config && process.platform === "darwin") await assertServiceIdle(config);
  uninstallCodexIntegration();
  if (config?.mode === "full") {
    if (process.platform === "darwin") await uninstallTunnelService();
    stopTunnel(config);
  }
  if (config && process.platform === "darwin") await uninstallService(config);
  if (!keepData) rmSync(getConfigDir(), { recursive: true, force: true });
  stdout.write(keepData ? "Uninstalled; private application data was preserved.\n" : "Uninstalled and removed private application data.\n");
}

const shutdownSignals = (): NodeJS.Signals[] => [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  ...(process.platform === "win32" ? ["SIGBREAK" as NodeJS.Signals] : []),
];

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise(resolveSignal => {
    const listeners = new Map<NodeJS.Signals, () => void>();
    const finish = (signal: NodeJS.Signals) => {
      for (const [registered, listener] of listeners) process.off(registered, listener);
      resolveSignal(signal);
    };
    for (const signal of shutdownSignals()) {
      const listener = () => finish(signal);
      listeners.set(signal, listener);
      process.once(signal, listener);
    }
  });
}

async function runForeground(config: ReturnType<typeof loadConfig>, ownTunnel: boolean): Promise<void> {
  // Repair the exact pre-change /v1 model route every time the foreground
  // owner starts. This makes stale journals from earlier bridge experiments
  // unable to leave Codex on its native catalog.
  installCodexIntegration(config, { replaceExistingRoute: true });
  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<"GUI">(resolveShutdown => {
    requestShutdown = () => resolveShutdown("GUI");
  });
  const waitsForTunnel = ownTunnel && config.mode === "full";
  const server = await startServer(
    config,
    {
      ...(process.platform === "win32" ? { onShutdownRequest: requestShutdown } : {}),
      initialAcceptingTurns: !waitsForTunnel,
    },
  );
  let tunnel: TunnelSession | undefined;
  let stoppingFor: NodeJS.Signals | "GUI" | undefined;
  try {
    if (waitsForTunnel) {
      tunnel = await startTunnelSession(config);
      server.setAcceptingTurns(true);
    }
    stdout.write(
      `codex-chatgpt-web ${VERSION} listening on http://${config.host}:${server.port}/v1 (${config.mode})\n`,
    );
    if (ownTunnel) {
      stdout.write("Foreground session owns the proxy, controlled Chrome, and full-mode tunnel. Press Ctrl+C to stop.\n");
    }
    stoppingFor = await Promise.race([waitForShutdownSignal(), shutdownRequested]);
  } finally {
    if (stoppingFor) stdout.write(`Stopping codex-chatgpt-web after ${stoppingFor}...\n`);
    const results = await Promise.allSettled([
      server.stop(true),
      ...(tunnel ? [tunnel.stop()] : []),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (failures.length > 0) throw new Error(`foreground shutdown failed: ${failures.join("; ")}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CODEX_CHATGPT_WEB_HOME = home;
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }
  if (takeFlag(args, "--version") || takeFlag(args, "-v")) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  const command = args.shift() ?? "help";
  if (command === "help") stdout.write(HELP);
  else if (command === "setup") await setupCommand(args);
  else if (command === "login") {
    assertNoArgs(args);
    const config = loadConfig();
    const result = await loginToChatGpt(config);
    config.proAvailable = result.proAvailable;
    saveConfig(config);
    stdout.write(`ChatGPT login stored at ${result.storageStatePath}\n`);
  } else if (command === "doctor" || command === "status") await doctorCommand(args);
  else if (command === "browser") {
    const action = args.shift();
    assertNoArgs(args);
    if (action !== "check") throw new Error("Browser command must be: browser check");
    await checkBrowserEngine(loadConfig());
    stdout.write("Playwright can launch the configured Chrome executable.\n");
  } else if (command === "gui") await guiCommand(args);
  else if (command === "session") {
    assertNoArgs(args);
    if (process.platform !== "win32") {
      throw new Error("The foreground `session` owner is for Windows; macOS uses its managed services.");
    }
    await runForeground(loadConfig(), true);
  } else if (command === "serve") {
    assertNoArgs(args);
    await runForeground(loadConfig(), false);
  } else if (command === "mcp") await runChatGptMcpMain(args);
  else if (command === "service") await serviceCommand(args);
  else if (command === "tunnel") await tunnelCommand(args);
  else if (command === "open") await openCommand(args);
  else if (command === "uninstall") await uninstallCommand(args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`codex-chatgpt-web: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
