import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PackageMetadata {
  version?: string;
}

interface SessionProcess {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

const projectRoot = resolve(import.meta.dir, "..");
const packageMetadata = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
) as PackageMetadata;
const packageVersion = packageMetadata.version;
const setupPath = resolve(
  process.argv[2] ?? join(projectRoot, "dist", "codex-chatgpt-web-windows-x64-setup.exe"),
);
const smokeRootPrefix = "upgrade-repair-";

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

function assertWithin(root: string, candidate: string, label: string): void {
  const child = relative(resolve(root), resolve(candidate));
  assert(
    child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)),
    `${label} escaped the isolated smoke root: ${candidate}`,
  );
}

function parseSingleJson(text: string, label: string): Record<string, unknown> {
  const trimmed = text.trim();
  assert(trimmed.length > 0, `${label} produced no JSON`);
  try {
    const value = JSON.parse(trimmed) as unknown;
    assert(Boolean(value) && typeof value === "object" && !Array.isArray(value), `${label} JSON is not an object`);
    return value as Record<string, unknown>;
  } catch (error) {
    fail(`${label} did not emit one JSON object: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
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
  }, options.timeoutMs ?? 15_000);
  const exitCode = await child.exited;
  clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  if (timedOut) fail(`${basename(executable)} ${args.join(" ")} timed out\n${stderr || stdout}`);
  return { exitCode, stdout, stderr };
}

async function availableLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate an isolated loopback port"));
        return;
      }
      const port = address.port;
      server.close(error => error ? rejectPort(error) : resolvePort(port));
    });
  });
}

function previousVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return "0.0.0-retired";
  const patch = Number(match[3]);
  return patch > 0
    ? `${match[1]}.${match[2]}.${patch - 1}`
    : `${match[1]}.${match[2]}.0-retired`;
}

function isolatedEnvironment(appHome: string, codexHome: string): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
      && !entry[0].toUpperCase().startsWith("CODEX_CHATGPT_WEB_")
      && entry[0].toUpperCase() !== "CODEX_HOME",
  );
  return {
    ...Object.fromEntries(inherited),
    CODEX_CHATGPT_WEB_HOME: appHome,
    CODEX_HOME: codexHome,
  };
}

function fingerprint(path: string): string {
  if (!existsSync(path)) return "missing";
  const bytes = readFileSync(path);
  return `${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`;
}

function realUserState(): Record<string, string> {
  const actualAppHome = resolve(join(homedir(), ".codex-chatgpt-web"));
  const actualCodexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
  return {
    appConfig: fingerprint(join(actualAppHome, "config.json")),
    integrationJournal: fingerprint(join(actualAppHome, "codex", "integration-journal.json")),
    codexConfig: fingerprint(join(actualCodexHome, "config.toml")),
    codexModels: fingerprint(join(actualCodexHome, "models_cache.json")),
  };
}

function seedRuntimeBundle(
  path: string,
  version: string,
  architecture: string,
  marker?: string,
): void {
  mkdirSync(join(path, "bin"), { recursive: true });
  mkdirSync(join(path, "app"), { recursive: true });
  mkdirSync(join(path, "runtime"), { recursive: true });
  writeFileSync(join(path, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    appVersion: version,
    platform: "win32",
    arch: architecture,
    launcher: "bin/codex-chatgpt-web.exe",
    supervisor: "bin/codex-chatgpt-web.exe",
    gui: "bin/codex-chatgpt-web-gui.exe",
    uninstaller: "bin/codex-chatgpt-web-uninstall.ps1",
    entrypoint: "app/cli.js",
  }, null, 2)}\n`);
  for (const relativePath of [
    join("bin", "codex-chatgpt-web.exe"),
    join("bin", "codex-chatgpt-web-gui.exe"),
    join("bin", "codex-chatgpt-web-uninstall.ps1"),
    join("app", "cli.js"),
    join("runtime", "node.exe"),
  ]) {
    writeFileSync(join(path, relativePath), `verified runtime fixture ${relativePath}\n`);
  }
  if (marker) writeFileSync(join(path, marker), `${version} must be preserved\n`);
}

const tunnelClientShimSource = String.raw`using System;
using System.IO;
using System.Text;

internal static class OfflineUpgradeSmokeTunnelClient
{
    private static int Main(string[] args)
    {
        string logPath = Environment.GetEnvironmentVariable("CODEX_CHATGPT_WEB_SMOKE_TUNNEL_LOG");
        if (String.IsNullOrWhiteSpace(logPath))
        {
            Console.Error.WriteLine("isolated invocation log is unavailable");
            return 64;
        }

        File.AppendAllText(
            logPath,
            String.Join("\u001f", args) + Environment.NewLine,
            new UTF8Encoding(false)
        );

        bool expectedStop = args.Length == 4
            && args[0] == "runtimes"
            && args[1] == "stop"
            && args[2] == "codex-chatgpt-web"
            && args[3] == "--json";
        if (!expectedStop)
        {
            Console.Error.WriteLine("unexpected offline smoke command");
            return 65;
        }

        Console.WriteLine("{\"status\":\"not running\"}");
        return 0;
    }
}
`;

async function seedAttestedTunnelClient(
  executable: string,
  manifestPath: string,
  sourcePath: string,
  environment: Record<string, string>,
  cwd: string,
): Promise<void> {
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, tunnelClientShimSource);
  const compileEnvironment = {
    ...environment,
    CODEX_CHATGPT_WEB_SMOKE_TUNNEL_SOURCE: sourcePath,
    CODEX_CHATGPT_WEB_SMOKE_TUNNEL_OUTPUT: executable,
  };
  const compile = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "$ErrorActionPreference = 'Stop'; Add-Type -Path $env:CODEX_CHATGPT_WEB_SMOKE_TUNNEL_SOURCE -OutputAssembly $env:CODEX_CHATGPT_WEB_SMOKE_TUNNEL_OUTPUT -OutputType ConsoleApplication",
  ], {
    env: compileEnvironment,
    cwd,
    timeoutMs: 30_000,
  });
  assert(compile.exitCode === 0, `could not compile the isolated tunnel-client shim: ${compile.stderr || compile.stdout}`);
  assert(existsSync(executable), "isolated tunnel-client shim compiler produced no executable");
  const bytes = readFileSync(executable);
  const binarySha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(manifestPath, `${JSON.stringify({
    version: 1,
    tunnelClientVersion: "0.0.10",
    asset: "offline-upgrade-smoke-fixture.zip",
    archiveSha256: binarySha256,
    binarySha256,
  }, null, 2)}\n`);
}

