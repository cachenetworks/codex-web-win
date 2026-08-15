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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? 20_000;
  try {
    const exitCode = await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new Error(`${basename(executable)} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return { exitCode, stdout: await stdoutPromise, stderr: await stderrPromise };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseSingleJson(text: string, label: string): Record<string, any> {
  const trimmed = text.trim();
  assert(trimmed.startsWith("{") && trimmed.endsWith("}"), `${label} did not return one JSON object: ${trimmed}`);
  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch (error) {
    fail(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeSnapshot(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!existsSync(root)) return entries;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const relativePath = relative(root, full).split(sep).join("/");
      const stat = statSync(full);
      if (stat.isDirectory()) {
        entries.set(`${relativePath}/`, "directory");
        visit(full);
      } else if (stat.isFile()) {
        entries.set(relativePath, `${stat.size}:${fileSha256(full)}`);
      }
    }
  };
  visit(root);
  return entries;
}

function assertTreeEqual(before: Map<string, string>, after: Map<string, string>, label: string): void {
  const beforeEntries = [...before.entries()].sort(([a], [b]) => a.localeCompare(b));
  const afterEntries = [...after.entries()].sort(([a], [b]) => a.localeCompare(b));
  assert(JSON.stringify(afterEntries) === JSON.stringify(beforeEntries), `${label} changed unexpectedly`);
}

async function windowsPersistenceSnapshot(): Promise<string> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$tasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -match 'codex|chatgpt' } | ForEach-Object { $_.TaskPath + $_.TaskName } | Sort-Object)",
    "$services = @(Get-Service | Where-Object { $_.Name -match 'codex|chatgpt' -or $_.DisplayName -match 'codex|chatgpt' } | ForEach-Object { $_.Name + ':' + $_.Status } | Sort-Object)",
    "$startup = @()",
    "$startupFolders = @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))",
    "foreach ($folder in $startupFolders) { if ($folder -and (Test-Path $folder)) { $startup += @(Get-ChildItem -Force $folder | Where-Object { $_.Name -match 'codex|chatgpt' } | ForEach-Object { $_.FullName }) } }",
    "[pscustomobject]@{ tasks=$tasks; services=$services; startup=@($startup | Sort-Object) } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000 });
  assert(result.exitCode === 0, `Windows persistence snapshot failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function compileLifecycleProbe(output: string): Promise<void> {
  const source = join(sourceRoot, "scripts", "windows-gui-lifecycle-probe.cs");
  assert(existsSync(source), `missing lifecycle probe source: ${source}`);
  const powershell = [
    "$ErrorActionPreference='Stop'",
    "$refs=@('System.dll','System.Core.dll','System.Windows.Forms.dll')",
    `$source=${JSON.stringify(source)}`,
    `$output=${JSON.stringify(output)}`,
    "Add-Type -Path $source -ReferencedAssemblies $refs -OutputAssembly $output -OutputType ConsoleApplication",
  ].join("; ");
  const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], { timeoutMs: 45_000 });
  assert(result.exitCode === 0, `lifecycle probe compilation failed: ${result.stderr}`);
}

async function lifecycleSmoke(gui: string, relocated: string, environment: Record<string, string | undefined>): Promise<void> {
  const probe = join(relocated, "gui-lifecycle-probe.exe");
  await compileLifecycleProbe(probe);
  const result = await run(probe, [gui], { env: environment, cwd: relocated, timeoutMs: 45_000 });
  assert(result.exitCode === 0, `GUI lifecycle smoke failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  assert(result.stdout.includes("GUI_LIFECYCLE_OK"), `GUI lifecycle smoke did not report success: ${result.stdout}`);
  rmSync(probe, { force: true });
}

const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-gui-smoke-"));
const firstLocation = join(root, "first-location");
const relocated = join(root, "relocated GUI Ω & spaces");
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

  // Freshly relocated Windows executables can spend several seconds in Defender/
  // SmartScreen inspection before user code starts. Keep the probe bounded, but
  // give cold binaries enough room to start on ordinary Windows installations.
  const coldStartTimeoutMs = 20_000;
  const about = await run(gui, ["--about-json"], { env: environment, cwd: relocated, timeoutMs: coldStartTimeoutMs });
  assert(about.exitCode === 0, `--about-json failed (${about.exitCode}): ${about.stderr}`);
  assert(!`${about.stdout}\n${about.stderr}`.includes(secretCanary), "--about-json disclosed a secret canary");
  const metadata = parseSingleJson(about.stdout, "--about-json");
  assert(metadata.schemaVersion === 1, "--about-json has an unexpected schemaVersion");
  assert(metadata.app === "codex-chatgpt-web-gui", "--about-json has an unexpected app identifier");
  assert(metadata.version === manifest.appVersion, "--about-json version does not match the manifest");
  assert(metadata.platform === "win32", "--about-json platform is not win32");
  assert(metadata.architecture === manifest.arch || metadata.arch === manifest.arch, "--about-json architecture does not match the manifest");
  assert(metadata.portable === false, "--about-json must identify the installed/native GUI contract");
  assert(
    normalized(String(metadata.root)) === normalized(relocated),
    `--about-json root does not match the relocated bundle (actual=${String(metadata.root)} expected=${relocated})`,
  );
  assert(normalized(String(metadata.cliPath)) === normalized(launcher), "--about-json cliPath does not resolve to the relocated sibling launcher");

  const launcherVersion = await run(launcher, ["--version"], { env: environment, cwd: relocated, timeoutMs: coldStartTimeoutMs });
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
  assert(selfTestJson.ok === (selfTest.exitCode === 0), "--self-test exit code does not match its JSON ok field");

  await lifecycleSmoke(gui, relocated, environment);

  const persistenceAfter = await windowsPersistenceSnapshot();
  assert(persistenceAfter === persistenceBefore, "GUI smoke changed Windows startup persistence");
  const homeAfter = treeSnapshot(appHome);
  assertTreeEqual(homeBefore, homeAfter, "GUI smoke app home");

  process.stdout.write("WINDOWS_GUI_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
