import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCommand } from "../src/run.ts";

const slow = { timeout: 20000 };

test("&& 在同一次调用里跑完两条命令", slow, async () => {
  const result = await runCommand("Write-Output one && Write-Output two", { shell: "powershell-5.1" });
  assert.equal(result.action, "rewritten");
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /one/);
  assert.match(result.stdout ?? "", /two/);
});

test("前一条失败时 && 后面的命令不跑", slow, async () => {
  const result = await runCommand("cmd /c exit 7 && Write-Output should-not-run", { shell: "powershell-5.1" });
  assert.equal(result.executed, true);
  assert.equal(result.exitCode, 7);
  assert.doesNotMatch(result.stdout ?? "", /should-not-run/);
});

test("失败的目录切换不会被后面的命令掩盖", slow, async () => {
  const result = await runCommand("Set-Location C:\\no\\such\\psguard-missing && Write-Output should-not-run", {
    shell: "powershell-5.1",
  });
  assert.equal(result.executed, true);
  assert.notEqual(result.exitCode, 0);
  assert.doesNotMatch(result.stdout ?? "", /should-not-run/);
});

test("管道里的 head 一次跑通", slow, async () => {
  const result = await runCommand("Write-Output hello | head -1", { shell: "powershell-5.1" });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /hello/);
});

test("ls -la 一次跑通", slow, async () => {
  const result = await runCommand("ls -la", { shell: "powershell-5.1" });
  assert.equal(result.action, "rewritten");
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /psguard|Directory|Mode|d----|----/i);
});

test("$USERPROFILE 一次展开", slow, async () => {
  const result = await runCommand("Write-Output $USERPROFILE", { shell: "powershell-5.1" });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", new RegExp(process.env.USERPROFILE?.replaceAll("\\", "\\\\") ?? "Users"));
});

test("mkdir、touch、rm -rf 在临时目录一次完成", slow, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "psguard-oneshot-"));
  const folder = path.join(root, "nested");
  const file = path.join(folder, "note.txt");
  try {
    const made = await runCommand(`mkdir -p ${folder}`, { shell: "powershell-5.1" });
    assert.equal(made.exitCode, 0, made.stderr);
    assert.equal(existsSync(folder), true);

    const touched = await runCommand(`touch ${file}`, { shell: "powershell-5.1" });
    assert.equal(touched.exitCode, 0, touched.stderr);
    assert.equal(existsSync(file), true);

    const removed = await runCommand(`rm -rf ${folder}`, { shell: "powershell-5.1" });
    assert.equal(removed.action, "rewritten");
    assert.equal(removed.exitCode, 0, removed.stderr);
    assert.equal(existsSync(folder), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("盘符根上的 rm -rf 不执行", async () => {
  let ran = false;
  const result = await runCommand("rm -rf C:\\", {
    shell: "powershell-5.1",
    runner: async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(ran, false);
  assert.equal(result.action, "reject");
  assert.equal(result.executed, false);
});

test("tail -f 不执行", async () => {
  let ran = false;
  const result = await runCommand("tail -f .\\app.log", {
    shell: "powershell-5.1",
    runner: async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(ran, false);
  assert.equal(result.executed, false);
});

test("引号、echo -n 和行首赋值一次跑通", slow, async () => {
  const quoted = await runCommand('Write-Output \\"psguard-quote\\"', { shell: "powershell-5.1" });
  assert.equal(quoted.exitCode, 0, quoted.stderr);
  assert.match(quoted.stdout ?? "", /psguard-quote/);

  const nonewline = await runCommand("echo -n psguard-nonewline", { shell: "powershell-5.1" });
  assert.equal(nonewline.exitCode, 0, nonewline.stderr);
  assert.match(nonewline.stdout ?? "", /psguard-nonewline/);

  const assigned = await runCommand("PSGUARD_MARK=oneshot Write-Output $env:PSGUARD_MARK", { shell: "powershell-5.1" });
  assert.equal(assigned.exitCode, 0, assigned.stderr);
  assert.match(assigned.stdout ?? "", /oneshot/);
});

test("which 和 basename 一次跑通", slow, async () => {
  const which = await runCommand("which node", { shell: "powershell-5.1" });
  assert.equal(which.exitCode, 0, which.stderr);
  assert.match(which.stdout ?? "", /node/i);

  const base = await runCommand("basename C:\\Windows\\System32", { shell: "powershell-5.1" });
  assert.equal(base.exitCode, 0, base.stderr);
  assert.match(base.stdout ?? "", /System32/);
});
