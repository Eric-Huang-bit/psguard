import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCorpus, validateCorpus } from "./load.ts";

const corpus = loadCorpus();

test("语料满足格式", () => {
  const errors = validateCorpus(corpus);
  assert.deepEqual(errors, []);
});

test("三种动作和四个 shell 都有代表用例", () => {
  const actions = new Set(corpus.cases.map((item) => item.action));
  const shells = new Set(corpus.cases.map((item) => item.shell));
  assert.deepEqual([...actions].sort(), ["advise", "allow", "reject"]);
  assert.deepEqual(
    [...shells].sort(),
    ["cmd", "git-bash", "powershell-5.1", "powershell-7"],
  );
});

test("拒绝类都含 cmd 嵌套引号的 rmdir 或 rd", () => {
  const rejects = corpus.cases.filter((item) => item.action === "reject");
  assert.ok(rejects.length >= 3);
  for (const item of rejects) {
    assert.match(item.command, /cmd\s+\/c/i);
    assert.match(item.command, /\b(rmdir|rd)\b/i);
    assert.match(item.command, /\/s/);
    assert.match(item.command, /\\"/);
  }
});

test("安全复现和正常 Remove-Item 保持放行", () => {
  const echo = corpus.cases.find((item) => item.id === "ps51-echo-rmdir-repro");
  const remove = corpus.cases.find((item) => item.id === "ps51-remove-item");
  assert.equal(echo?.action, "allow");
  assert.match(echo?.command ?? "", /^cmd\s+\/c\s+"echo\b/i);
  assert.equal(remove?.action, "allow");
  assert.match(remove?.command ?? "", /^Remove-Item\b/);
});
