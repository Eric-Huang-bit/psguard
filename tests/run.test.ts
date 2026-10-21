import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ShellNotFoundError } from "../src/errors.ts";
import { runCommand } from "../src/run.ts";
import { detectShell, isUsableExecutable, resolveShell } from "../src/shell.ts";
import { loadCorpus } from "./corpus/load.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli", "main.ts");
const slow = { timeout: 20000 };

test("detectShell 指向真实可执行文件", slow, () => {
  const shell = detectShell();
  assert.ok(shell.kind === "powershell-5.1" || shell.kind === "powershell-7");
  assert.equal(typeof shell.executable, "string");
  assert.equal(isUsableExecutable(shell.executable ?? ""), true);
  assert.equal(typeof shell.codePage, "number");
});

test("allow 的输出和退出码原样返回", slow, async () => {
  const result = await runCommand("Write-Output 'psguard-ok'", { shell: "powershell-5.1" });
  assert.equal(result.action, "allow");
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /psguard-ok/);
});

test("中文输出按代码页解码", slow, async () => {
  const result = await runCommand("Write-Output '你好'", { shell: "powershell-5.1" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /你好/);
});

test("原生命令的非零退出码保留", slow, async () => {
  const result = await runCommand("cmd /c exit 7", { shell: "powershell-5.1" });
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 7);
});

test("失败的 cmdlet 不是退出码 0", slow, async () => {
  const result = await runCommand("Get-Item C:\\no\\such\\psguard-missing", { shell: "powershell-5.1" });
  assert.equal(result.executed, true);
  assert.notEqual(result.exitCode, 0);
});

test("可安全改写的命令在同一次调用里执行改写结果", async () => {
  let seen = "";
  const result = await runCommand("cd server && npm install", {
    shell: "powershell-5.1",
    runner: async (command) => {
      seen = command;
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  assert.equal(result.action, "rewritten");
  assert.equal(result.executed, true);
  assert.equal(result.executedCommand, seen);
  assert.match(seen, /if \(\$psguardOk\) \{ npm install/);
  assert.doesNotMatch(seen, /&&/);
});

test("reject 不执行", async () => {
  const sample = loadCorpus().cases.find((item) => item.id === "ps51-rmdir-quote");
  assert.ok(sample);
  const result = await runCommand(sample.command, {
    shell: "powershell-5.1",
    runner: async () => {
      throw new Error("executed");
    },
  });
  assert.equal(result.action, "reject");
  assert.equal(result.executed, false);
  assert.equal(result.suggestion, undefined);
});

test("execute false 时 allow 也不启动进程", async () => {
  const result = await runCommand("Write-Output 'psguard-ok'", {
    shell: "powershell-5.1",
    execute: false,
    runner: async () => {
      throw new Error("executed");
    },
  });
  assert.equal(result.action, "allow");
  assert.equal(result.executed, false);
});

test("超时返回 124", slow, async () => {
  const result = await runCommand("Start-Sleep -Seconds 30", {
    shell: "powershell-5.1",
    timeoutMs: 800,
  });
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr ?? "", /timed out/);
});

test("cmd 能执行", slow, async () => {
  const result = await runCommand("echo psguard-cmd", { shell: "cmd" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /psguard-cmd/);
});

test("Git Bash 能执行", slow, async (t) => {
  try {
    resolveShell("git-bash");
  } catch (error) {
    if (error instanceof ShellNotFoundError) {
      t.skip("这台机器没有 Git Bash");
      return;
    }
    throw error;
  }
  const result = await runCommand("echo psguard-bash", { shell: "git-bash" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /psguard-bash/);
});

test("命令行 check 与 run", slow, () => {
  const checked = spawnSync(process.execPath, [
    cli,
    "check",
    "--shell",
    "powershell-5.1",
    "cd server && npm install",
  ], { encoding: "utf8" });
  assert.equal(checked.status, 2);
  assert.match(checked.stdout, /action: advise/);
  assert.doesNotMatch(checked.stdout, /executed: true/);

  const ran = spawnSync(process.execPath, [
    cli,
    "run",
    "--shell",
    "powershell-5.1",
    "Write-Output psguard-cli",
  ], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /psguard-cli/);
  assert.match(ran.stdout, /exitCode: 0/);
});
