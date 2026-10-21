import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "rewrite-command.ts");

function runHook(host: "claude" | "cursor" | "codex", payload: unknown): { status: number; json: Record<string, unknown> } {
  const result = spawnSync(process.execPath, [hook, "--host", host], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  const text = (result.stdout ?? "").trim();
  return { status: result.status ?? 1, json: text === "" ? {} : JSON.parse(text) as Record<string, unknown> };
}

test("Cursor hook 把 && 改写成可执行的 PowerShell", () => {
  const result = runHook("cursor", {
    tool_name: "Shell",
    tool_input: { command: "Write-Output one && Write-Output two" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.json.permission, "allow");
  const updated = result.json.updated_input as { command: string };
  assert.match(updated.command, /\$psguardOk/);
  assert.doesNotMatch(updated.command, /&&/);
});

test("Claude hook 拒绝盘符根删除", () => {
  const result = runHook("claude", {
    tool_name: "PowerShell",
    tool_input: { command: "rm -rf C:\\" },
  });
  assert.equal(result.status, 0);
  const output = result.json.hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string };
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /拒绝/);
});

test("Bash 工具保持原命令", () => {
  const result = runHook("cursor", {
    tool_name: "Bash",
    tool_input: { command: "echo one && echo two" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.json.updated_input, undefined);
  assert.equal(result.json.permission, undefined);
});

test("Codex 把名为 Bash 的 Windows shell 改写成 PowerShell", () => {
  const result = runHook("codex", {
    tool_name: "Bash",
    tool_input: { command: "Write-Output one && Write-Output two" },
  });
  assert.equal(result.status, 0);
  const output = result.json.hookSpecificOutput as {
    permissionDecision: string;
    updatedInput: { command: string };
  };
  assert.equal(output.permissionDecision, "allow");
  assert.match(output.updatedInput.command, /\$psguardOk/);
  assert.equal(Object.keys(output.updatedInput).join(","), "command");
});

test("Codex 拒绝盘符根删除", () => {
  const result = runHook("codex", {
    tool_name: "Bash",
    tool_input: { command: "rm -rf C:\\" },
  });
  assert.equal(result.status, 0);
  const output = result.json.hookSpecificOutput as { permissionDecision: string; updatedInput?: unknown };
  assert.equal(output.permissionDecision, "deny");
  assert.equal(output.updatedInput, undefined);
});

test("已经兼容的命令原样放行", () => {
  const result = runHook("claude", {
    tool_name: "Shell",
    tool_input: { command: "Get-Location" },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.json, {});
});
