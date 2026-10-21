import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkCommand } from "../src/check.ts";
import { decodeOutput } from "../src/decode.ts";
import { ShellNotFoundError } from "../src/errors.ts";
import { runCommand } from "../src/run.ts";
import { resolveShell } from "../src/shell.ts";
import type { ShellKind } from "../src/types.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "cli", "main.ts");
const hook = path.join(root, "hooks", "rewrite-command.ts");
const slow = { timeout: 20000 };

function rewritten(command: string, shell: ShellKind = "powershell-5.1"): string {
  const result = checkCommand(command, { kind: shell });
  assert.equal(result.action, "advise", result.reason);
  assert.equal(result.runnable, true, result.suggestion);
  return result.suggestion ?? "";
}

function notRun(command: string): void {
  const result = checkCommand(command, { kind: "powershell-5.1" });
  assert.notEqual(result.action, "allow");
  assert.equal(result.runnable, false);
}

test("常见文本命令会改成可执行的 PowerShell", () => {
  assert.match(rewritten("head"), /Select-Object -First 10$/);
  assert.match(rewritten("head README.md"), /Get-Content README\.md -TotalCount 10/);
  assert.match(rewritten("head -n 3 file.txt"), /Get-Content file\.txt -TotalCount 3/);
  assert.match(rewritten("tail -n 4 app.log"), /Get-Content app\.log -Tail 4/);
  assert.match(rewritten("grep -n error file.txt"), /Select-String -Pattern error -Path file\.txt/);
  assert.match(rewritten("grep -r pattern src"), /Get-ChildItem -Path src -Recurse -File/);
  assert.match(rewritten("wc -l"), /Measure-Object -Line/);
  assert.match(rewritten("wc -l notes.txt"), /Get-Content notes\.txt/);
  assert.match(rewritten("find src -name '*.js'"), /-Path src .*Filter \*\.js/);
  assert.match(rewritten("ls -la src"), /^Get-ChildItem src$/);
  assert.match(rewritten("cp a.txt b.txt"), /Copy-Item -LiteralPath 'a\.txt' -Destination 'b\.txt'$/);
  assert.match(rewritten("cp -r from to"), /-Recurse -Force/);
  assert.match(rewritten("mv old.txt new.txt"), /Move-Item -LiteralPath 'old\.txt'/);
  assert.match(rewritten("dirname C:\\Windows\\System32"), /Split-Path -Parent 'C:\\Windows\\System32'/);
  assert.match(rewritten("cat -n a.txt"), /Get-Content -LiteralPath 'a\.txt'/);
  assert.match(rewritten("tee out.txt"), /Tee-Object -FilePath 'out\.txt'/);
  assert.match(rewritten("Write-Output a | uniq"), /Get-Unique$/);
  assert.match(rewritten("set FOO=bar"), /\$env:FOO = 'bar'/);
  assert.match(rewritten("set FOO=it's"), /\$env:FOO = 'it''s'/);
});

test("改不稳的命令不会被标成可执行", () => {
  notRun("head --weird");
  notRun("sed 's/a/b/' file.txt");
  notRun("awk '{print $1}' file.txt");
  notRun("grep -P pattern");
  notRun("python - <<'PY'");
});

test("引号里的 && 和 PowerShell 7 的 && 保持原样", () => {
  assert.equal(checkCommand('Write-Output "a && b"', { kind: "powershell-5.1" }).action, "allow");
  assert.equal(checkCommand("Write-Output $HOME", { kind: "powershell-5.1" }).action, "allow");
  const modern = checkCommand("npm test && npm run build", { kind: "powershell-7" });
  assert.equal(modern.action, "allow");
  const mixed = rewritten("Write-Output ready && head -1", "powershell-7");
  assert.match(mixed, /&&/);
  assert.match(mixed, /Select-Object -First 1/);
});

test("curl -fsSL 只在 PowerShell 5.1 上改写", () => {
  assert.match(rewritten("curl -fsSL https://example.com/install.ps1"), /^curl\.exe -fsSL /);
  assert.equal(
    checkCommand("curl -fsSL https://example.com/install.ps1", { kind: "powershell-7" }).action,
    "allow",
  );
});

test("有正文的 heredoc 可以改写，正文里的结束符则不行", () => {
  const ready = checkCommand("node - <<'JS'\nconsole.log(1)\nJS", { kind: "powershell-5.1" });
  assert.equal(ready.runnable, true);
  assert.match(ready.suggestion ?? "", /node -/);
  const broken = checkCommand("node - <<'JS'\n'@\nJS", { kind: "powershell-5.1" });
  assert.equal(broken.runnable, false);
});

