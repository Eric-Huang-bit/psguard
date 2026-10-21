import type { ShellKind } from "./types.ts";

const ENV_NAMES = [
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "USERNAME",
  "COMPUTERNAME",
  "WINDIR",
  "SystemRoot",
  "ProgramFiles",
  "ProgramData",
  "PUBLIC",
  "HOMEDRIVE",
  "HOMEPATH",
];

export type Translation =
  | { kind: "reject"; reason: string }
  | { kind: "advise"; reason: string; suggestion: string; runnable: boolean };

/** Translate one PowerShell command into a form that can run. Reject is never a runnable delete. */
export function translateCommand(command: string, shell: ShellKind): Translation | undefined {
  if (shell !== "powershell-5.1" && shell !== "powershell-7") {
    return undefined;
  }
  const unsafe = unsafeRemoval(command);
  if (unsafe !== undefined) {
    return { kind: "reject", reason: unsafe };
  }
  if (/\bcmd(?:\.exe)?\s+\/c\s+"\s*echo\b/i.test(command) && /\brmdir\b|\brd\b/i.test(command)) {
    return undefined;
  }

  const pieces = splitChain(command);
  const rewritten = pieces.parts.map((part) => rewriteSegment(part, shell));
  const suggestion = rejoin(rewritten.map((part) => part.text), pieces.ops, shell);
  const runnable = rewritten.every((part) => part.runnable);
  if (suggestion === literalJoin(pieces.parts, pieces.ops) && runnable) {
    return undefined;
  }
  const notes = [...new Set(rewritten.flatMap((part) => part.notes))];
  if (shell === "powershell-5.1" && pieces.ops.length > 0) {
    notes.unshift("PowerShell 5.1 没有 && 和 ||，已按成功或失败接上下一条");
  }
  return {
    kind: "advise",
    reason: `${notes.join("。")}。${runnable ? "这条改写会在同一次调用里执行。" : "这条还不能安全地一次执行。"}`,
    suggestion,
    runnable,
  };
}

function literalJoin(parts: string[], ops: Array<"&&" | "||">): string {
  if (ops.length === 0) {
    return parts[0] ?? "";
  }
  let text = parts[0] ?? "";
  for (let index = 0; index < ops.length; index += 1) {
    text += ` ${ops[index]} ${parts[index + 1] ?? ""}`;
  }
  return text;
}

function rejoin(parts: string[], ops: Array<"&&" | "||">, shell: ShellKind): string {
  if (shell === "powershell-5.1" && ops.length > 0) {
    return joinChain(parts, ops);
  }
  return literalJoin(parts, ops);
}

function joinChain(parts: string[], ops: Array<"&&" | "||">): string {
  let script = `${parts[0]}; $psguardOk = $?`;
  for (let index = 0; index < ops.length; index += 1) {
    const condition = ops[index] === "&&" ? "$psguardOk" : "-not $psguardOk";
    script += `; if (${condition}) { ${parts[index + 1]}; $psguardOk = $? }`;
  }
  script += "; if (-not $psguardOk) { if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1 }";
  return script;
}

