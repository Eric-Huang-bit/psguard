import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCommand } from "../src/check.ts";
import { ShellNotFoundError } from "../src/errors.ts";
import { runCommand } from "../src/run.ts";
import { resolveShell } from "../src/shell.ts";
import type { ShellKind } from "../src/types.ts";
import { loadCorpus } from "./corpus/load.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(root, "hooks", "rewrite-command.ts");
const slow = { timeout: 20000 };

const blocked = async () => {
  throw new Error("危险命令不应进入执行器");
};

const dangerous = [
  String.raw`cmd /c "rmdir /s /q \"D:\example\project\cache\""`,
  String.raw`cmd /c "rd /s /q \"C:\example\empty-dir\""`,
  String.raw`cmd.exe /c "RMDIR /s /q \"D:\example\project\cache\""`,
  "rm -rf C:\\",
  "rm -rf C:",
  "rm -rf D:\\*",
  "rm -rf /",
  "rm -rf \\",
  "rm -rf .",
  "rm -rf ..",
  "rm -rf *",
  "rm -rf C:\\Windows",
  "rm -rf C:\\Windows\\System32",
  "rm -rf \"C:\\Program Files\"",
  "rm -rf C:\\Users\\someone",
  "Write-Output hi && rm -rf C:\\",
  "cmd /c rmdir /s /q C:\\",
  "cmd /c rd /s /q C:\\Windows",
  "Remove-Item -LiteralPath 'C:\\' -Recurse -Force",
  "Remove-Item -LiteralPath 'C:\\Windows' -Recurse",
  "Remove-Item C:\\Users\\someone -Recurse -Force",
];

for (const command of dangerous) {
  for (const shell of ["powershell-5.1", "powershell-7", "cmd"] as const) {
    test(`拒绝且不执行 [${shell}] ${command}`, async () => {
      const verdict = checkCommand(command, { kind: shell });
      assert.equal(verdict.action, "reject", verdict.reason);
      assert.equal(verdict.suggestion, undefined);
      if (shell === "powershell-7") {
        try {
          resolveShell("powershell-7");
        } catch (error) {
          if (error instanceof ShellNotFoundError) {
            return;
          }
          throw error;
        }
      }
      const result = await runCommand(command, { shell, runner: blocked });
      assert.equal(result.action, "reject");
      assert.equal(result.executed, false);
    });
  }
}

test("安全复现和具体目录删除不会被误拒绝", () => {
  const echo = String.raw`cmd /c "echo rmdir /s /q \"D:\example\project\cache\""`;
  assert.equal(checkCommand(echo, { kind: "powershell-5.1" }).action, "allow");
  const specific = "Remove-Item -LiteralPath 'D:\\example\\project\\cache' -Recurse -Force";
  assert.equal(checkCommand(specific, { kind: "powershell-5.1" }).action, "allow");
  const nested = "rm -rf C:\\Users\\someone\\AppData\\Local\\Temp\\psguard-safety\\box";
  assert.notEqual(checkCommand(nested, { kind: "powershell-5.1" }).action, "reject");
});

test("只检查时连无害命令也不执行", async () => {
  const result = await runCommand("Write-Output should-not-run", {
    shell: "powershell-5.1",
    execute: false,
    runner: blocked,
  });
  assert.equal(result.action, "allow");
  assert.equal(result.executed, false);
});

test("空命令不执行", async () => {
  const result = await runCommand("   ", { shell: "powershell-5.1", runner: blocked });
  assert.equal(result.action, "allow");
  assert.equal(result.executed, false);
});

test("cmd 上的 PowerShell cmdlet 不执行", async () => {
  const result = await runCommand("Get-Location", { shell: "cmd", runner: blocked });
  assert.equal(result.action, "advise");
  assert.equal(result.executed, false);
});