test("Git Bash 和 cmd 的改写方向相反", async () => {
  const bash = checkCommand("Get-Content package.json | Select-Object -First 5", { kind: "git-bash" });
  assert.equal(bash.runnable, true);
  assert.match(bash.suggestion ?? "", /^head -n 5 package\.json$/);
  const prompt = await runCommand("Get-ChildItem -Name", { shell: "cmd" });
  assert.equal(prompt.exitCode, 0, prompt.stderr);
  assert.equal(prompt.action, "rewritten");
});

test("wc、tee、cp 和 mv 在临时目录里真实跑通", slow, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "psguard-cover-"));
  const source = path.join(dir, "source.txt");
  const copied = path.join(dir, "copied.txt");
  const moved = path.join(dir, "moved.txt");
  const teed = path.join(dir, "teed.txt");
  try {
    writeFileSync(source, "alpha\nbeta\n");
    const lines = await runCommand(`wc -l ${source}`, { shell: "powershell-5.1" });
    assert.equal(lines.exitCode, 0, lines.stderr);
    assert.match(lines.stdout ?? "", /2/);

    const numbered = await runCommand(`cat -n ${source}`, { shell: "powershell-5.1" });
    assert.equal(numbered.exitCode, 0, numbered.stderr);
    assert.match(numbered.stdout ?? "", /alpha/);

    const saved = await runCommand(`Write-Output teed | tee ${teed}`, { shell: "powershell-5.1" });
    assert.equal(saved.exitCode, 0, saved.stderr);
    const savedBytes = readFileSync(teed);
    const savedText = savedBytes.includes(0) ? savedBytes.toString("utf16le") : savedBytes.toString("utf8");
    assert.match(savedText, /teed/);

    const duplicate = await runCommand(`cp ${source} ${copied}`, { shell: "powershell-5.1" });
    assert.equal(duplicate.exitCode, 0, duplicate.stderr);
    assert.match(readFileSync(copied, "utf8"), /beta/);

    const relocated = await runCommand(`mv ${copied} ${moved}`, { shell: "powershell-5.1" });
    assert.equal(relocated.exitCode, 0, relocated.stderr);
    assert.match(readFileSync(moved, "utf8"), /beta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dirname 一次返回父目录", slow, async () => {
  const result = await runCommand("dirname C:\\Windows\\System32", { shell: "powershell-5.1" });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout ?? "", /Windows/);
});

test("编码解码覆盖 UTF-8、UTF-16 和未知代码页", () => {
  assert.equal(decodeOutput(Buffer.from("你好\r\n", "utf8"), 65001), "你好\n");
  assert.equal(decodeOutput(Buffer.from("\uFEFFhello\r\n", "utf8"), 65001), "hello\n");
  assert.equal(decodeOutput(Buffer.from("ok\r\n", "utf16le"), 1200), "ok\n");
  assert.equal(decodeOutput(Buffer.from("plain", "utf8"), 99999), "plain");
});

test("hook 处理空输入、坏 JSON、无工具名和 tail -f", () => {
  const empty = spawnSync(process.execPath, [hook, "--host", "cursor"], { input: "", encoding: "utf8" });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.trim(), "{}");

  const broken = spawnSync(process.execPath, [hook, "--host", "claude"], { input: "{", encoding: "utf8" });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout.trim(), "{}");

  const direct = spawnSync(process.execPath, [hook, "--host", "cursor"], {
    input: JSON.stringify({ command: "Write-Output a && Write-Output b" }),
    encoding: "utf8",
  });
  assert.equal(direct.status, 0);
  const updated = JSON.parse(direct.stdout) as { updated_input?: { command: string } };
  assert.match(updated.updated_input?.command ?? "", /\$psguardOk/);

  const follow = spawnSync(process.execPath, [hook, "--host", "claude"], {
    input: JSON.stringify({ tool_name: "Shell", tool_input: { command: "tail -f app.log" } }),
    encoding: "utf8",
  });
  const denied = JSON.parse(follow.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
});

test("命令行帮助、未知 shell 和 install", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /psguard install/);

  const unknown = spawnSync(process.execPath, [cli, "check", "--shell", "zsh", "Get-Location"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /未知 shell/);

  const installed = spawnSync(process.execPath, [cli, "install"], { encoding: "utf8" });
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /hook/);
});

test("没有 pwsh 时解析 PowerShell 7 会失败", (t) => {
  try {
    resolveShell("powershell-7");
    t.diagnostic("这台机器有 pwsh，解析成功也是预期结果");
  } catch (error) {
    assert.ok(error instanceof ShellNotFoundError);
  }
});
