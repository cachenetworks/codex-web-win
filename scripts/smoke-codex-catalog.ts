import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

function discoverCodex(): string {
  if (process.argv[2]) return resolve(process.argv[2]);
  if (process.platform === "darwin") return "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    const localCandidates = localAppData ? [
      join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
      join(localAppData, "Programs", "ChatGPT", "resources", "codex.exe"),
    ] : [];
    for (const candidate of localCandidates) {
      if (existsSync(candidate)) return candidate;
    }
    const appx = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
    if (appx.status === 0 && appx.stdout.trim()) {
      const candidate = join(appx.stdout.trim(), "app", "resources", "codex.exe");
      if (existsSync(candidate)) return candidate;
    }
    const pathLookup = spawnSync("where.exe", ["codex.exe"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    if (pathLookup.status === 0) {
      const candidate = pathLookup.stdout.split(/\r?\n/).find(line => line.trim())?.trim();
      if (candidate && existsSync(candidate)) return candidate;
    }
  }
  throw new Error("Could not find the Codex executable; pass its absolute path to smoke:codex");
}

const root = join(tmpdir(), `codex-chatgpt-web-codex-smoke-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
const discoveredCodex = discoverCodex();
const codex = process.platform === "win32" && discoveredCodex.toLowerCase().includes("\\windowsapps\\")
  ? join(root, "codex.exe")
  : discoveredCodex;
if (codex !== discoveredCodex) copyFileSync(discoveredCodex, codex);

function runCodex(args: string[], env = process.env): { stdout: string; stderr: string } {
  const result = spawnSync(codex, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
    // WindowsApps Codex is copied out of the package because its installed ACL
    // blocks direct execution from this smoke. The standalone binary is large
    // enough that first launch can spend tens of seconds in Windows scanning,
    // especially immediately after an app update.
    timeout: 60_000,
  });
  if (result.status !== 0) {
    throw new Error(`Codex ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.signal || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

try {
  const bundled = runCodex(["debug", "models", "--bundled"]);
  const sourceCatalog = JSON.parse(bundled.stdout) as { models?: unknown[] };
  if (!sourceCatalog.models?.some(model => model && typeof model === "object" && (model as { slug?: string }).slug === "gpt-5.6-sol")) {
    throw new Error("Bundled Codex catalog has no gpt-5.6-sol template");
  }

  process.env.CODEX_HOME = join(root, "codex");
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  const catalogPath = join(root, "augmented-models.json");
  writeFileSync(catalogPath, `${JSON.stringify(augmentNativeModelCatalog(sourceCatalog, config))}\n`);
  writeFileSync(join(process.env.CODEX_HOME, "config.toml"), `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
  const result = runCodex(["debug", "models"], { ...process.env, CODEX_HOME: process.env.CODEX_HOME });
  const catalog = JSON.parse(result.stdout) as { models?: Array<{ slug?: string; supported_reasoning_levels?: unknown[] }> };
  const web = catalog.models?.filter(model => model.slug?.startsWith("chatgpt-web/")) ?? [];
  const expected = CHATGPT_WEB_MODEL_ROUTES.map(route => ({ slug: route.slug, effort: route.codexEffort }));
  const actual = web.map(model => ({
    slug: model.slug,
    effort: Array.isArray(model.supported_reasoning_levels)
      ? (model.supported_reasoning_levels as Array<{ effort?: string }>).map(level => level.effort).join(",")
      : "",
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Codex did not preserve the fixed ChatGPT Web model contract: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("NATIVE_CODEX_CATALOG_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
