import { spawn, spawnSync, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { join } from "node:path";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Authentication belongs to the Codex client that calls this bridge. The
 * bridge's Chrome and tunnel helpers authenticate with stored browser state
 * and an explicit runtime-key file, so forwarding Codex/OpenAI credentials to
 * those descendants only widens their exposure.
 */
export const SENSITIVE_CHILD_ENVIRONMENT_VARIABLES = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
] as const;

const sensitiveChildEnvironmentNames = new Set<string>(
  SENSITIVE_CHILD_ENVIRONMENT_VARIABLES.map(name => name.toUpperCase()),
);

export function childProcessEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => (
      !sensitiveChildEnvironmentNames.has(name.toUpperCase())
    )),
  );
}

export function externalUrlOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } | undefined {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return {
      command: join(environment.SystemRoot?.trim() || "C:\\Windows", "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  return undefined;
}

export function runCommand(command: string, args: string[], options: SpawnSyncOptions = {}): CommandResult {
  const { env = process.env, ...safeOptions } = options;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    ...safeOptions,
    env: childProcessEnvironment(env),
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === "string" ? result.stdout : result.stdout?.toString("utf8") ?? "",
    stderr: typeof result.stderr === "string" ? result.stderr : result.stderr?.toString("utf8") ?? "",
  };
}

export function runChecked(command: string, args: string[], options: SpawnSyncOptions = {}): CommandResult {
  const result = runCommand(command, args, options);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

export function spawnDetached(
  command: string,
  args: string[],
  options: SpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    throw new Error(
      "Detached Windows children are disabled; launch them through `codex-chatgpt-web session` so its Job Object owns them",
    );
  }
  const { env = process.env, ...safeOptions } = options;
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    ...safeOptions,
    env: childProcessEnvironment(env),
  });
  child.unref();
}
