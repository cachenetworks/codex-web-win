import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RuntimeManifest {
  schemaVersion: number;
  appVersion: string;
  platform: string;
  arch: string;
  launcher: string;
  gui?: string;
  entrypoint: string;
}

const secretCanary = "sk-gui-smoke-DO-NOT-PRINT-e0efcc71ba90-extra";
const sourceBundle = resolve(process.argv[2] ?? "dist/runtime");
const sourceRoot = resolve(import.meta.dir, "..");

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function normalized(path: string): string {
  const full = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? full.toLowerCase() : full;
}

function assertSafeRelativeArtifact(path: string, label: string): void {
  assert(Boolean(path), `${label} is missing`);
  assert(!isAbsolute(path), `${label} must be bundle-relative: ${path}`);
  const segments = path.split(/[\\/]+/);
  assert(!segments.includes("..") && !segments.includes("."), `${label} escapes the bundle: ${path}`);
}

async function run(
  executable: string,
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    timeoutMs?: number;
    stdin?: string;
  } = {},
): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.stdin !== undefined) {
    const input = child.stdin;
    if (!input) fail(`stdin pipe was not created for ${basename(executable)}`);
    input.write(options.stdin);
    input.end();
  }
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? 10_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timedOut) {
    fail(`${basename(executable)} ${args.join(" ")} timed out\n${stderr}`);
  }
  return { exitCode, stdout, stderr };
}

