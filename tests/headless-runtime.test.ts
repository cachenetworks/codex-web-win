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

  test("setup persists the runtime browser as headless", () => {
    const setupSource = source("src/setup.ts");
    expect(setupSource).toContain("config.headed = false;");
  });

  test("runtime provider forces headless even for older saved configs", () => {
    const configSource = source("src/config.ts");
    expect(configSource).toContain("headed: false,");
    expect(configSource).not.toContain("headed: config.headed,");
  });

  test("runtime worker maps headed=false to Playwright headless=true", () => {
    const workerSource = source("src/adapters/chatgpt-web/browser-worker.ts");
    expect(workerSource).toContain("headless: !this.config.headed");
  });
});