function assertCredentialSafeStatus(
  status: Record<string, unknown>,
  tunnelId: string,
  runtimeKeyValue: string,
  label: string,
): void {
  const serialized = JSON.stringify(status);
  assert(!serialized.includes(tunnelId), `${label} exposed the configured tunnel ID`);
  assert(!serialized.includes(runtimeKeyValue), `${label} exposed the configured runtime key`);
}

async function waitForHealthyStatus(
  launcher: string,
  environment: Record<string, string>,
  cwd: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = "no status response";
  while (Date.now() < deadline) {
    const result = await run(launcher, ["gui", "status"], {
      env: environment,
      cwd,
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0) {
      const status = parseSingleJson(result.stdout, "healthy GUI status poll");
      const session = status.session as Record<string, unknown> | undefined;
      if (session?.running === true && session.healthy === true && session.acceptingTurns === true) {
        return status;
      }
      last = JSON.stringify(session);
    } else {
      last = result.stderr || result.stdout;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
  }
  fail(`foreground session did not become healthy: ${last}`);
}

async function waitForExit(process: SessionProcess, timeoutMs: number): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("foreground session did not exit")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

if (process.platform !== "win32") {
  process.stdout.write("WINDOWS_UPGRADE_REPAIR_SMOKE_SKIPPED\n");
  process.exit(0);
}

assert(packageVersion, "package.json has no version");
assert(existsSync(setupPath), `Windows offline setup does not exist: ${setupPath}`);

const localAppData = resolve(process.env.LOCALAPPDATA || fail("LOCALAPPDATA is unavailable"));
const smokeParent = join(localAppData, "codex-chatgpt-web-smoke");
const root = join(smokeParent, `${smokeRootPrefix}${process.pid}-${randomUUID()}`);
const installRoot = join(root, "installed application");
const binDir = join(installRoot, "bin");
const libDir = join(installRoot, "lib");
const docDir = join(installRoot, "doc");
const appHome = join(root, "private application state");
const codexHome = join(root, "isolated Codex home");
const chromeFixture = join(root, "fixtures", "verified-chrome-do-not-run.exe");
const storageStatePath = join(appHome, "browser", "storage-state.json");
const verificationMarkerPath = `${storageStatePath}.verified.json`;
const configPath = join(appHome, "config.json");
const runtimeKeyPath = join(appHome, "secrets", "tunnel-runtime.key");
const managedTunnelClientPath = join(appHome, "bin", "tunnel-client.exe");
const managedTunnelManifestPath = join(appHome, "bin", "tunnel-client-manifest.json");
const tunnelClientShimSourcePath = join(root, "fixtures", "offline-tunnel-client.cs");
const tunnelClientInvocationLogPath = join(root, "fixtures", "offline-tunnel-client-invocations.log");
const retiredTunnelClientPath = join(appHome, "bin", "retired-tunnel-client.exe");
const missingRetirementTunnelClientPath = join(appHome, "bin", "removed-by-upgrade-tunnel-client.exe");
const currentRuntime = join(libDir, packageVersion, "runtime", "node.exe");
const currentEntrypoint = join(libDir, packageVersion, "app", "cli.js");
const retiredVersion = previousVersion(packageVersion);
const missingRuntime = join(libDir, retiredVersion, "runtime", "node.exe");
const missingEntrypoint = join(libDir, retiredVersion, "app", "cli.js");
const retiredRuntimeRoot = join(libDir, retiredVersion);
const unverifiedSentinelRoot = join(libDir, "0.0.0-unattested-smoke");
const unverifiedSentinelMarker = join(unverifiedSentinelRoot, "DO-NOT-DELETE.txt");
const transactionalSentinelRoot = join(libDir, ".stage-runtime-sentinel");
const transactionalSentinelMarker = join(transactionalSentinelRoot, "DO-NOT-DELETE.txt");
const malformedSentinelRoot = join(libDir, "0.0.0-malformed-smoke");
const malformedSentinelMarker = join(malformedSentinelRoot, "DO-NOT-DELETE.txt");
const missingManifestSentinelRoot = join(libDir, "0.0.0-missing-manifest-smoke");
const missingManifestSentinelMarker = join(missingManifestSentinelRoot, "DO-NOT-DELETE.txt");
const reparseSentinelRoot = join(libDir, "0.0.0-reparse-smoke");
const reparseSentinelMarker = join(reparseSentinelRoot, "DO-NOT-DELETE.txt");
const reparseTarget = join(root, "reparse target outside candidate");
const launcher = join(binDir, "codex-chatgpt-web.exe");
const launcherSidecar = join(binDir, "codex-chatgpt-web.launcher");
const installSidecar = join(binDir, "codex-chatgpt-web.install");
let session: SessionProcess | undefined;
let sessionStdout: Promise<string> | undefined;
let sessionStderr: Promise<string> | undefined;

mkdirSync(smokeParent, { recursive: true });
mkdirSync(root, { recursive: false });
try {
  assertWithin(localAppData, root, "smoke root");
  assertWithin(root, installRoot, "install root");
  assertWithin(root, appHome, "application home");
  assertWithin(root, codexHome, "Codex home");
  const fromTemp = relative(resolve(tmpdir()), root);
  assert(fromTemp === ".." || fromTemp.startsWith(`..${sep}`), "upgrade smoke root must not be under the temporary directory");

  const userStateBefore = realUserState();
  const environment = isolatedEnvironment(appHome, codexHome);
  environment.CODEX_CHATGPT_WEB_SMOKE_TUNNEL_LOG = tunnelClientInvocationLogPath;
  const runtimeArchitecture = process.arch === "arm64" ? "arm64" : "x64";
  seedRuntimeBundle(retiredRuntimeRoot, retiredVersion, runtimeArchitecture);

  const sidecarValue = (value: string): string => Buffer.from(value, "utf8").toString("base64");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(launcherSidecar, [
    "v1",
    sidecarValue(missingRuntime),
    sidecarValue(missingEntrypoint),
    sidecarValue(appHome),
  ].join("\r\n"));
  writeFileSync(installSidecar, [
    "v1",
    sidecarValue(binDir),
    sidecarValue(libDir),
    sidecarValue(docDir),
    sidecarValue(appHome),
    sidecarValue(join(binDir, "codex-chatgpt-web-gui.exe")),
    sidecarValue(join(root, "start menu", "Codex ChatGPT Web.lnk")),
    sidecarValue(join(root, "desktop", "Codex ChatGPT Web.lnk")),
    sidecarValue(retiredVersion),
    sidecarValue(installRoot),
    sidecarValue("False"),
  ].join("\r\n"));

  seedRuntimeBundle(unverifiedSentinelRoot, basename(unverifiedSentinelRoot), runtimeArchitecture, basename(unverifiedSentinelMarker));
  seedRuntimeBundle(transactionalSentinelRoot, basename(transactionalSentinelRoot), runtimeArchitecture, basename(transactionalSentinelMarker));

  mkdirSync(malformedSentinelRoot, { recursive: true });
  writeFileSync(malformedSentinelMarker, "malformed manifest runtime must be preserved\n");
  writeFileSync(join(malformedSentinelRoot, "manifest.json"), "{not valid JSON\n");

  mkdirSync(missingManifestSentinelRoot, { recursive: true });
  writeFileSync(missingManifestSentinelMarker, "missing manifest runtime must be preserved\n");

  seedRuntimeBundle(reparseSentinelRoot, basename(reparseSentinelRoot), runtimeArchitecture, basename(reparseSentinelMarker));
  mkdirSync(reparseTarget, { recursive: true });
  writeFileSync(join(reparseTarget, "outside.txt"), "reparse target must not be traversed or removed\n");
  symlinkSync(reparseTarget, join(reparseSentinelRoot, "linked-directory"), "junction");

  const install = await run(setupPath, [
    "--quiet",
    "--no-launch",
    "--no-path",
    "--no-shortcuts",
    "--no-register",
    "--bin-dir", binDir,
    "--lib-dir", libDir,
    "--doc-dir", docDir,
    "--app-home", appHome,
  ], { env: environment, timeoutMs: 120_000 });
  assert(install.exitCode === 0, `isolated offline install failed (${install.exitCode}): ${install.stderr || install.stdout}`);
  assert(existsSync(launcher), `installed launcher is missing: ${launcher}`);
  assert(existsSync(currentRuntime), `installed runtime is missing: ${currentRuntime}`);
  assert(existsSync(currentEntrypoint), `installed entrypoint is missing: ${currentEntrypoint}`);
  assert(!existsSync(retiredRuntimeRoot), "installer did not remove the verified previous-version runtime");
  assert(existsSync(unverifiedSentinelMarker), "installer removed an unverified custom runtime sentinel");
  assert(existsSync(transactionalSentinelMarker), "installer removed a transactional dot-directory sentinel");
  assert(existsSync(malformedSentinelMarker), "installer removed a malformed-manifest runtime sentinel");
  assert(existsSync(missingManifestSentinelMarker), "installer removed a missing-manifest runtime sentinel");
  assert(existsSync(reparseSentinelMarker), "installer removed a runtime containing a reparse point");
  assert(existsSync(join(reparseTarget, "outside.txt")), "installer traversed or removed the reparse target");

  mkdirSync(join(root, "fixtures"), { recursive: true });
  mkdirSync(join(appHome, "browser"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(chromeFixture, "This fixture must never be executed.\n");
  const storageState = `${JSON.stringify({ cookies: [], origins: [] })}\n`;
  const verificationMarker = `${JSON.stringify({
    version: 1,
    authenticated: true,
    verifiedAt: "2026-08-08T00:00:00.000Z",
    proAvailable: false,
  })}\n`;
  writeFileSync(storageStatePath, storageState);
  writeFileSync(verificationMarkerPath, verificationMarker);
  const tunnelId = `tunnel_${randomBytes(16).toString("hex")}`;
  const runtimeKeyValue = randomBytes(32).toString("base64url");
  mkdirSync(dirname(runtimeKeyPath), { recursive: true });
  writeFileSync(runtimeKeyPath, runtimeKeyValue);
  await seedAttestedTunnelClient(
    managedTunnelClientPath,
    managedTunnelManifestPath,
    tunnelClientShimSourcePath,
    environment,
    root,
  );
  const runtimeKeyBefore = fingerprint(runtimeKeyPath);

  const port = await availableLoopbackPort();
  const controlToken = randomBytes(32).toString("base64url");
  const staleConfig = {
    version: 2,
    releaseVersion: retiredVersion,
    mode: "full",
    host: "127.0.0.1",
    port,
    contextWindow: 256_000,
    appName: "Codex Native Upgrade Smoke",
    chromeExecutablePath: chromeFixture,
    storageStatePath,
    brokerSocketPath: join(appHome, "runtime", "retired-turn-broker.sock"),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken,
    runtimeCommand: [missingRuntime, missingEntrypoint],
    acknowledgedUnofficialAt: "2026-08-08T00:00:00.000Z",
    tunnel: {
      binaryPath: retiredTunnelClientPath,
      tunnelId,
      runtimeKeyFile: runtimeKeyPath,
      profileDir: join(appHome, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  };
  writeFileSync(configPath, `${JSON.stringify(staleConfig, null, 2)}\n`);

  const preRepairResult = await run(launcher, ["gui", "status"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 15_000,
  });
  assert(preRepairResult.exitCode === 0, `pre-repair GUI status failed: ${preRepairResult.stderr}`);
  const preRepair = parseSingleJson(preRepairResult.stdout, "pre-repair GUI status");
  assert(preRepair.version === packageVersion, "pre-repair status did not come from the current release");
  assert(preRepair.configured === false, "missing retired runtime was not reported as an invalid active configuration");
  assert(preRepair.configurationRecoverable === true, "missing retired runtime was not offered as a safe setup repair");
  assert(preRepair.configurationCurrent === false, "retired configuration was incorrectly reported as current");
  assert(preRepair.mode === "full", "recoverable Full mode was not reported to the GUI");
  const preRepairSetup = preRepair.setup as Record<string, unknown> | undefined;
  const preRepairCredentials = preRepairSetup?.fullCredentials as Record<string, unknown> | undefined;
  assert(
    preRepairCredentials?.tunnelIdConfigured === true
      && preRepairCredentials.runtimeKeyConfigured === true,
    "recoverable Full credentials were not represented by safe availability booleans",
  );
  assertCredentialSafeStatus(preRepair, tunnelId, runtimeKeyValue, "pre-repair GUI status");
  assert(
    typeof preRepair.configError === "string"
      && preRepair.configError.includes("Runtime executable does not exist")
      && normalized(preRepair.configError).includes(normalized(missingRuntime)),
    `pre-repair status did not provide an actionable stale-runtime diagnostic: ${String(preRepair.configError)}`,
  );

  const setupRequestBody = {
    mode: "full",
    acknowledgedUnofficial: true,
    forceLogin: false,
    autoApproveToolCalls: false,
    replaceCodexRoute: false,
    port,
    chromeExecutablePath: chromeFixture,
    appName: "Codex Native Upgrade Smoke",
  };
  assert(
    !("tunnelId" in setupRequestBody) && !("runtimeKeyValue" in setupRequestBody),
    "Full repair request must omit reusable credentials",
  );
  const setupRequest = `${JSON.stringify(setupRequestBody)}\n`;
  const repair = await run(launcher, ["gui", "setup"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 30_000,
    stdin: setupRequest,
  });
  assert(repair.exitCode === 0, `stale configuration repair failed (${repair.exitCode}): ${repair.stderr || repair.stdout}`);
  const repairResult = parseSingleJson(repair.stdout, "GUI setup repair");
  assert(repairResult.status === "complete", "GUI setup did not report repair completion");
  assert(repairResult.mode === "full", "GUI setup silently downgraded the Full repair request");
  assert(repairResult.loginCreated === false, "GUI setup unexpectedly launched or replaced the verified login fixture");
  assert(readFileSync(storageStatePath, "utf8") === storageState, "GUI setup changed the verified storage-state fixture");
  assert(readFileSync(verificationMarkerPath, "utf8") === verificationMarker, "GUI setup changed the verification marker");

  const repairedConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const repairedRuntime = repairedConfig.runtimeCommand as unknown[] | undefined;
  assert(repairedConfig.releaseVersion === packageVersion, "repair did not update the saved release version");
  assert(Array.isArray(repairedRuntime) && repairedRuntime.length === 2, "repair did not save a direct runtime command");
  assert(normalized(String(repairedRuntime[0])) === normalized(currentRuntime), "repair did not select the installed current runtime");
  assert(normalized(String(repairedRuntime[1])) === normalized(currentEntrypoint), "repair did not select the installed current entrypoint");
  assert(!JSON.stringify(repairedConfig).includes(missingRuntime), "repair retained the missing previous-version runtime path");
  assert(repairedConfig.mode === "full", "repair silently downgraded the saved Full mode");
  const repairedTunnel = repairedConfig.tunnel as Record<string, unknown> | undefined;
  assert(repairedTunnel?.tunnelId === tunnelId, "repair did not reuse the saved tunnel ID when the GUI omitted it");
  assert(normalized(String(repairedTunnel.runtimeKeyFile)) === normalized(runtimeKeyPath), "repair did not reuse the saved runtime-key file when the GUI omitted it");
  assert(fingerprint(runtimeKeyPath) === runtimeKeyBefore, "repair changed the saved runtime key");

  const postRepairResult = await run(launcher, ["gui", "status"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 15_000,
  });
  assert(postRepairResult.exitCode === 0, `post-repair GUI status failed: ${postRepairResult.stderr}`);
  const postRepair = parseSingleJson(postRepairResult.stdout, "post-repair GUI status");
  const postChrome = postRepair.chrome as Record<string, unknown> | undefined;
  assert(postRepair.version === packageVersion, "post-repair status version is not current");
  assert(postRepair.configured === true && postRepair.configurationCurrent === true, "repaired configuration is not current");
  assert(postRepair.configError === undefined, "repaired configuration still reports a parser error");
  assert(postRepair.mode === "full", "post-repair GUI status lost Full mode");
  const postRepairSetup = postRepair.setup as Record<string, unknown> | undefined;
  const postRepairCredentials = postRepairSetup?.fullCredentials as Record<string, unknown> | undefined;
  assert(
    postRepairCredentials?.tunnelIdConfigured === true
      && postRepairCredentials.runtimeKeyConfigured === true,
    "post-repair status lost the reusable Full credential availability flags",
  );
  assertCredentialSafeStatus(postRepair, tunnelId, runtimeKeyValue, "post-repair GUI status");
  assert(postRepair.loginReady === true, "verified isolated login fixture is not ready after repair");
  assert(postChrome?.found === true, "isolated Chrome fixture is not visible after repair");

  // The remainder of this pre-existing smoke verifies foreground proxy ownership
  // and graceful shutdown. A real Full session would require external tunnel
  // connectivity, so make the test-only transition explicit after the Full repair
  // regression has passed. The isolated shim accepts only the retirement stop
  // command, records every invocation under this smoke root, and has no network
  // or child-process capability.
  assert(!existsSync(tunnelClientInvocationLogPath), "tunnel-client shim ran before explicit Full-mode retirement");
  const explicitBrowserOnlyRequest = `${JSON.stringify({
    mode: "browser-only",
    acknowledgedUnofficial: true,
    forceLogin: false,
    autoApproveToolCalls: false,
    replaceCodexRoute: false,
    port,
    chromeExecutablePath: chromeFixture,
    appName: "Codex Native Upgrade Smoke",
  })}\n`;
  const explicitBrowserOnlySetup = await run(launcher, ["gui", "setup"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 30_000,
    stdin: explicitBrowserOnlyRequest,
  });
  assert(
    explicitBrowserOnlySetup.exitCode === 0,
    `explicit test-only Browser-only transition failed (${explicitBrowserOnlySetup.exitCode}): ${explicitBrowserOnlySetup.stderr || explicitBrowserOnlySetup.stdout}`,
  );
  const explicitBrowserOnlyResult = parseSingleJson(explicitBrowserOnlySetup.stdout, "explicit Browser-only setup");
  assert(
    explicitBrowserOnlyResult.status === "complete" && explicitBrowserOnlyResult.mode === "browser-only",
    "explicit test-only Browser-only transition did not complete",
  );
  assert(existsSync(tunnelClientInvocationLogPath), "explicit Full-mode retirement did not invoke the isolated tunnel-client shim");
  const tunnelClientInvocations = readFileSync(tunnelClientInvocationLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.split("\u001f"));
  const expectedTunnelRetirement = ["runtimes", "stop", "codex-chatgpt-web", "--json"];
  assert(tunnelClientInvocations.length === 1, "Full-mode retirement did not perform exactly one cleanup stop");
  assert(
    tunnelClientInvocations.every(invocation => JSON.stringify(invocation) === JSON.stringify(expectedTunnelRetirement)),
    "Full-mode retirement invoked an unexpected tunnel-client command",
  );

  // Exercise the complementary upgrade case independently: a saved Full-mode
  // configuration can outlive the old release that owned its tunnel executable.
  // Retiring that stale configuration must succeed without attempting to spawn
  // either the missing path or the unrelated managed shim that remains present.
  assert(!existsSync(missingRetirementTunnelClientPath), "missing-binary retirement fixture is unexpectedly present");
  const missingBinaryFullConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  missingBinaryFullConfig.mode = "full";
  missingBinaryFullConfig.tunnel = {
    binaryPath: missingRetirementTunnelClientPath,
    tunnelId,
    runtimeKeyFile: runtimeKeyPath,
    profileDir: join(appHome, "tunnel", "profiles"),
    profileName: "codex-chatgpt-web",
    alias: "codex-chatgpt-web",
  };
  writeFileSync(configPath, `${JSON.stringify(missingBinaryFullConfig, null, 2)}\n`);

  const missingBinaryPreStatusResult = await run(launcher, ["gui", "status"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 15_000,
  });
  assert(missingBinaryPreStatusResult.exitCode === 0, `missing-binary pre-retirement status failed: ${missingBinaryPreStatusResult.stderr}`);
  const missingBinaryPreStatus = parseSingleJson(missingBinaryPreStatusResult.stdout, "missing-binary pre-retirement GUI status");
  assert(
    missingBinaryPreStatus.configured === true
      && missingBinaryPreStatus.configurationCurrent === true
      && missingBinaryPreStatus.mode === "full",
    "missing tunnel-client binary made the otherwise valid Full-mode configuration unrecoverable",
  );
  assertCredentialSafeStatus(missingBinaryPreStatus, tunnelId, runtimeKeyValue, "missing-binary pre-retirement GUI status");

  const tunnelLogBeforeMissingBinaryRetirement = fingerprint(tunnelClientInvocationLogPath);
  const missingBinaryRetirementSetup = await run(launcher, ["gui", "setup"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 30_000,
    stdin: explicitBrowserOnlyRequest,
  });
  assert(
    missingBinaryRetirementSetup.exitCode === 0,
    `missing-binary Full-mode retirement failed (${missingBinaryRetirementSetup.exitCode}): ${missingBinaryRetirementSetup.stderr || missingBinaryRetirementSetup.stdout}`,
  );
  const missingBinaryRetirementResult = parseSingleJson(
    missingBinaryRetirementSetup.stdout,
    "missing-binary Full-mode retirement setup",
  );
  assert(
    missingBinaryRetirementResult.status === "complete" && missingBinaryRetirementResult.mode === "browser-only",
    "missing-binary Full-mode retirement did not complete",
  );
  const missingBinaryRetiredConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  assert(missingBinaryRetiredConfig.mode === "browser-only", "missing-binary retirement did not save Browser-only mode");
  assert(!Object.prototype.hasOwnProperty.call(missingBinaryRetiredConfig, "tunnel"), "missing-binary retirement retained stale tunnel configuration");
  assert(
    fingerprint(tunnelClientInvocationLogPath) === tunnelLogBeforeMissingBinaryRetirement,
    "missing-binary retirement unexpectedly invoked a tunnel-client executable",
  );

  const foreground = Bun.spawn([launcher, "session"], {
    cwd: binDir,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  session = foreground;
  sessionStdout = new Response(foreground.stdout).text();
  sessionStderr = new Response(foreground.stderr).text();
  const healthy = await waitForHealthyStatus(launcher, environment, binDir);
  const healthySession = healthy.session as Record<string, unknown>;
  assert(healthy.version === packageVersion, "healthy status came from another release");
  assert(healthy.configured === true && healthy.configurationCurrent === true, "healthy session lost current configuration state");
  assert(typeof healthySession.pid === "number", "healthy status omitted the foreground runtime PID");

  const stop = await run(launcher, ["gui", "stop-session"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 20_000,
  });
  assert(stop.exitCode === 0, `graceful session stop failed: ${stop.stderr || stop.stdout}`);
  const stopResult = parseSingleJson(stop.stdout, "GUI session stop");
  assert(stopResult.stopped === true && stopResult.alreadyStopped === false, "GUI did not stop the foreground session it discovered");
  const sessionExit = await waitForExit(session, 15_000);
  const [foregroundStdout, foregroundStderr] = await Promise.all([sessionStdout, sessionStderr]);
  assert(sessionExit === 0, `foreground launcher exited ${sessionExit}: ${foregroundStderr || foregroundStdout}`);
  assert(foregroundStdout.includes(`codex-chatgpt-web ${packageVersion} listening`), "foreground session did not announce the current release");
  session = undefined;

  const stoppedStatus = parseSingleJson((await run(launcher, ["gui", "status"], {
    env: environment,
    cwd: binDir,
    timeoutMs: 15_000,
  })).stdout, "stopped GUI status");
  const stoppedSession = stoppedStatus.session as Record<string, unknown> | undefined;
  assert(stoppedSession?.running === false, "foreground session remained running after graceful shutdown");
  assert(JSON.stringify(realUserState()) === JSON.stringify(userStateBefore), "isolated upgrade smoke changed real user Codex or harness state");

  const evidenceHash = createHash("sha256")
    .update(readFileSync(configPath))
    .update(readFileSync(join(codexHome, "config.toml")))
    .digest("hex");
  process.stdout.write(`WINDOWS_STALE_CONFIG_UPGRADE_REPAIR_SMOKE_OK ${packageVersion} ${evidenceHash}\n`);
} finally {
  if (session) {
    try {
      const environment = isolatedEnvironment(appHome, codexHome);
      await run(launcher, ["gui", "stop-session"], { env: environment, cwd: binDir, timeoutMs: 10_000 });
    } catch { }
    try { session.kill(); } catch { }
    try { await waitForExit(session, 5_000); } catch { }
  }
  assertWithin(localAppData, root, "cleanup root");
  assert(basename(root).startsWith(smokeRootPrefix), `refusing to clean an unexpected path: ${root}`);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try { rmdirSync(smokeParent); } catch { /* Preserve another concurrent smoke root. */ }
}
