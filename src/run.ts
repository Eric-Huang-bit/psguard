import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand } from "./check.ts";
import { decodeOutput } from "./decode.ts";
import { ShellNotFoundError } from "./errors.ts";
import { detectShell, resolveShell } from "./shell.ts";
import type { CheckAction, ShellKind, ShellProfile } from "./types.ts";

const EXIT_WRAPPER = [
  "if (-not $?) {",
  "  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  "  exit 1",
  "}",
  "exit 0",
].join("\r\n");

export interface RunResult extends CheckResult {
  action: CheckAction | "rewritten";
  executed: boolean;
  /** The command that actually ran, after a safe rewrite. */
  executedCommand?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface RunOptions {
  shell?: ShellKind;
  timeoutMs?: number;
  /** When false, stop after the check. Default is true. */
  execute?: boolean;
  /** Test hook. Replaces process spawn. */
  runner?: (command: string, shell: ShellProfile) => Promise<Captured>;
}

export interface Captured {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(command: string, options: RunOptions = {}): Promise<RunResult> {
  const shell = options.shell === undefined ? detectShell() : resolveShell(options.shell);
  const verdict = checkCommand(command, shell);
  if (command.trim() === "") {
    return { ...verdict, shell, executed: false };
  }
  const rewritten = verdict.action === "advise" && verdict.runnable === true && verdict.suggestion !== undefined;
  if (verdict.action === "reject" || options.execute === false || (verdict.action === "advise" && !rewritten)) {
    return { ...verdict, shell, executed: false };
  }
  const toRun = rewritten ? verdict.suggestion ?? command : command;
  const captured = options.runner === undefined
    ? await executeAllowed(toRun, shell, options.timeoutMs)
    : await options.runner(toRun, shell);
  return {
    ...verdict,
    action: rewritten ? "rewritten" : verdict.action,
    shell,
    executed: true,
    executedCommand: toRun,
    ...captured,
  };
}

async function executeAllowed(
  command: string,
  shell: ShellProfile,
  timeoutMs?: number,
): Promise<Captured> {
  const executable = shell.executable;
  if (executable === undefined) {
    throw new ShellNotFoundError("shell 没有可执行文件路径。");
  }
  if (shell.kind === "powershell-5.1" || shell.kind === "powershell-7") {
    return runPowerShell(executable, command, shell.codePage ?? 65001, timeoutMs);
  }
  if (shell.kind === "cmd") {
    return runArgs(executable, ["/d", "/c", command], shell.codePage ?? 65001, timeoutMs);
  }
  return runArgs(executable, ["-c", command], shell.codePage ?? 65001, timeoutMs);
}

async function runPowerShell(
  executable: string,
  command: string,
  codePage: number,
  timeoutMs?: number,
): Promise<Captured> {
  const file = path.join(os.tmpdir(), `psguard-${randomBytes(8).toString("hex")}.ps1`);
  const script = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(`${command}\r\n${EXIT_WRAPPER}\r\n`, "utf8"),
  ]);
  writeFileSync(file, script);
  try {
    return await runArgs(
      executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      codePage,
      timeoutMs,
    );
  } finally {
    try {
      unlinkSync(file);
    } catch {
      // The temp script is already gone.
    }
  }
}

function runArgs(
  executable: string,
  args: string[],
  codePage: number,
  timeoutMs?: number,
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      const errText = decodeOutput(Buffer.concat(stderr), codePage);
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout: decodeOutput(Buffer.concat(stdout), codePage),
        stderr: timedOut ? `${errText}${errText.endsWith("\n") || errText === "" ? "" : "\n"}psguard: timed out\n` : errText,
      });
    });
  });
}
