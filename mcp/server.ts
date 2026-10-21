import readline from "node:readline";
import { ShellNotFoundError } from "../src/errors.ts";
import { runCommand } from "../src/run.ts";
import { SHELL_KINDS, type ShellKind } from "../src/types.ts";
import { psguardTool } from "./tool.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

let pending = Promise.resolve();

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

input.on("line", (line) => {
  const text = line.trim();
  if (text === "") {
    return;
  }
  pending = pending.then(() => handleLine(text)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  });
});

input.on("close", () => {
  void pending.then(() => process.exit(0));
});

async function handleLine(text: string): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(text) as JsonRpcRequest;
  } catch {
    return;
  }
  if (message.method === undefined || message.id === undefined || message.id === null) {
    return;
  }
  try {
    const result = await dispatch(message);
    respond(message.id, result);
  } catch (error) {
    respondError(message.id, error instanceof Error ? error.message : String(error));
  }
}

async function dispatch(message: JsonRpcRequest): Promise<unknown> {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "psguard", version: "0.1.0" },
      instructions:
        "On Windows, use psguard instead of the built-in shell. It rewrites common PowerShell mismatches and runs the fixed command in the same call. executed true and exitCode 0 means it passed. action reject means do not try another delete.",
    };
  }
  if (message.method === "ping") {
    return {};
  }
  if (message.method === "tools/list") {
    return { tools: [psguardTool] };
  }
  if (message.method === "tools/call") {
    return callTool(message.params?.name, message.params?.arguments ?? {});
  }
  throw new Error(`未知方法 ${message.method}`);
}

async function callTool(name: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  if (name !== psguardTool.name) {
    throw new Error(`未知工具 ${name ?? ""}`);
  }
  if (typeof args.command !== "string" || args.command.trim() === "") {
    throw new Error("command 必须是非空字符串");
  }
  const shell = args.shell === undefined ? undefined : parseShell(args.shell);
  const execute = args.execute === undefined ? true : args.execute === true;
  try {
    const result = await runCommand(args.command, { shell, execute });
    const body = {
      action: result.action,
      reason: result.reason,
      suggestion: result.suggestion,
      executedCommand: result.executedCommand,
      shell: result.shell.kind,
      executable: result.shell.executable,
      version: result.shell.version,
      executed: result.executed,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    const failed = result.action === "reject"
      || (result.action === "advise" && !result.executed)
      || (result.executed && result.exitCode !== 0);
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      isError: failed,
    };
  } catch (error) {
    if (error instanceof ShellNotFoundError) {
      throw error;
    }
    throw error;
  }
}

function parseShell(value: unknown): ShellKind {
  if (typeof value === "string" && SHELL_KINDS.includes(value as ShellKind)) {
    return value as ShellKind;
  }
  throw new Error(`shell 必须是 ${SHELL_KINDS.join("、")} 之一`);
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: number | string, message: string): void {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message },
  })}\n`);
}

