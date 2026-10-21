import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus/load.ts";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "main.ts");

test("MCP 能列出工具、执行放行命令，并拦住拒绝命令", { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, [cli, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let stderr = "";
  const waiters: Array<(message: { result?: unknown; error?: { message: string } }) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") {
        continue;
      }
      const waiter = waiters.shift();
      waiter?.(JSON.parse(line) as { result?: unknown; error?: { message: string } });
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let nextId = 1;
  function request(method: string, params?: unknown): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
    const id = nextId;
    nextId += 1;
    const response = new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
      waiters.push(resolve);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "psguard-test", version: "0" },
    });
    assert.equal(initialized.error, undefined, stderr);
    assert.equal((initialized.result?.serverInfo as { name: string }).name, "psguard");

    const listed = await request("tools/list");
    const tools = listed.result?.tools as Array<{ name: string }>;
    assert.equal(tools[0]?.name, "psguard");

    const ran = await request("tools/call", {
      name: "psguard",
      arguments: { command: "Write-Output 'psguard-mcp'", shell: "powershell-5.1" },
    });
    assert.equal(ran.error, undefined, stderr);
    const body = toolBody(ran.result);
    assert.equal(body.executed, true);
    assert.equal(body.exitCode, 0);
    assert.match(String(body.stdout), /psguard-mcp/);
    assert.equal(ran.result?.isError, false);

    const blocked = loadCorpus().cases.find((item) => item.id === "ps51-rmdir-quote");
    assert.ok(blocked);
    const rejected = await request("tools/call", {
      name: "psguard",
      arguments: { command: blocked.command, shell: "powershell-5.1" },
    });
    const rejection = toolBody(rejected.result);
    assert.equal(rejection.action, "reject");
    assert.equal(rejection.executed, false);
    assert.equal(rejection.exitCode, undefined);
    assert.equal(rejected.result?.isError, true);
  } finally {
    child.stdin.end();
    child.kill();
  }
});

function toolBody(result: Record<string, unknown> | undefined): {
  action?: string;
  executed?: boolean;
  exitCode?: number;
  stdout?: string;
} {
  const content = result?.content as Array<{ text: string }> | undefined;
  return JSON.parse(content?.[0]?.text ?? "{}") as {
    action?: string;
    executed?: boolean;
    exitCode?: number;
    stdout?: string;
  };
}
