import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalChromeLoginArguments } from "../src/browser-login";

const root = join(import.meta.dir, "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("Chrome visibility policy", () => {
  test("setup login Chrome remains visible", () => {
    const args = normalChromeLoginArguments("C:\\temp\\codex-login-profile");
    expect(args.some(arg => arg === "--headless" || arg.startsWith("--headless="))).toBe(false);
  });

  test("setup can keep its persisted headed flag false", () => {
    const setupSource = source("src/setup.ts");
    expect(setupSource).toContain("config.headed = false;");
  });

  test("Windows runtime provider forces real headed Chrome", () => {
    const configSource = source("src/config.ts");
    expect(configSource).toContain('headed: process.platform === "win32"');
    expect(configSource).not.toContain("headed: false,\n      localToolsEnabled");
  });

  test("Windows foreground session starts the hidden runtime window watcher", () => {
    const cliSource = source("src/cli.ts");
    expect(cliSource).toContain('startHiddenRuntimeChromeWatcher');
    expect(cliSource).toContain('process.platform === "win32"');
  });

  test("window watcher targets only Playwright Chrome and moves it off-screen", () => {
    const watcherSource = source("src/windows-hidden-chrome.ts");
    expect(watcherSource).toContain("--remote-debugging-pipe");
    expect(watcherSource).toContain("-32000, -32000");
    expect(watcherSource).toContain("$SW_MINIMIZE = 6");
  });

  test("browser worker still maps headed=true to Playwright headless=false", () => {
    const workerSource = source("src/adapters/chatgpt-web/browser-worker.ts");
    expect(workerSource).toContain("headless: !this.config.headed");
  });
});
