import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { ShellNotFoundError } from "./errors.ts";
import type { ShellKind, ShellProfile } from "./types.ts";

const probed = new Map<string, { version?: string; codePage: number }>();
let detected: ShellProfile | undefined;

export function resetShellCache(): void {
  probed.clear();
  detected = undefined;
}

/** Skip 0-byte files and WindowsApps execution aliases. */
export function isUsableExecutable(filePath: string): boolean {
  if (filePath.toLowerCase().includes("\\windowsapps\\")) {
    return false;
  }
  try {
    const stat = statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** The PowerShell executable psguard itself will spawn. */
export function detectShell(): ShellProfile {
  if (detected !== undefined) {
    return detected;
  }
  const pwsh = findPwsh();
  if (pwsh !== undefined) {
    try {
      detected = finish(pwsh, "powershell-7");
      return detected;
    } catch {
      // A listed pwsh that cannot start falls through to Windows PowerShell 5.1.
    }
  }
  detected = finish(systemPowerShell(), "powershell-5.1");
  return detected;
}

export function resolveShell(kind: ShellKind): ShellProfile {
  if (kind === "powershell-7") {
    const pwsh = findPwsh();
    if (pwsh === undefined) {
      throw new ShellNotFoundError("没有可用的 pwsh.exe。已跳过 WindowsApps 别名和 0 字节文件。");
    }
    return finish(pwsh, "powershell-7");
  }
  if (kind === "powershell-5.1") {
    return finish(systemPowerShell(), "powershell-5.1");
  }
  if (kind === "cmd") {
    return finish(systemCmd(), "cmd");
  }
  const bash = findBash();
  if (bash === undefined) {
    throw new ShellNotFoundError("没有找到 Git Bash。");
  }
  return finish(bash, "git-bash");
}

function finish(executable: string, kind: ShellKind): ShellProfile {
  const info = probe(executable, kind);
  return {
    kind,
    executable,
    version: info.version,
    codePage: info.codePage,
  };
}

function probe(executable: string, kind: ShellKind): { version?: string; codePage: number } {
  const cached = probed.get(executable);
  if (cached !== undefined) {
    return cached;
  }
  const info = kind === "cmd"
    ? probeCmd(executable)
    : kind === "git-bash"
      ? { codePage: 65001 }
      : probePowerShell(executable);
  probed.set(executable, info);
  return info;
}

function probePowerShell(executable: string): { version?: string; codePage: number } {
  const script = [
    "Write-Output $PSVersionTable.PSVersion.ToString()",
    "Write-Output ([Console]::OutputEncoding.CodePage)",
  ].join("; ");
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, encoding: "utf8", timeout: 15000 },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new ShellNotFoundError(`无法启动 ${executable}`);
  }
  const lines = (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const version = lines[0];
  const codePage = Number(lines[1]);
  return { version, codePage: Number.isInteger(codePage) ? codePage : 65001 };
}

function probeCmd(executable: string): { codePage: number } {
  const result = spawnSync(executable, ["/d", "/c", "chcp"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10000,
  });
  const match = (result.stdout ?? "").match(/(\d+)\s*$/);
  const codePage = match === null ? 65001 : Number(match[1]);
  return { codePage };
}

function systemPowerShell(): string {
  const executable = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (!isUsableExecutable(executable)) {
    throw new ShellNotFoundError("没有找到 Windows PowerShell 5.1。");
  }
  return executable;
}

function systemCmd(): string {
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  if (!isUsableExecutable(executable)) {
    throw new ShellNotFoundError("没有找到 cmd.exe。");
  }
  return executable;
}

function findPwsh(): string | undefined {
  const candidates: string[] = [];
  const standard = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  if (isUsableExecutable(standard)) {
    candidates.push(standard);
  }
  for (const line of whereLines("pwsh")) {
    if (isUsableExecutable(line) && !candidates.includes(line)) {
      candidates.push(line);
    }
  }
  return candidates[0];
}

function findBash(): string | undefined {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(path.join(root, "Git", "bin", "bash.exe"));
  }
  for (const git of whereLines("git")) {
    candidates.push(path.resolve(path.dirname(git), "..", "bin", "bash.exe"));
  }
  return candidates.find((candidate) => isUsableExecutable(candidate));
}

function whereLines(name: string): string[] {
  const result = spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0 || result.stdout === undefined) {
    return [];
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
