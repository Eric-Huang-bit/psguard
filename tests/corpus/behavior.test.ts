import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand } from "../../src/check.ts";
import { loadCorpus } from "./load.ts";

const corpus = loadCorpus();

const suggestionMatches: Record<string, RegExp> = {
  "ps51-andand-cd-npm": /^cd server; \$psguardOk = \$\?; if \(\$psguardOk\) \{ npm install; \$psguardOk = \$\? \}/,
  "ps51-andand-npm-dev": /^npm install; \$psguardOk = \$\?; if \(\$psguardOk\) \{ npm run dev; \$psguardOk = \$\? \}/,
  "ps51-andand-cd-claude": /^cd "C:\\example\\repo"; \$psguardOk = \$\?; if \(\$psguardOk\) \{ claude; \$psguardOk = \$\? \}/,
  "ps51-andand-mkdir": /New-Item -ItemType Directory -Force -Path backend\/app/,
  "ps51-oror": /^npm test; \$psguardOk = \$\?; if \(-not \$psguardOk\) \{ echo failed; \$psguardOk = \$\? \}/,
  "ps51-head": /^pnpm run typecheck 2>&1 \| Select-Object -First 50$/,
  "ps51-tail": /^Get-Content \.\\app\.log -Tail 20$/,
  "ps51-grep": /^npm test 2>&1 \| Select-String error$/,
  "ps51-sed": /^Get-Content README\.md -TotalCount 20$/,
  "ps51-awk": /^Get-Content README\.md -TotalCount 20$/,
  "ps51-find-name": /^Get-ChildItem -Recurse -Filter \*\.ts$/,
  "ps51-ls-la": /^Get-ChildItem$/,
  "ps51-curl-fssl": /^curl\.exe -fsSL https:\/\/example\.com\/install\.ps1$/,
  "ps51-export": /^\$env:NODE_ENV = 'production'$/,
  "ps51-env-var": /^cd \$env:USERPROFILE$/,
  "ps51-heredoc": /python -c/,
  "gitbash-get-content": /^head -n 200 package\.json$/,
  "cmd-get-childitem": /^dir \/b$/,
};

for (const item of corpus.cases) {
  test(`${item.id} → ${item.action}`, () => {
    const result = checkCommand(item.command, { kind: item.shell });
    assert.equal(result.action, item.action, result.reason);
    assert.equal(result.shell.kind, item.shell);
    assert.ok(result.reason.trim().length > 0);
    if (item.action === "advise") {
      assert.equal(typeof result.suggestion, "string");
      assert.ok((result.suggestion ?? "").trim().length > 0);
      const expected = suggestionMatches[item.id];
      if (expected !== undefined) {
        assert.match(result.suggestion ?? "", expected);
      }
    } else {
      assert.equal(result.suggestion, undefined);
    }
  });
}
