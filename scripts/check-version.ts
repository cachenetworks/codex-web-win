import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageVersion = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version?: string }).version;
if (!packageVersion) throw new Error("package.json has no version");
const expected = [
  ["src/version.ts", `export const VERSION = ${JSON.stringify(packageVersion)};`],
  ["scripts/install.sh", `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${packageVersion}}\"`],
  ["scripts/install.ps1", `$DefaultVersion = ${JSON.stringify(packageVersion)}`],
  ["scripts/windows-gui.cs", `Version = ${JSON.stringify(packageVersion)}`],
  ["scripts/smoke-release.ts", `manifest.appVersion !== ${JSON.stringify(packageVersion)}`],
  ["scripts/smoke-release.ts", `version.stdout.toString().trim() !== ${JSON.stringify(packageVersion)}`],
  ["scripts/smoke-release.ts", `releaseVersion: ${JSON.stringify(packageVersion)}`],
  ["scripts/windows-offline-installer.cs", `AssemblyVersion(${JSON.stringify(`${packageVersion}.0`)})`],
  ["scripts/windows-offline-installer.cs", `AssemblyFileVersion(${JSON.stringify(`${packageVersion}.0`)})`],
  ["scripts/windows-offline-installer.manifest", `version=${JSON.stringify(`${packageVersion}.0`)}`],
  [".github/workflows/ci.yml", "$expectedVersion = [string]$manifest.appVersion"],
  [".github/workflows/release.yml", "$expectedVersion = [string]$manifest.appVersion"],
] as const;
const repositoryOnlyPaths = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
]);
for (const [path, needle] of expected) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) {
    if (repositoryOnlyPaths.has(path)) continue;
    throw new Error(`Required versioned file is missing: ${path}`);
  }
  if (!readFileSync(absolutePath, "utf8").includes(needle)) throw new Error(`${path} is not synchronized to ${packageVersion}`);
}
const hardCodedWorkflowVersion = /(?:\$version(?:Text)?(?:\.Trim\(\))?|\$about\.version)\s+-ne\s+["']\d+\.\d+\.\d+(?:-[^"']+)?["']/;
for (const path of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
  const absolutePath = resolve(root, path);
  if (!existsSync(absolutePath)) continue;
  if (hardCodedWorkflowVersion.test(readFileSync(absolutePath, "utf8"))) {
    throw new Error(`${path} hard-codes a Windows artifact version instead of reading dist/runtime/manifest.json`);
  }
}
process.stdout.write(`VERSION_SYNC_OK ${packageVersion}\n`);
