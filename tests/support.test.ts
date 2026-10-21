import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decodeOutput } from "../src/decode.ts";
import { isUsableExecutable } from "../src/shell.ts";

test("GBK 管道输出能还原中文", () => {
  const bytes = Buffer.from("c4e3bac30d0a", "hex");
  assert.equal(decodeOutput(bytes, 936), "你好\n");
});

test("空文件和 WindowsApps 别名不能当 shell", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "psguard-exe-"));
  try {
    const empty = path.join(dir, "pwsh.exe");
    writeFileSync(empty, "");
    assert.equal(isUsableExecutable(empty), false);
    const real = path.join(dir, "real.exe");
    writeFileSync(real, "x");
    assert.equal(isUsableExecutable(real), true);
    assert.equal(
      isUsableExecutable("C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
