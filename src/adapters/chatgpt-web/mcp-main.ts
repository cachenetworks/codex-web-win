import { resolveBrokerSocketPath } from "../../config";
import { runChatGptMcpServer } from "./mcp-server";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

export async function runChatGptMcpMain(args: string[]): Promise<void> {
  const brokerSocketPath = resolveBrokerSocketPath(option(
    args,
    "--broker-socket",
    resolveBrokerSocketPath(),
  ));
  await runChatGptMcpServer({ brokerSocketPath });
}
