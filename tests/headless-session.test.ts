import { describe, expect, test } from "bun:test";
import { standardChromeUserAgent } from "../src/browser-login";

describe("headless ChatGPT session compatibility", () => {
  test("uses a normal Chrome UA on Windows", () => {
    expect(standardChromeUserAgent("150.0.7339.5", "win32")).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    );
  });

  test("does not identify runtime as HeadlessChrome", () => {
    expect(standardChromeUserAgent("150.0.7339.5", "win32")).not.toContain("HeadlessChrome");
  });
});