test("Git Bash 上的 ls 不会被改写成 PowerShell", async () => {
  let seen = "";
  const result = await runCommand("ls -la", {
    shell: "git-bash",
    runner: async (command) => {
      seen = command;
      return { exitCode: 0, stdout: "ok\n", stderr: "" };
    },
  });
  assert.equal(result.action, "allow");
  assert.equal(seen, "ls -la");
});

test("三条 &&、失败后的 ||、以及管道加 &&", slow, async () => {
  const chain = await runCommand("Write-Output a && Write-Output b && Write-Output c", { shell: "powershell-5.1" });
  assert.equal(chain.exitCode, 0, chain.stderr);
  assert.match(chain.stdout ?? "", /a/);
  assert.match(chain.stdout ?? "", /b/);
  assert.match(chain.stdout ?? "", /c/);

  const recovered = await runCommand("cmd /c exit 3 || Write-Output recovered", { shell: "powershell-5.1" });
  assert.equal(recovered.exitCode, 0, recovered.stderr);
  assert.match(recovered.stdout ?? "", /recovered/);

  const piped = await runCommand("Write-Output hello | head -1 && Write-Output after", { shell: "powershell-5.1" });
  assert.equal(piped.exitCode, 0, piped.stderr);
  assert.match(piped.stdout ?? "", /hello/);
  assert.match(piped.stdout ?? "", /after/);
});

test("带空格和中文的临时目录可以创建并删除", slow, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "psguard-safety-"));
  const folder = path.join(root, "子 目录");
  try {
    const made = await runCommand(`mkdir -p '${folder.replaceAll("'", "''")}'`, { shell: "powershell-5.1" });
    assert.equal(made.exitCode, 0, made.stderr);
    const file = path.join(folder, "笔记.txt");
    writeFileSync(file, "line-one\nline-two\n");
    const head = await runCommand(`Get-Content -LiteralPath '${file.replaceAll("'", "''")}' | head -1`, {
      shell: "powershell-5.1",
    });
    assert.equal(head.exitCode, 0, head.stderr);
    assert.match(head.stdout ?? "", /line-one/);
    assert.doesNotMatch(head.stdout ?? "", /line-two/);
    const removed = await runCommand(`rm -rf '${folder.replaceAll("'", "''")}'`, { shell: "powershell-5.1" });
    assert.equal(removed.exitCode, 0, removed.stderr);
    assert.equal(existsSync(folder), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("默认 shell、cmd 和可用的 PowerShell 7 都能跑无害命令", slow, async (t) => {
  const native = await runCommand("Write-Output psguard-default");
  assert.equal(native.exitCode, 0, native.stderr);
  assert.match(native.stdout ?? "", /psguard-default/);

  const prompt = await runCommand("echo psguard-cmd-safe", { shell: "cmd" });
  assert.equal(prompt.exitCode, 0, prompt.stderr);
  assert.match(prompt.stdout ?? "", /psguard-cmd-safe/);

  let ps7: ShellKind | undefined;
  try {
    resolveShell("powershell-7");
    ps7 = "powershell-7";
  } catch (error) {
    if (!(error instanceof ShellNotFoundError)) {
      throw error;
    }
  }
  if (ps7 === undefined) {
    t.diagnostic("这台机器没有可用的 pwsh，跳过 PowerShell 7 实跑");
    return;
  }
  const modern = await runCommand("Write-Output one && Write-Output two", { shell: ps7 });
  assert.equal(modern.action, "allow");
  assert.equal(modern.exitCode, 0, modern.stderr);
  assert.match(modern.stdout ?? "", /one/);
  assert.match(modern.stdout ?? "", /two/);
});

test("hook 拒绝语料里的危险命令，且不返回改写后的删除", () => {
  for (const item of loadCorpus().cases.filter((entry) => entry.action === "reject")) {
    const result = spawnSync(process.execPath, [hook, "--host", "claude"], {
      input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: item.command } }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } };
    };
    assert.equal(json.hookSpecificOutput?.permissionDecision, "deny");
    assert.equal(json.hookSpecificOutput?.updatedInput, undefined);
  }
});