function parseSingleJson(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  assert(trimmed.length > 0, `${label} produced no JSON`);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    assert(Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed), `${label} JSON is not an object`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`${label} did not emit one JSON object: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

function treeSnapshot(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        result[`${key}/`] = "directory";
        visit(path);
      } else if (entry.isFile()) {
        const bytes = readFileSync(path);
        result[key] = `${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`;
      } else {
        result[key] = `other:${statSync(path).mode}`;
      }
    }
  };
  visit(root);
  return result;
}

async function windowsPersistenceSnapshot(): Promise<Record<string, unknown>> {
  const script = String.raw`
$ErrorActionPreference = "SilentlyContinue"
$pattern = "(?i)codex[- ]chatgpt[- ]web"
$registry = @()
foreach ($path in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Run", "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce")) {
  $item = Get-ItemProperty -LiteralPath $path
  if ($item) {
    foreach ($property in $item.PSObject.Properties) {
      if ($property.Name -match $pattern -or [string]$property.Value -match $pattern) {
        $registry += [ordered]@{ path = $path; name = $property.Name; value = [string]$property.Value }
      }
    }
  }
}
$tasks = @(Get-ScheduledTask | Where-Object {
  $_.TaskName -match $pattern -or $_.TaskPath -match $pattern
} | ForEach-Object { "$($_.TaskPath)$($_.TaskName)" } | Sort-Object)
$services = @(Get-Service | Where-Object {
  $_.Name -match $pattern -or $_.DisplayName -match $pattern
} | ForEach-Object { "$($_.Name)|$($_.DisplayName)|$($_.Status)" } | Sort-Object)
$startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$startupFiles = @()
if ($startup) {
  $startupFiles = @(Get-ChildItem -Force -LiteralPath $startup | Where-Object {
    $_.Name -match $pattern
  } | ForEach-Object { $_.FullName } | Sort-Object)
}
[ordered]@{
  registry = @($registry | Sort-Object path, name, value)
  tasks = $tasks
  services = $services
  startupFiles = $startupFiles
} | ConvertTo-Json -Compress -Depth 6
`;
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: 20_000,
  });
  assert(result.exitCode === 0, `could not snapshot Windows persistence state: ${result.stderr}`);
  return parseSingleJson(result.stdout, "Windows persistence snapshot");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function locateFrameworkCompiler(): string {
  const windows = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const compiler = candidates.find(existsSync);
  return compiler ?? fail("Windows GUI lifecycle smoke requires the built-in .NET Framework C# compiler");
}

async function exerciseOuterJob(gui: string, root: string, environment: Record<string, string | undefined>): Promise<void> {
  const probeSource = join(sourceRoot, "scripts", "windows-gui-lifecycle-probe.cs");
  const probe = join(root, "windows-gui-lifecycle-probe.exe");
  const compiler = locateFrameworkCompiler();
  const compilation = await run(compiler, [
    "/nologo",
    "/optimize+",
    "/target:exe",
    `/out:${probe}`,
    probeSource,
  ], { cwd: sourceRoot, timeoutMs: 20_000 });
  assert(compilation.exitCode === 0 && existsSync(probe), `lifecycle probe compilation failed: ${compilation.stderr || compilation.stdout}`);

  const pidFile = join(root, "gui-job-pids.txt");
  const guiProcess = Bun.spawn([gui, "--lifecycle-smoke", probe, pidFile], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(guiProcess.stdout).text();
  const stderrPromise = new Response(guiProcess.stderr).text();
  let pids: number[] = [];
  try {
    const probeDeadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && guiProcess.exitCode === null && Date.now() < probeDeadline) {
      await Bun.sleep(25);
    }
    if (!existsSync(pidFile)) {
      if (guiProcess.exitCode === null) {
        fail("GUI lifecycle smoke timed out before creating descendants");
      }
      const earlyExit = await guiProcess.exited;
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      fail(`GUI lifecycle smoke exited before creating descendants (${earlyExit}): ${stderr || stdout}`);
    }

    pids = readFileSync(pidFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map(Number);
    assert(pids.length === 2 && pids.every(pid => Number.isInteger(pid) && pid > 0), `invalid lifecycle PID file: ${pids.join(",")}`);
    assert(pids.every(processExists), `GUI lifecycle probe did not leave both descendants alive: ${pids.join(",")}`);

    guiProcess.kill();
    await guiProcess.exited;
    await Promise.all([stdoutPromise, stderrPromise]);
    const deadline = Date.now() + 5_000;
    while (pids.some(processExists) && Date.now() < deadline) await Bun.sleep(25);
    const survivors = pids.filter(processExists);
    assert(survivors.length === 0, `hard-closing the GUI left Job Object descendants alive: ${survivors.join(", ")}`);
  } finally {
    if (guiProcess.exitCode === null) {
      guiProcess.kill();
      await guiProcess.exited;
    }
    await Promise.all([stdoutPromise, stderrPromise]);
    for (const pid of pids.filter(processExists)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
}

if (process.platform !== "win32") {
  process.stdout.write("WINDOWS_GUI_SMOKE_SKIPPED\n");
  process.exit(0);
}

assert(existsSync(sourceBundle), `Windows runtime bundle does not exist: ${sourceBundle}`);
const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-gui-smoke-"));
const firstLocation = join(root, "first-location");
const relocated = join(root, "relocated GUI \u03a9 & spaces");
const appHome = join(root, "private app state");

try {
  cpSync(sourceBundle, firstLocation, { recursive: true });
  cpSync(firstLocation, relocated, { recursive: true });
  rmSync(firstLocation, { recursive: true, force: true });

  const manifestPath = join(relocated, "manifest.json");
  assert(existsSync(manifestPath), "relocated bundle has no manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
  assert(manifest.schemaVersion === 1, `unexpected manifest schema: ${manifest.schemaVersion}`);
  assert(manifest.platform === "win32", `GUI smoke received a ${manifest.platform} bundle`);
  assertSafeRelativeArtifact(manifest.gui ?? "", "manifest.gui");
  assert(manifest.gui === "bin/codex-chatgpt-web-gui.exe", `unexpected manifest.gui: ${manifest.gui}`);

  const gui = join(relocated, manifest.gui);
  const launcher = join(relocated, manifest.launcher);
  const runtime = join(relocated, "runtime", "node.exe");
  const entrypoint = join(relocated, manifest.entrypoint);
  for (const [label, path] of Object.entries({ gui, launcher, runtime, entrypoint })) {
    assert(existsSync(path), `relocated ${label} is missing: ${path}`);
  }
  const guiBytes = readFileSync(gui);
  const guiHeader = guiBytes.subarray(0, 2).toString("ascii");
  assert(guiHeader === "MZ", `GUI is not a native Windows PE executable: ${gui}`);
  const peOffset = guiBytes.readUInt32LE(0x3c);
  assert(guiBytes.subarray(peOffset, peOffset + 4).toString("binary") === "PE\u0000\u0000", "GUI has an invalid PE signature");
  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderMagic = guiBytes.readUInt16LE(optionalHeaderOffset);
  assert(optionalHeaderMagic === 0x10b || optionalHeaderMagic === 0x20b, "GUI has an unsupported PE optional header");
  const subsystem = guiBytes.readUInt16LE(optionalHeaderOffset + 68);
  assert(subsystem === 2, `GUI PE subsystem is ${subsystem}; expected Windows GUI (2)`);
  const guiStrings = `${guiBytes.toString("utf8")}\n${guiBytes.toString("utf16le")}`.toLowerCase();
  for (const forbidden of [sourceRoot, dirname(sourceBundle), firstLocation]) {
    assert(!guiStrings.includes(normalized(forbidden)), `GUI embeds a non-relocatable build path: ${forbidden}`);
  }

  mkdirSync(appHome, { recursive: true });
  const portProbe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const availablePort = portProbe.port;
  portProbe.stop();
  const chromeCandidates = [
    process.env.PROGRAMW6432,
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ]
    .filter((directory): directory is string => Boolean(directory))
    .map(directory => join(directory, "Google", "Chrome", "Application", "chrome.exe"));
  const chromeExecutablePath = chromeCandidates.find(existsSync)
    ?? chromeCandidates[0]
    ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  const config = {
    version: 2,
    releaseVersion: manifest.appVersion,
    mode: "browser-only",
    host: "127.0.0.1",
    port: availablePort,
    contextWindow: 256_000,
    appName: "Codex Native",
    chromeExecutablePath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: join(appHome, "runtime", "turn-broker.sock"),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: secretCanary,
    runtimeCommand: [runtime, entrypoint],
    acknowledgedUnofficialAt: "2026-07-29T00:00:00.000Z",
  };
  const configPath = join(appHome, "config.json");
  const validConfigText = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, validConfigText);

  const environment = {
    ...process.env,
    CODEX_CHATGPT_WEB_HOME: appHome,
    OPENAI_API_KEY: secretCanary,
    CODEX_API_KEY: secretCanary,
    CODEX_ACCESS_TOKEN: secretCanary,
  };
  const persistenceBefore = await windowsPersistenceSnapshot();
  const homeBefore = treeSnapshot(appHome);

  const about = await run(gui, ["--about-json"], { env: environment, cwd: relocated, timeoutMs: 7_500 });
  assert(about.exitCode === 0, `--about-json failed (${about.exitCode}): ${about.stderr}`);
  assert(!`${about.stdout}\n${about.stderr}`.includes(secretCanary), "--about-json disclosed a secret canary");
  const metadata = parseSingleJson(about.stdout, "--about-json");
  assert(metadata.schemaVersion === 1, "--about-json has an unexpected schemaVersion");
  assert(metadata.app === "codex-chatgpt-web-gui", "--about-json has an unexpected app identifier");
  assert(metadata.version === manifest.appVersion, "--about-json version does not match the manifest");
  assert(metadata.platform === "win32", "--about-json platform is not win32");
  assert(metadata.architecture === manifest.arch || metadata.arch === manifest.arch, "--about-json architecture does not match the manifest");
  assert(metadata.portable === false, "--about-json must identify the installed/native GUI contract");
  assert(normalized(String(metadata.root)) === normalized(relocated), "--about-json root does not match the relocated bundle");
  assert(normalized(String(metadata.cliPath)) === normalized(launcher), "--about-json cliPath does not resolve to the relocated sibling launcher");

  const launcherVersion = await run(launcher, ["--version"], { env: environment, cwd: relocated, timeoutMs: 7_500 });
  assert(launcherVersion.exitCode === 0, `launcher --version failed (${launcherVersion.exitCode}): ${launcherVersion.stderr}`);
  assert(launcherVersion.stdout.trim() === manifest.appVersion, "launcher stdout was not forwarded from the bundled runtime");
  assert(!`${launcherVersion.stdout}\n${launcherVersion.stderr}`.includes(secretCanary), "launcher --version disclosed a secret canary");

  const launcherStatus = await run(launcher, ["gui", "status"], { env: environment, cwd: relocated, timeoutMs: 15_000 });
  assert(launcherStatus.exitCode === 0, `launcher gui status failed (${launcherStatus.exitCode}): ${launcherStatus.stderr}`);
  assert(!`${launcherStatus.stdout}\n${launcherStatus.stderr}`.includes(secretCanary), "launcher gui status disclosed a secret canary");
  const launcherStatusJson = parseSingleJson(launcherStatus.stdout, "launcher gui status");
  assert(launcherStatusJson.schemaVersion === 1, "launcher gui status has an unexpected schemaVersion");
  assert(typeof launcherStatusJson.configured === "boolean", "launcher gui status omitted its configured state");
  const launcherStartup = launcherStatusJson.startup as Record<string, unknown> | undefined;
  assert(launcherStartup?.automatic === false, "launcher gui status does not preserve the no-autostart contract");

  const selfTest = await run(gui, ["--self-test"], { env: environment, cwd: relocated, timeoutMs: 15_000 });
  assert(!`${selfTest.stdout}\n${selfTest.stderr}`.includes(secretCanary), "--self-test disclosed a secret canary");
  const selfTestJson = parseSingleJson(selfTest.stdout, "--self-test");
  assert(selfTestJson.schemaVersion === 1, "--self-test has an unexpected schemaVersion");
  assert(typeof selfTestJson.ok === "boolean", "--self-test must report a boolean ok field");
  assert(Array.isArray(selfTestJson.checks), "--self-test must report a checks array");
  const selfTestChecks = selfTestJson.checks as Array<Record<string, unknown>>;
  const cliTransportCheck = selfTestChecks.find(check => check.id === "cliTransport");
  assert(cliTransportCheck?.ok === true, "--self-test could not capture nested sibling CLI stdout");
  assert(selfTest.exitCode === (selfTestJson.ok ? 0 : 1), "--self-test exit code and ok field disagree");
  assert(JSON.stringify(treeSnapshot(appHome)) === JSON.stringify(homeBefore), "--self-test or --about-json mutated private application state");

  const incompleteConfig = `${JSON.stringify({ chromeExecutablePath }, null, 2)}\n`;
  writeFileSync(configPath, incompleteConfig);
  const malformedSelfTest = await run(gui, ["--self-test"], { env: environment, cwd: relocated, timeoutMs: 15_000 });
  writeFileSync(configPath, validConfigText);
  assert(!`${malformedSelfTest.stdout}\n${malformedSelfTest.stderr}`.includes(secretCanary), "malformed-config --self-test disclosed a secret canary");
  const malformedSelfTestJson = parseSingleJson(malformedSelfTest.stdout, "malformed-config --self-test");
  const malformedChecks = malformedSelfTestJson.checks as Array<Record<string, unknown>> | undefined;
  const malformedConfigCheck = Array.isArray(malformedChecks)
    ? malformedChecks.find(check => check.id === "config")
    : undefined;
  assert(malformedSelfTest.exitCode === 1 && malformedSelfTestJson.ok === false, "--self-test accepted an incomplete configuration");
  assert(malformedConfigCheck?.ok === false, "--self-test did not identify the incomplete configuration");
  assert(JSON.stringify(treeSnapshot(appHome)) === JSON.stringify(homeBefore), "malformed-config --self-test mutated private application state");

  writeFileSync(configPath, `{"version":2,"controlToken":${secretCanary}}\n`);
  const secretMalformedSelfTest = await run(gui, ["--self-test"], { env: environment, cwd: relocated, timeoutMs: 15_000 });
  writeFileSync(configPath, validConfigText);
  assert(
    !`${secretMalformedSelfTest.stdout}\n${secretMalformedSelfTest.stderr}`.includes(secretCanary),
    "malformed-config --self-test echoed secret-bearing parser input",
  );
  const secretMalformedJson = parseSingleJson(secretMalformedSelfTest.stdout, "secret-bearing malformed-config --self-test");
  assert(secretMalformedSelfTest.exitCode === 1 && secretMalformedJson.ok === false, "--self-test accepted invalid secret-bearing JSON");
  assert(JSON.stringify(treeSnapshot(appHome)) === JSON.stringify(homeBefore), "secret-bearing malformed-config --self-test mutated private application state");

  const persistenceAfter = await windowsPersistenceSnapshot();
  assert(JSON.stringify(persistenceAfter) === JSON.stringify(persistenceBefore), "headless GUI commands changed Windows startup persistence state");

  await exerciseOuterJob(gui, root, environment);
  process.stdout.write("WINDOWS_GUI_STDIO_TRANSPORT_SMOKE_OK\n");
  process.stdout.write("WINDOWS_GUI_OUTER_JOB_SMOKE_OK\n");
  process.stdout.write("WINDOWS_GUI_RELOCATABLE_HEADLESS_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
