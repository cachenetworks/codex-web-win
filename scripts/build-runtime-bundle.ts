import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { VERSION } from "../src/version";

const NODE_VERSION = "24.14.0";
const NODE_WINDOWS_ARCHIVE_SHA256: Record<string, string> = {
  x64: "313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66",
  arm64: "88d36e8109736a2fa9bdc596f2cf507a3c52c69cdf96e54f8acd473ec14be853",
};
const root = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? join(root, "dist", "runtime"));
const appDir = join(output, "app");
const runtimeDir = join(output, "runtime");
const binDir = join(output, "bin");
const windows = process.platform === "win32";
const runtimeExecutable = windows ? "node.exe" : "bun";
const launcherName = windows ? "codex-chatgpt-web.exe" : "codex-chatgpt-web";
const windowsGuiName = "codex-chatgpt-web-gui.exe";
const windowsUninstallerName = "codex-chatgpt-web-uninstall.ps1";

async function installPinnedWindowsNode(): Promise<void> {
  const expectedHash = NODE_WINDOWS_ARCHIVE_SHA256[process.arch];
  if (!expectedHash) throw new Error(`No pinned Node ${NODE_VERSION} archive for Windows ${process.arch}`);
  const archiveName = `node-v${NODE_VERSION}-win-${process.arch}.zip`;
  const cacheRoot = join(root, "node_modules", ".cache", "codex-chatgpt-web", `node-v${NODE_VERSION}-win-${process.arch}`);
  const archivePath = join(cacheRoot, archiveName);
  const expandedRoot = join(cacheRoot, "expanded");
  const extractedDistribution = join(expandedRoot, `node-v${NODE_VERSION}-win-${process.arch}`);
  const cachedNode = join(extractedDistribution, "node.exe");
  const cachedLicense = join(extractedDistribution, "LICENSE");
  mkdirSync(cacheRoot, { recursive: true });

  const archiveHash = () => existsSync(archivePath)
    ? createHash("sha256").update(readFileSync(archivePath)).digest("hex")
    : "";
  if (archiveHash() !== expectedHash) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`);
    if (!response.ok) throw new Error(`Node runtime download failed: HTTP ${response.status}`);
    const nextArchive = `${archivePath}.next-${process.pid}`;
    writeFileSync(nextArchive, new Uint8Array(await response.arrayBuffer()));
    const actualHash = createHash("sha256").update(readFileSync(nextArchive)).digest("hex");
    if (actualHash !== expectedHash) {
      rmSync(nextArchive, { force: true });
      throw new Error(`Node runtime SHA-256 mismatch for ${archiveName}: ${actualHash}`);
    }
    rmSync(archivePath, { force: true });
    renameSync(nextArchive, archivePath);
    rmSync(expandedRoot, { recursive: true, force: true });
  }

  if (!existsSync(cachedNode) || !existsSync(cachedLicense)) {
    rmSync(expandedRoot, { recursive: true, force: true });
    mkdirSync(expandedRoot, { recursive: true });
    const extract = Bun.spawnSync(["tar.exe", "-xf", archivePath, "-C", expandedRoot], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (extract.exitCode !== 0) {
      throw new Error(`Node runtime archive failed to extract: ${extract.stderr.toString() || extract.stdout.toString()}`);
    }
  }
  if (!existsSync(cachedNode) || !existsSync(cachedLicense)) {
    throw new Error(`Node runtime archive is incomplete: ${archiveName}`);
  }
  const version = Bun.spawnSync([cachedNode, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== `v${NODE_VERSION}`) {
    throw new Error(`Pinned Node runtime did not report v${NODE_VERSION}: ${version.stderr.toString()}`);
  }
  copyFileSync(cachedNode, join(runtimeDir, runtimeExecutable));
  copyFileSync(cachedLicense, join(runtimeDir, `Node-${NODE_VERSION}-LICENSE.txt`));
}

rmSync(output, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const build = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  target: windows ? "node" : "bun",
  minify: true,
  external: ["playwright-core"],
  // The Windows runtime pays a large startup and installation cost when every
  // JavaScript dependency is copied as thousands of external files. Bundle
  // application dependencies into the minified entrypoint and keep only
  // Playwright external because it resolves its own package-relative assets.
  packages: windows ? "bundle" : "external",
  outdir: appDir,
  naming: "cli.js",
});
if (!build.success) {
  throw new Error(`Runtime bundle failed: ${build.logs.map(log => log.message).join("; ")}`);
}

const sourcePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
};
if (windows) {
  const playwrightVersion = sourcePackage.dependencies?.["playwright-core"];
  if (!sourcePackage.name || !sourcePackage.version || !playwrightVersion) {
    throw new Error("package.json is missing Windows runtime metadata");
  }
  writeFileSync(join(appDir, "package.json"), `${JSON.stringify({
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: "module",
    dependencies: { "playwright-core": playwrightVersion },
  }, null, 2)}\n`);
  const playwrightSource = realpathSync(join(root, "node_modules", "playwright-core"));
  const playwrightTarget = join(appDir, "node_modules", "playwright-core");
  mkdirSync(dirname(playwrightTarget), { recursive: true });
  cpSync(playwrightSource, playwrightTarget, { recursive: true });
} else {
  copyFileSync(join(root, "package.json"), join(appDir, "package.json"));
  copyFileSync(join(root, "bun.lock"), join(appDir, "bun.lock"));
  const install = Bun.spawnSync([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`Runtime dependencies failed to install: ${install.stderr.toString() || install.stdout.toString()}`);
  }
}
if (windows) {
  await installPinnedWindowsNode();
} else {
  cpSync(realpathSync(process.execPath), join(runtimeDir, runtimeExecutable));
  chmodSync(join(runtimeDir, runtimeExecutable), 0o755);
}
if (windows) {
  const windowsDirectory = process.env.WINDIR || "C:\\Windows";
  const compiler = [
    join(windowsDirectory, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windowsDirectory, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find(candidate => existsSync(candidate));
  if (!compiler) throw new Error("Windows runtime build requires the built-in .NET Framework C# compiler");
  const supervisorPath = join(binDir, launcherName);
  const compile = Bun.spawnSync([
    compiler,
    "/nologo",
    "/optimize+",
    "/target:exe",
    "/platform:anycpu",
    `/out:${supervisorPath}`,
    join(root, "scripts", "windows-job-launcher.cs"),
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (compile.exitCode !== 0 || !existsSync(supervisorPath)) {
    throw new Error(`Windows Job Object supervisor failed to compile: ${compile.stderr.toString() || compile.stdout.toString()}`);
  }
  const guiSource = join(root, "scripts", "windows-gui.cs");
  const uninstallerSource = join(root, "scripts", "windows-uninstall.ps1");
  if (!existsSync(guiSource) || !existsSync(uninstallerSource)) {
    throw new Error("Windows GUI or uninstaller source is missing");
  }
  const guiPath = join(binDir, windowsGuiName);
  const compileGui = Bun.spawnSync([
    compiler,
    "/nologo",
    "/optimize+",
    "/target:winexe",
    "/platform:anycpu",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Web.Extensions.dll",
    `/out:${guiPath}`,
    guiSource,
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (compileGui.exitCode !== 0 || !existsSync(guiPath)) {
    throw new Error(`Windows GUI failed to compile: ${compileGui.stderr.toString() || compileGui.stdout.toString()}`);
  }
  copyFileSync(
    uninstallerSource,
    join(binDir, windowsUninstallerName),
  );
}

const launcher = `#!/bin/sh
set -eu
invoked="$0"
case "$invoked" in
  /*) ;;
  *) invoked="$(command -v -- "$invoked")" ;;
esac
script="$invoked"
while [ -L "$script" ]; do
  target="$(readlink "$script")"
  case "$target" in
    /*) script="$target" ;;
    *) script="$(dirname "$script")/$target" ;;
  esac
done
bin_dir="$(CDPATH= cd -- "$(dirname "$script")" && pwd -P)"
root="$(CDPATH= cd -- "$bin_dir/.." && pwd -P)"
export CODEX_CHATGPT_WEB_LAUNCHER="$invoked"
exec "$root/runtime/bun" "$root/app/cli.js" "$@"
`;
if (!windows) {
  writeFileSync(join(binDir, launcherName), launcher, { mode: 0o755 });
  chmodSync(join(binDir, launcherName), 0o755);
}

if (sourcePackage.version !== VERSION) throw new Error("package.json and runtime version are out of sync");
const playwrightPackage = join(appDir, "node_modules", "playwright-core", "package.json");
writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  appVersion: VERSION,
  ...(windows ? { nodeVersion: NODE_VERSION } : { bunVersion: Bun.version }),
  platform: process.platform,
  arch: process.arch,
  launcher: `bin/${launcherName}`,
  ...(windows ? {
    supervisor: `bin/${launcherName}`,
    gui: `bin/${windowsGuiName}`,
    uninstaller: `bin/${windowsUninstallerName}`,
  } : {}),
  entrypoint: "app/cli.js",
  playwright: JSON.parse(readFileSync(playwrightPackage, "utf8")).version,
}, null, 2)}\n`);

process.stdout.write(`${output}\n`);
