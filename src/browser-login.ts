import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import { childProcessEnvironment } from "./process";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptProCapability,
} from "./chatgpt-session";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  proAvailable?: boolean;
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

export function normalChromeLoginArguments(profileDir: string): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ];
}

function writeVerificationMarker(storageStatePath: string, proAvailable: boolean): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    proAvailable,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<{ proAvailable: boolean; url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    env: childProcessEnvironment(),
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { proAvailable: await detectChatGptProCapability(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<{ proAvailable: boolean }> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
  return { proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(config: AppConfig): { proAvailable?: boolean } {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {};
  } catch {
    return {};
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, delayMs));
}

function powershellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function windowsDedicatedChromePids(profileDir: string): Promise<number[]> {
  if (process.platform !== "win32") return [];
  const needle = `--user-data-dir=${profileDir}`;
  const script = [
    `$needle = ${powershellSingleQuoted(needle)}`,
    "$pids = @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction SilentlyContinue",
    "  | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) }",
    "  | ForEach-Object { [int]$_.ProcessId })",
    "if ($pids.Count -gt 0) { $pids -join ',' }",
  ].join("; ");

  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        if (error) {
          rejectOutput(error);
          return;
        }
        resolveOutput(stdout.trim());
      },
    );
  }).catch(() => "");

  if (!output) return [];
  return output
    .split(",")
    .map(value => Number.parseInt(value.trim(), 10))
    .filter(value => Number.isInteger(value) && value > 0);
}

async function terminateDedicatedChromeProfile(profileDir: string): Promise<void> {
  if (process.platform !== "win32") return;
  const pids = await windowsDedicatedChromePids(profileDir);
  for (const pid of pids) {
    await new Promise<void>(resolveDone => {
      execFile(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 },
        () => resolveDone(),
      );
    });
  }
}

async function waitForDedicatedChromeProfileRelease(profileDir: string): Promise<void> {
  // First allow normal Chrome a few seconds to finish shutting down naturally.
  const naturalDeadline = Date.now() + 6_000;
  while (Date.now() < naturalDeadline) {
    if ((await windowsDedicatedChromePids(profileDir)).length === 0) {
      await wait(350);
      return;
    }
    await wait(250);
  }

  // The profile is one-shot and the user has already closed its visible window.
  // Chrome can nevertheless leave a background browser process alive on Windows.
  // Kill ONLY the process tree whose command line names this exact unique profile.
  const lingering = await windowsDedicatedChromePids(profileDir);
  if (lingering.length > 0) {
    process.stdout.write(
      `Closing lingering dedicated login Chrome process(es): ${lingering.join(", ")}\n`,
    );
    await terminateDedicatedChromeProfile(profileDir);
  }

  const forcedDeadline = Date.now() + 5_000;
  while (Date.now() < forcedDeadline) {
    if ((await windowsDedicatedChromePids(profileDir)).length === 0) {
      await wait(500);
      return;
    }
    await wait(250);
  }
  throw new Error("The dedicated Chrome login profile is still in use after its window was closed");
}

async function removeLoginProfileBestEffort(profileDir: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY";
      if (!retryable) {
        process.stderr.write(
          `Warning: could not remove temporary login profile: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return;
      }
      if (attempt < 20) await wait(250);
    }
  }

  // Cleanup must never invalidate an otherwise successful login. A uniquely
  // named abandoned profile is harmless and can be removed on the next run.
  process.stderr.write(
    `Warning: temporary login profile is still locked and was left for later cleanup: ${profileDir}\n`,
  );
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number; announce?: boolean } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }

  const profileDir = join(
    dirname(config.storageStatePath),
    `login-profile-${process.pid}-${Date.now().toString(36)}`,
  );
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    if (options.announce !== false) {
      process.stdout.write(
        "A fresh normal Chrome profile is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
      );
    }

    const loginBrowser = spawn(config.chromeExecutablePath, normalChromeLoginArguments(profileDir), {
      env: childProcessEnvironment(),
      stdio: "ignore",
    });
    const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
      loginBrowser.once("error", rejectExit);
      loginBrowser.once("exit", (code, signal) => {
        if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
        else resolveExit(code ?? 1);
      });
    });
    if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);

    // Do NOT probe profile readiness by repeatedly launching Playwright.
    // Repeated launchPersistentContext attempts are what created the storm of
    // about:blank windows when Chrome still held this Windows profile.
    await waitForDedicatedChromeProfileRelease(profileDir);

    process.stdout.write("Login Chrome closed; extracting ChatGPT session state...\n");
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: config.chromeExecutablePath,
      headless: false,
      env: childProcessEnvironment(),
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
    });

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
      page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
    ).first();
    try {
      await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
    } catch {
      throw new Error("The authenticated ChatGPT page did not produce a visible composer");
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);

    const state = await context.storageState();
    const accountSurfaceUrl = page.url();

    // Release the persistent profile before the independent stored-state
    // verifier launches a separate browser.
    await context.close();
    context = undefined;
    await wait(500);

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl,
      proAvailable: inspected.proAvailable,
    };
  } finally {
    if (context) {
      await context.close().catch(() => {});
      context = undefined;
    }

    // Make sure a failed verifier did not leave the unique profile's Chrome
    // tree behind. Then clean it without converting a Windows file-lock race
    // into "Setup failed".
    await terminateDedicatedChromeProfile(profileDir).catch(() => {});
    await wait(300);
    await removeLoginProfileBestEffort(profileDir);
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    env: childProcessEnvironment(),
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