function rewriteSegment(segment: string, shell: ShellKind): { text: string; runnable: boolean; notes: string[] } {
  const heredoc = rewriteHeredoc(segment);
  if (heredoc !== undefined) {
    return heredoc;
  }
  let text = segment;
  const notes: string[] = [];
  if (text.includes('\\"')) {
    text = text.replaceAll('\\"', '"');
    notes.push("Bash 的反斜杠引号已改成 PowerShell 引号");
  }
  const prefixed = text.match(/^([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)\s+([\s\S]+)$/);
  if (prefixed !== null) {
    const value = prefixed[2].replaceAll("'", "''");
    text = `$env:${prefixed[1]} = '${value}'; ${prefixed[3]}`;
    notes.push("行首的 NAME=value 已改成 $env:");
  }
  const exported = text.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (exported !== null) {
    const value = exported[2].replaceAll("'", "''");
    return {
      text: `$env:${exported[1]} = '${value}'`,
      runnable: true,
      notes: ["export 已改成 $env:"],
    };
  }

  const withEnv = rewriteEnvNames(text);
  if (withEnv !== undefined) {
    text = withEnv;
    notes.push("环境变量已改成 $env:NAME");
  }
  const beforeMkdir = text;
  text = text.replace(
    /\bmkdir\s+-p\s+('[^']*'|"[^"]*"|\S+)/g,
    "New-Item -ItemType Directory -Force -Path $1",
  );
  if (text !== beforeMkdir) {
    notes.push("mkdir -p 已改成 New-Item");
  }
  const assigned = text.match(/^([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)$/);
  if (assigned !== null) {
    text = `$env:${assigned[1]} = '${assigned[2].replaceAll("'", "''")}'`;
    notes.push("NAME=value 已改成 $env:");
  }

  const stages = splitPipes(text);
  const nextStages = stages.map((stage) => rewriteStage(stage.trim(), shell));
  const joined = nextStages.map((stage) => stage.text).join(" | ");
  notes.push(...nextStages.flatMap((stage) => stage.notes));
  const runnable = nextStages.every((stage) => stage.runnable) && !hasBlocker(joined, shell);
  return { text: joined, runnable, notes };
}

function rewriteStage(stage: string, shell: ShellKind): { text: string; runnable: boolean; notes: string[] } {
  const removed = rewriteRm(stage);
  if (removed !== undefined) {
    return removed;
  }
  const echoed = stage.match(/^echo\s+-n\s+([\s\S]+)$/i);
  if (echoed !== null) {
    return {
      text: `[Console]::Out.Write(${quoteLiteral(echoed[1])})`,
      runnable: true,
      notes: ["echo -n 已改成不换行的标准输出"],
    };
  }
  const assigned = stage.match(/^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/i);
  if (assigned !== null) {
    return {
      text: `$env:${assigned[1]} = '${assigned[2].replaceAll("'", "''")}'`,
      runnable: true,
      notes: ["set NAME=value 已改成 $env:"],
    };
  }
  const tee = stage.match(/^\s*tee\s+(\S+)\s*$/i);
  if (tee !== null) {
    return {
      text: `Tee-Object -FilePath ${quoteLiteral(unquote(tee[1]))}`,
      runnable: true,
      notes: ["tee 已改成 Tee-Object"],
    };
  }
  const numbered = stage.match(/^\s*cat\s+-n\s+(\S+)\s*$/i);
  if (numbered !== null) {
    const file = quoteLiteral(unquote(numbered[1]));
    return {
      text: "$n = 1; Get-Content -LiteralPath " + file + " | ForEach-Object { '{0,6}|{1}' -f $n, $_; $n++ }",
      runnable: true,
      notes: ["cat -n 已改成带行号的 Get-Content"],
    };
  }
  if (/^\s*uniq\s*$/i.test(stage)) {
    return { text: "Get-Unique", runnable: true, notes: ["uniq 已改成 Get-Unique"] };
  }
  const head = rewriteHead(stage);
  if (head !== undefined) {
    return head;
  }
  const tail = rewriteTail(stage);
  if (tail !== undefined) {
    return tail;
  }
  const grep = rewriteGrep(stage);
  if (grep !== undefined) {
    return grep;
  }
  const wc = stage.match(/^wc\s+-l(?:\s+(\S+))?$/i);
  if (wc !== null) {
    const body = wc[1] === undefined
      ? "Measure-Object -Line | Select-Object -ExpandProperty Lines"
      : `(Get-Content ${wc[1]} | Measure-Object -Line).Lines`;
    return { text: body, runnable: true, notes: ["wc -l 已改成 Measure-Object"] };
  }
  const sed = stage.match(/^\s*sed\s+-n\s+(?:"(\d+),(\d+)p"|'(\d+),(\d+)p')\s+(\S+)\s*$/i);
  if (sed !== null) {
    return {
      text: `Get-Content ${sed[5]} -TotalCount ${sed[2] ?? sed[4]}`,
      runnable: true,
      notes: ["sed 按行截取已改成 Get-Content"],
    };
  }
  const awk = stage.match(/^\s*awk\s+(?:"NR<=(\d+)"|'NR<=(\d+)')\s+(\S+)\s*$/i);
  if (awk !== null) {
    return {
      text: `Get-Content ${awk[3]} -TotalCount ${awk[1] ?? awk[2]}`,
      runnable: true,
      notes: ["awk 按行截取已改成 Get-Content"],
    };
  }
  const find = stage.match(/^\s*find\s+(\S+)\s+-name\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i);
  if (find !== null) {
    const pattern = find[2] ?? find[3] ?? find[4];
    const where = find[1] === "." ? "" : `-Path ${find[1]} `;
    return {
      text: `Get-ChildItem ${where}-Recurse -Filter ${pattern}`,
      runnable: true,
      notes: ["find -name 已改成 Get-ChildItem"],
    };
  }
  const listed = stage.match(/^\s*ls\s+-\S+(?:\s+(\S+))?\s*$/i);
  if (listed !== null) {
    return {
      text: listed[1] === undefined ? "Get-ChildItem" : `Get-ChildItem ${listed[1]}`,
      runnable: true,
      notes: ["ls 的 Unix 参数已改成 Get-ChildItem"],
    };
  }
  if (shell === "powershell-5.1" && /^\s*curl\s+-fsSL\b/i.test(stage)) {
    return {
      text: stage.replace(/^\s*curl\b/i, "curl.exe"),
      runnable: true,
      notes: ["curl -fsSL 已改成 curl.exe"],
    };
  }
  const touch = stage.match(/^\s*touch\s+(\S+)\s*$/i);
  if (touch !== null) {
    const file = quoteLiteral(unquote(touch[1]));
    return {
      text: `if (Test-Path -LiteralPath ${file}) { (Get-Item -LiteralPath ${file}).LastWriteTime = Get-Date } else { New-Item -ItemType File -Path ${file} | Out-Null }`,
      runnable: true,
      notes: ["touch 已改成更新或创建文件"],
    };
  }
  const copy = stage.match(/^\s*cp\s+(-r\s+)?(\S+)\s+(\S+)\s*$/i);
  if (copy !== null) {
    const recurse = copy[1] === undefined ? "" : " -Recurse -Force";
    return {
      text: `Copy-Item -LiteralPath ${quoteLiteral(unquote(copy[2]))} -Destination ${quoteLiteral(unquote(copy[3]))}${recurse}`,
      runnable: true,
      notes: ["cp 已改成 Copy-Item"],
    };
  }
  const moved = stage.match(/^\s*mv\s+(\S+)\s+(\S+)\s*$/i);
  if (moved !== null) {
    return {
      text: `Move-Item -LiteralPath ${quoteLiteral(unquote(moved[1]))} -Destination ${quoteLiteral(unquote(moved[2]))} -Force`,
      runnable: true,
      notes: ["mv 已改成 Move-Item"],
    };
  }
  const which = stage.match(/^\s*which\s+(\S+)\s*$/i);
  if (which !== null) {
    return {
      text: `(Get-Command ${which[1]}).Source`,
      runnable: true,
      notes: ["which 已改成 Get-Command"],
    };
  }
  const base = stage.match(/^\s*basename\s+(\S+)\s*$/i);
  if (base !== null) {
    return {
      text: `Split-Path -Leaf ${quoteLiteral(unquote(base[1]))}`,
      runnable: true,
      notes: ["basename 已改成 Split-Path -Leaf"],
    };
  }
  const dir = stage.match(/^\s*dirname\s+(\S+)\s*$/i);
  if (dir !== null) {
    return {
      text: `Split-Path -Parent ${quoteLiteral(unquote(dir[1]))}`,
      runnable: true,
      notes: ["dirname 已改成 Split-Path -Parent"],
    };
  }
  if (/^\s*sed\b/i.test(stage) || /^\s*awk\b/i.test(stage)) {
    return {
      text: stage,
      runnable: false,
      notes: ["这条 sed 或 awk 没有等价的一次执行改写"],
    };
  }
  return { text: stage, runnable: true, notes: [] };
}

function rewriteHead(stage: string): { text: string; runnable: boolean; notes: string[] } | undefined {
  const matched = stage.match(/^head(?:\s+(.*))?$/i);
  if (matched === null) {
    return undefined;
  }
  const rest = (matched[1] ?? "").trim();
  if (rest === "") {
    return { text: "Select-Object -First 10", runnable: true, notes: ["head 已改成 Select-Object"] };
  }
  if (rest.startsWith("-")) {
    const numbered = rest.match(/^(?:-n\s+)?-?(\d+)(?:\s+(.+))?$/);
    if (numbered === null) {
      return { text: stage, runnable: false, notes: ["这条 head 没有等价改写"] };
    }
    const count = numbered[1];
    const file = numbered[2];
    return file === undefined
      ? { text: `Select-Object -First ${count}`, runnable: true, notes: ["head 已改成 Select-Object"] }
      : { text: `Get-Content ${file} -TotalCount ${count}`, runnable: true, notes: ["head 已改成 Get-Content"] };
  }
  return { text: `Get-Content ${rest} -TotalCount 10`, runnable: true, notes: ["head 已改成 Get-Content"] };
}

function rewriteTail(stage: string): { text: string; runnable: boolean; notes: string[] } | undefined {
  if (/^tail\s+-f\b/i.test(stage)) {
    return { text: stage, runnable: false, notes: ["tail -f 会一直占着进程，psguard 不执行"] };
  }
  const numbered = stage.match(/^tail\s+(?:-n\s+)?-?(\d+)\s+(\S+)\s*$/i);
  if (numbered !== null) {
    return {
      text: `Get-Content ${numbered[2]} -Tail ${numbered[1]}`,
      runnable: true,
      notes: ["tail 已改成 Get-Content -Tail"],
    };
  }
  if (/^tail\b/i.test(stage)) {
    return { text: stage, runnable: false, notes: ["这条 tail 没有等价改写"] };
  }
  return undefined;
}

function rewriteGrep(stage: string): { text: string; runnable: boolean; notes: string[] } | undefined {
  const simple = stage.match(/^grep\s+(\S+)\s*$/i);
  if (simple !== null) {
    return { text: `Select-String ${simple[1]}`, runnable: true, notes: ["grep 已改成 Select-String"] };
  }
  const flagged = stage.match(/^grep\s+((?:-[A-Za-z]+\s+)*)(\S+)(?:\s+(\S+))?\s*$/i);
  if (flagged === null) {
    return /^grep\b/i.test(stage)
      ? { text: stage, runnable: false, notes: ["这条 grep 没有等价改写"] }
      : undefined;
  }
  const flags = flagged[1] ?? "";
  if (/-[A-Za-z]*[A-MO-QS-Z]/.test(flags.replaceAll("-n", "").replaceAll("-i", "").replaceAll("-r", "").replaceAll("-R", ""))) {
    return { text: stage, runnable: false, notes: ["这条 grep 没有等价改写"] };
  }
  const pattern = flagged[2];
  const file = flagged[3];
  if (/-r/i.test(flags)) {
    const root = file ?? ".";
    return {
      text: `Get-ChildItem -Path ${root} -Recurse -File | Select-String -Pattern ${pattern}`,
      runnable: true,
      notes: ["grep -r 已改成递归 Select-String"],
    };
  }
  if (file !== undefined) {
    return {
      text: `Select-String -Pattern ${pattern} -Path ${file}`,
      runnable: true,
      notes: ["grep 已改成 Select-String"],
    };
  }
  return { text: `Select-String ${pattern}`, runnable: true, notes: ["grep 已改成 Select-String"] };
}

function rewriteRm(stage: string): { text: string; runnable: boolean; notes: string[] } | undefined {
  const matched = stage.match(/^\s*rm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+('[^']*'|"[^"]*"|\S+)\s*$/i);
  if (matched === null) {
    return undefined;
  }
  const target = unquote(matched[2]);
  if (isUnsafeTarget(target)) {
    return { text: stage, runnable: false, notes: ["rm 的目标不安全"] };
  }
  return {
    text: `Remove-Item -LiteralPath ${quoteLiteral(target)} -Recurse -Force`,
    runnable: true,
    notes: ["rm -rf 已改成 Remove-Item -LiteralPath"],
  };
}

function rewriteHeredoc(segment: string): { text: string; runnable: boolean; notes: string[] } | undefined {
  if (!segment.includes("<<")) {
    return undefined;
  }
  const matched = segment.match(/^(\S+)\s+-\s*<<\s*'?([A-Za-z0-9_]+)'?\r?\n([\s\S]*?)\r?\n\2\s*$/);
  if (matched === null || !/^(python|python3|node)$/i.test(matched[1]) || matched[3].includes("'@")) {
    return {
      text: "把脚本写入临时文件再执行，或改用 python -c。psguard 不拼多行脚本。",
      runnable: false,
      notes: ["PowerShell 没有 bash heredoc"],
    };
  }
  return {
    text: `@'\r\n${matched[3]}\r\n'@ | & ${matched[1]} -`,
    runnable: true,
    notes: ["heredoc 已改成从管道把脚本交给解释器"],
  };
}

export function dangerousDeleteReason(command: string): string | undefined {
  return unsafeRemoval(command);
}

function unsafeRemoval(command: string): string | undefined {
  for (const part of splitChain(command).parts) {
    const removed = part.match(/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+([\s\S]+)$/i);
    if (removed !== null && isUnsafeTarget(unquote(removed[1]))) {
      return `rm 的目标是 ${unquote(removed[1])}，可能删到盘符、系统目录、用户目录根或全部文件。拒绝执行，也不改写。`;
    }
    const cleared = part.match(/\b(?:rmdir|rd)\s+\/s\b(?:\s+\/q)?\s+('[^']*'|"[^"]*"|\S+)/i);
    if (cleared !== null && isUnsafeTarget(unquote(cleared[1]))) {
      return `rmdir / rd 的目标是 ${unquote(cleared[1])}。拒绝执行，也不改写。`;
    }
    if (/\bRemove-Item\b/i.test(part) && /\s-(?:Recurse|r)\b/i.test(part)) {
      const target = removeItemTarget(part);
      if (target !== undefined && isUnsafeTarget(target)) {
        return `Remove-Item -Recurse 的目标是 ${target}。拒绝执行，也不改写。`;
      }
    }
  }
  return undefined;
}

function removeItemTarget(command: string): string | undefined {
  const literal = command.match(/-LiteralPath\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i);
  if (literal !== null) {
    return literal[1] ?? literal[2] ?? literal[3];
  }
  const positional = command.match(/\bRemove-Item\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i);
  if (positional === null) {
    return undefined;
  }
  return positional[1] ?? positional[2] ?? positional[3];
}

function isUnsafeTarget(target: string): boolean {
  const text = target.trim().replaceAll("/", "\\");
  if (text === "" || text === "." || text === ".." || text === "*" || text === "\\" || text === "\\*") {
    return true;
  }
  if (/^[A-Za-z]:\\?$/.test(text) || /^[A-Za-z]:\\\*$/.test(text)) {
    return true;
  }
  if (/^[A-Za-z]:\\(Windows|Program Files|Program Files \(x86\)|ProgramData|PerfLogs)(\\.*)?$/i.test(text)) {
    return true;
  }
  if (/^[A-Za-z]:\\Users$/i.test(text) || /^[A-Za-z]:\\Users\\[^\\]+$/i.test(text)) {
    return true;
  }
  return false;
}

function hasBlocker(command: string, shell: ShellKind): boolean {
  return /(?<!-)\b(head|tail|grep|sed|awk)\b/i.test(command)
    || /\bfind\s+\S+\s+-name\b/i.test(command)
    || /\brm\s+-[A-Za-z]*r/i.test(command)
    || command.includes("<<")
    || /\bexport\b/.test(command)
    || /\bmkdir\s+-p\b/i.test(command)
    || /\bls\s+-\S/.test(command)
    || (shell === "powershell-5.1" && /\bcurl\s+-fsSL\b/i.test(command))
    || /\btouch\b/i.test(command)
    || /\bcp\s+-r\b/i.test(command)
    || /\bmv\s+\S/i.test(command)
    || /\bwhich\b/i.test(command)
    || /\bwc\s+-l\b/i.test(command)
    || /\bbasename\b/i.test(command)
    || /\bdirname\b/i.test(command)
    || /\becho\s+-n\b/i.test(command)
    || /(?:^|[|;&])\s*tee\s/i.test(command)
    || /\bcat\s+-n\b/i.test(command)
    || /\buniq\b/i.test(command)
    || /\bset\s+[A-Za-z_][A-Za-z0-9_]*=/.test(command);
}

function rewriteEnvNames(command: string): string | undefined {
  const pattern = new RegExp(String.raw`(?<![\w.])\$(${ENV_NAMES.join("|")})\b`, "g");
  if (!pattern.test(command)) {
    return undefined;
  }
  pattern.lastIndex = 0;
  return command.replace(pattern, "$$env:$1");
}

function splitChain(command: string): { parts: string[]; ops: Array<"&&" | "||"> } {
  const parts: string[] = [];
  const ops: Array<"&&" | "||"> = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const op = command.startsWith("&&", index) ? "&&" : command.startsWith("||", index) ? "||" : undefined;
    if (op !== undefined) {
      parts.push(command.slice(start, index).trim());
      ops.push(op);
      index += op.length - 1;
      start = index + 1;
    }
  }
  parts.push(command.slice(start).trim());
  return { parts, ops };
}

function splitPipes(command: string): string[] {
  const stages: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote !== null) {
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "|" && command[index + 1] !== "|") {
      stages.push(command.slice(start, index));
      start = index + 1;
    }
  }
  stages.push(command.slice(start));
  return stages;
}

function unquote(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
