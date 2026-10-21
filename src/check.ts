import { translateCommand, dangerousDeleteReason } from "./rewrite.ts";
import type { CheckResult, ShellKind, ShellProfile } from "./types.ts";

/**
 * Decide whether a command may run on the given shell.
 * Does not spawn a process. Reject cases are never rewritten.
 * Expected actions live in tests/corpus/cases.json.
 */
export function checkCommand(
  command: string,
  shell: ShellProfile,
): CheckResult {
  const text = command.trim();
  if (text === "") {
    return allow(shell, "空命令。");
  }

  const broken = brokenDelete(text, shell.kind);
  if (broken !== undefined) {
    return reject(
      shell,
      `PowerShell 不把 \\" 当作转义。cmd /c 里的 ${broken} /s 可能把目标变成当前盘根。拒绝执行，也不改写成另一条删除命令。`,
    );
  }
  const dangerous = dangerousDeleteReason(text);
  if (dangerous !== undefined) {
    return reject(shell, dangerous);
  }

  if (isPowerShell(shell.kind)) {
    const translated = translateCommand(text, shell.kind);
    if (translated?.kind === "reject") {
      return reject(shell, translated.reason);
    }
    if (translated?.kind === "advise") {
      return advise(shell, translated.reason, translated.suggestion, translated.runnable);
    }
  }

  if (shell.kind === "git-bash" || shell.kind === "cmd") {
    const dialect = adviseForeignCmdlet(text, shell);
    if (dialect !== undefined) {
      return dialect;
    }
  }

  return allow(shell, `未命中 ${shell.kind} 上的检查规则。`);
}

function brokenDelete(command: string, _shell: ShellKind): "rmdir" | "rd" | undefined {
  if (!command.includes('\\"')) {
    return undefined;
  }
  if (/\bcmd(?:\.exe)?\s+\/c\s+"\s*echo\b/i.test(command)) {
    return undefined;
  }
  const invoked = command.match(/\bcmd(?:\.exe)?\s+\/c\s+"\s*(rmdir|rd)\b/i);
  if (invoked === null || !/\/s\b/i.test(command)) {
    return undefined;
  }
  return invoked[1].toLowerCase() === "rmdir" ? "rmdir" : "rd";
}

function adviseForeignCmdlet(command: string, shell: ShellProfile): CheckResult | undefined {
  if (!/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/.test(command)) {
    return undefined;
  }

  if (shell.kind === "git-bash") {
    const preview = command.match(
      /Get-Content\s+(\S+)\s*\|\s*Select-Object\s+-First\s+(\d+)/i,
    );
    if (preview !== null) {
      return advise(
        shell,
        "当前 shell 是 Git Bash，Get-Content 和 Select-Object 不会执行。",
        `head -n ${preview[2]} ${preview[1]}`,
        true,
      );
    }
    return advise(
      shell,
      "当前 shell 是 Git Bash，不能执行 PowerShell cmdlet。",
      "改用这条 Git Bash 里存在的命令。psguard 不把 cmdlet 翻译回 PowerShell。",
      false,
    );
  }

  if (/Get-ChildItem\s+-Name\b/i.test(command)) {
    return advise(
      shell,
      "当前执行器是 cmd.exe，Get-ChildItem 不会执行。",
      "dir /b",
      true,
    );
  }
  return advise(
    shell,
    "当前执行器是 cmd.exe，不能执行 PowerShell cmdlet。",
    "改用 cmd 的对应命令，例如列出名字用 dir /b。",
    false,
  );
}

function isPowerShell(shell: ShellKind): boolean {
  return shell === "powershell-5.1" || shell === "powershell-7";
}

function allow(shell: ShellProfile, reason: string): CheckResult {
  return { action: "allow", reason, shell };
}

function advise(
  shell: ShellProfile,
  reason: string,
  suggestion: string,
  runnable: boolean,
): CheckResult {
  return { action: "advise", reason, suggestion, runnable, shell };
}

function reject(shell: ShellProfile, reason: string): CheckResult {
  return { action: "reject", reason, shell };
}
