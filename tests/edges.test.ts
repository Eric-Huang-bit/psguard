import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCommand } from "../src/check.ts";
import { runCommand } from "../src/run.ts";
import { isUsableExecutable, resetShellCache, detectShell } from "../src/shell.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli", "main.ts");
const slow = { timeout: 20000 };
const blocked = async () => {
  throw new Error("这条命令不应执行");
};

test("更多危险目标都被拒绝，而且执行器不会被调用", async () => {
  const commands = [
    "rm -rf C:\\Program Files (x86)",
    "rm -rf \"C:\\Program Files (x86)\\Common Files\"",
    "rm -rf C:\\PerfLogs",
    "Remove-Item -LiteralPath 'C:\\ProgramData' -Recurse",
    "Remove-Item C:\\Users -Recurse",
    "cmd /c rd /s /q D:\\",
  ];
  for (const command of commands) {
    const result = await runCommand(command, { shell: "powershell-5.1", runner: blocked });
    assert.equal(result.action, "reject", command);
    assert.equal(result.executed, false, command);
    assert.equal(result.suggestion, undefined, command);
  }
});

test("Git Bash 和 cmd 上无法改写的 cmdlet 不执行", async () => {
  const bash = await runCommand("Get-Process", { shell: "git-bash", runner: blocked });
  assert.equal(bash.action, "advise");
  assert.equal(bash.runnable, false);
  assert.equal(bash.executed, false);

  const prompt = await runCommand("Get-Process", { shell: "cmd", runner: blocked });
  assert.equal(prompt.action, "advise");
  assert.equal(prompt.runnable, false);
  assert.equal(prompt.executed, false);
});

test("赋值、引号内的管道和 && 后接失败恢复", () => {
  const assigned = checkCommand("FOO=bar", { kind: "powershell-5.1" });
  assert.equal(assigned.runnable, true);
  assert.match(assigned.suggestion ?? "", /\$env:FOO = 'bar'/);

  const exported = checkCommand("export FOO=bar", { kind: "powershell-5.1" });
  assert.match(exported.suggestion ?? "", /\$env:FOO = 'bar'/);

  const quoted = checkCommand("Write-Output 'a|b && c'", { kind: "powershell-5.1" });
  assert.equal(quoted.action, "allow");
});

test("引号里的文本、多段管道和失败后的恢复都会真实执行", slow, async () => {
  const quoted = await runCommand("Write-Output 'a|b && c'", { shell: "powershell-5.1" });
  assert.equal(quoted.action, "allow");
  assert.equal(quoted.exitCode, 0, quoted.stderr);
  assert.match(quoted.stdout ?? "", /a\|b && c/);

  const piped = await runCommand("Write-Output hello | head -5 | head -1", { shell: "powershell-5.1" });
  assert.equal(piped.exitCode, 0, piped.stderr);
  assert.match(piped.stdout ?? "", /hello/);

  const recovered = await runCommand("Write-Output left && cmd /c exit 4 || Write-Output recovered", {
    shell: "powershell-5.1",
  });
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.match(recovered.stdout ?? "", /left/);
  assert.match(recovered.stdout ?? "", /recovered/);
});

test("失败命令的错误文本会回到 stderr", slow, async () => {
  const result = await runCommand("Get-Item C:\\no\\such\\psguard-edge", { shell: "powershell-5.1" });
  assert.notEqual(result.exitCode, 0);
  assert.match(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, /psguard-edge/);
});

test("命令行 check 对危险命令返回 3，run 对 tail -f 返回 2", () => {
  const rejected = spawnSync(process.execPath, [cli, "check", "--shell", "powershell-5.1", "rm -rf C:\\"], {
    encoding: "utf8",
  });
  assert.equal(rejected.status, 3);
  assert.match(rejected.stdout, /action: reject/);
  assert.doesNotMatch(rejected.stdout, /executed: true/);

  const follow = spawnSync(process.execPath, [cli, "run", "--shell", "powershell-5.1", "tail -f app.log"], {
    encoding: "utf8",
    timeout: 8000,
  });
  assert.equal(follow.status, 2);
  assert.match(follow.stdout, /action: advise/);
  assert.match(follow.stdout, /executed: false/);
});

test("shell 缓存和不存在的可执行文件", () => {
  resetShellCache();
  const first = detectShell();
  const second = detectShell();
  assert.equal(first.executable, second.executable);
  assert.equal(isUsableExecutable("C:\\no\\such\\psguard.exe"), false);
});

test("MCP 的 ping、错误参数和只检查模式", slow, async () => {
  const child = spawn(process.execPath, [cli, "mcp"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buffer = "";
  const waiters: Array<(message: { result?: Record<string, unknown>; error?: { message: string } }) => void> = [];
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
      waiters.shift()?.(JSON.parse(line) as { result?: Record<string, unknown>; error?: { message: string } });
    }
  });
  let nextId = 1;
  function request(method: string, params?: unknown) {
    const id = nextId;
    nextId += 1;
    const response = new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((resolve) => {
      waiters.push(resolve);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  }
  try {
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
    const ping = await request("ping");
    assert.deepEqual(ping.result, {});

    const missing = await request("tools/call", { name: "psguard", arguments: {} });
    assert.match(missing.error?.message ?? "", /command/);

    const badShell = await request("tools/call", {
      name: "psguard",
      arguments: { command: "Get-Location", shell: "zsh" },
    });
    assert.match(badShell.error?.message ?? "", /shell/);

    const unknown = await request("nope");
    assert.match(unknown.error?.message ?? "", /未知方法/);

    const checked = await request("tools/call", {
      name: "psguard",
      arguments: { command: "Write-Output hidden", shell: "powershell-5.1", execute: false },
    });
    const body = JSON.parse((checked.result?.content as Array<{ text: string }>)[0].text) as {
      executed: boolean;
      stdout?: string;
    };
    assert.equal(body.executed, false);
    assert.equal(body.stdout, undefined);
  } finally {
    child.stdin.end();
    child.kill();
  }
});
