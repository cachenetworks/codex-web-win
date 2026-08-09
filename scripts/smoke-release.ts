import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const sourceBundle = resolve(process.argv[2] ?? "dist/runtime");
const sourceRoot = resolve(import.meta.dir, "..");
const root = join(homedir(), `.codex-chatgpt-web-release-smoke-${process.pid}-${Date.now()}`);
const firstLocation = join(root, "first-location");
const runtimeRoot = join(root, "relocated-runtime");
cpSync(sourceBundle, firstLocation, { recursive: true });
const renameDeadline = Date.now() + 5_000;
for (;;) {
  try {
    renameSync(firstLocation, runtimeRoot);
    break;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32"
      || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
      || Date.now() >= renameDeadline) throw error;
    // Windows security scanners can briefly retain a handle to a newly copied
    // executable. The runtime relocation contract is unchanged after release.
    await Bun.sleep(50);
  }
}

const launcherName = process.platform === "win32" ? "codex-chatgpt-web.exe" : "codex-chatgpt-web";
const launcher = join(runtimeRoot, "bin", launcherName);
const runtimeExecutable = join(runtimeRoot, "runtime", process.platform === "win32" ? "node.exe" : "bun");
const supervisor = launcher;
const windowsGui = join(runtimeRoot, "bin", "codex-chatgpt-web-gui.exe");
const windowsUninstaller = join(runtimeRoot, "bin", "codex-chatgpt-web-uninstall.ps1");
const internalSuperviseFlag = "--codex-chatgpt-web-internal-supervise";
const cliBundle = readFileSync(join(runtimeRoot, "app", "cli.js"), "utf8");
const launcherText = readFileSync(launcher, "utf8");
for (const forbidden of [sourceRoot, dirname(sourceBundle), "/private/tmp/codex-chatgpt-web-verify", "/tmp/codex-chatgpt-web-verify"]) {
  if (cliBundle.includes(forbidden) || launcherText.includes(forbidden)) {
    throw new Error(`Runtime artifact embeds an ephemeral build path: ${forbidden}`);
  }
}

const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
if (manifest.schemaVersion !== 1 || manifest.appVersion !== "0.2.7" || manifest.playwright !== "1.62.0"
  || manifest.platform !== process.platform || manifest.arch !== process.arch
  || manifest.launcher !== `bin/${launcherName}` || !existsSync(runtimeExecutable)
  || (process.platform === "win32"
    && (manifest.nodeVersion !== "24.14.0"
      || manifest.supervisor !== "bin/codex-chatgpt-web.exe"
      || manifest.gui !== "bin/codex-chatgpt-web-gui.exe"
      || manifest.uninstaller !== "bin/codex-chatgpt-web-uninstall.ps1"
      || !existsSync(supervisor)
      || !existsSync(windowsGui)
      || !existsSync(windowsUninstaller)
      || !existsSync(join(runtimeRoot, "runtime", "Node-24.14.0-LICENSE.txt"))))) {
  throw new Error(`Unexpected runtime manifest: ${JSON.stringify(manifest)}`);
}
const cliEntrypoint = join(runtimeRoot, "app", "cli.js");
const launcherCommand = (args: string[]) => process.platform === "win32"
  ? [launcher, ...args]
  : [launcher, ...args];
const runtimeCommand = (args: string[]) => process.platform === "win32"
  ? [launcher, ...args]
  : [launcher, ...args];
const version = Bun.spawnSync(launcherCommand(["--version"]), { stdout: "pipe", stderr: "pipe" });
if (version.exitCode !== 0 || version.stdout.toString().trim() !== "0.2.7") {
  throw new Error(`Relocated launcher failed: ${version.stderr.toString()}`);
}

const appHome = join(root, "app-state");
const codexHome = join(root, "codex");
mkdirSync(join(appHome, "browser"), { recursive: true });
mkdirSync(codexHome, { recursive: true });
const portServer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = portServer.port;
portServer.stop();
const config = {
  version: 2,
  releaseVersion: "0.2.7",
  mode: "browser-only",
  host: "127.0.0.1",
  port,
  contextWindow: 256_000,
  appName: "Codex Native",
  chromeExecutablePath: process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
      ? join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")
      : "/usr/bin/google-chrome",
  storageStatePath: join(appHome, "browser", "storage-state.json"),
  brokerSocketPath: join(appHome, "runtime", "turn-broker.sock"),
  headed: true,
  proAvailable: true,
  autoApproveToolCalls: false,
  controlToken: "release-smoke-control-token-0123456789abcdef",
  runtimeCommand: process.platform === "win32" ? [runtimeExecutable, cliEntrypoint] : [launcher],
  acknowledgedUnofficialAt: new Date().toISOString(),
};
writeFileSync(join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });

const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome, CODEX_HOME: codexHome };
const child = Bun.spawn(runtimeCommand([process.platform === "win32" ? "session" : "serve"]), {
  env,
  stdout: "pipe",
  stderr: "pipe",
});
try {
  const deadline = Date.now() + 10_000;
  let health: Response | undefined;
  while (Date.now() < deadline) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (health.ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  if (!health?.ok) throw new Error("relocated daemon did not become healthy");
  const payload = await health.json() as Record<string, unknown>;
  if (payload.service !== "codex-chatgpt-web" || payload.mode !== "browser-only") {
    throw new Error(`unexpected health payload: ${JSON.stringify(payload)}`);
  }

  const unauthenticatedModels = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const unauthenticatedModelsBody = await unauthenticatedModels.json() as { error?: { message?: string } };
  if (unauthenticatedModels.status !== 502
    || !unauthenticatedModelsBody.error?.message?.includes("incoming Bearer authorization")) {
    throw new Error(`native model passthrough did not fail closed without Codex auth: ${JSON.stringify(unauthenticatedModelsBody)}`);
  }
  const websocketNegotiation = await fetch(`http://127.0.0.1:${port}/v1/responses`);
  if (websocketNegotiation.status !== 426) {
    throw new Error(`Responses WebSocket negotiation did not select Codex HTTP/SSE fallback: HTTP ${websocketNegotiation.status}`);
  }
  const invalid = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: "test", stream: false }),
  });
  if (invalid.status !== 400) throw new Error(`unsupported model did not fail closed: HTTP ${invalid.status}`);

  const unauthorizedDrain = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-release-smoke-token" },
  });
  if (unauthorizedDrain.status !== 401) throw new Error(`lifecycle control accepted an invalid token: HTTP ${unauthorizedDrain.status}`);

  const drain = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
  });
  const drainPayload = await drain.json() as Record<string, unknown>;
  if (!drain.ok || drainPayload.accepting_turns !== false
    || drainPayload.active_http_turns !== 0 || drainPayload.active_browser_turns !== 0) {
    throw new Error(`daemon did not acknowledge an idle authenticated drain: ${JSON.stringify(drainPayload)}`);
  }
  const rejectedWhileDraining = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/high", reasoning: { effort: "high" }, input: "test", stream: false }),
  });
  if (rejectedWhileDraining.status !== 503) {
    throw new Error(`daemon accepted a new turn while draining: HTTP ${rejectedWhileDraining.status}`);
  }
  const resume = await fetch(`http://127.0.0.1:${port}/admin/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
  });
  const resumePayload = await resume.json() as Record<string, unknown>;
  if (!resume.ok || resumePayload.accepting_turns !== true) {
    throw new Error(`daemon did not resume after the drain smoke: ${JSON.stringify(resumePayload)}`);
  }

  if (process.platform === "win32") {
    const exactArguments = ["plain", "two words", "embedded\"quote", "trailing\\", "", "tab\targument"];
    const expectedArguments = JSON.stringify(exactArguments);
    const argumentProbe = Bun.spawnSync([
      supervisor,
      internalSuperviseFlag,
      runtimeExecutable,
      "-e",
      `if (JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(expectedArguments)}) process.exit(41)`,
      ...exactArguments,
    ], { stdout: "pipe", stderr: "pipe" });
    if (argumentProbe.exitCode !== 0) {
      throw new Error(`Windows supervisor argument/exit-code smoke failed (${argumentProbe.exitCode}): ${argumentProbe.stderr.toString()}`);
    }
    const exitProbe = Bun.spawnSync([
      supervisor,
      internalSuperviseFlag,
      runtimeExecutable,
      "-e",
      "process.exit(37)",
    ], { stdout: "pipe", stderr: "pipe" });
    if (exitProbe.exitCode !== 37) {
      throw new Error(`Windows supervisor did not preserve child exit code 37: ${exitProbe.exitCode}`);
    }

    const grandchildPidPath = join(root, "job-grandchild.pid");
    const primaryCode = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(child.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("");
    const supervised = Bun.spawn([supervisor, internalSuperviseFlag, runtimeExecutable, "-e", primaryCode], {
      stdout: "ignore",
      stderr: "pipe",
    });
    let grandchildPid = 0;
    const pidDeadline = Date.now() + 5_000;
    while (Date.now() < pidDeadline) {
      if (existsSync(grandchildPidPath)) {
        grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
        if (Number.isInteger(grandchildPid) && grandchildPid > 0) break;
      }
      await Bun.sleep(25);
    }
    if (!grandchildPid) {
      supervised.kill();
      await supervised.exited;
      throw new Error(`Windows Job Object smoke did not create a grandchild: ${await new Response(supervised.stderr).text()}`);
    }
    supervised.kill();
    await supervised.exited;
    const processExists = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exitDeadline = Date.now() + 5_000;
    while (processExists(grandchildPid) && Date.now() < exitDeadline) await Bun.sleep(25);
    if (processExists(grandchildPid)) {
      try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      throw new Error(`Windows Job Object allowed grandchild PID ${grandchildPid} to survive supervisor termination`);
    }
  }

  if ((process.platform === "darwin" || process.platform === "win32") && existsSync(config.chromeExecutablePath)) {
    const browser = Bun.spawn(runtimeCommand(["browser", "check"]), { env, stdout: "pipe", stderr: "pipe" });
    const browserExit = await Promise.race([
      browser.exited,
      Bun.sleep(30_000).then(() => undefined),
    ]);
    if (browserExit === undefined) {
      browser.kill();
      await browser.exited;
      throw new Error("relocated Playwright smoke timed out after 30000ms");
    }
    if (browserExit !== 0) {
      throw new Error(`relocated Playwright smoke failed: ${await new Response(browser.stderr).text()}`);
    }
  }
  process.stdout.write("RELOCATABLE_RUNTIME_SMOKE_OK\n");
} finally {
  child.kill("SIGTERM");
  await child.exited;
  rmSync(root, { recursive: true, force: true });
}
