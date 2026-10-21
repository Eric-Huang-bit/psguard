export { checkCommand } from "./check.ts";
export { decodeOutput } from "./decode.ts";
export { ShellNotFoundError } from "./errors.ts";
export { runCommand } from "./run.ts";
export type { Captured, RunOptions, RunResult } from "./run.ts";
export { detectShell, isUsableExecutable, resetShellCache, resolveShell } from "./shell.ts";
export type { CheckAction, CheckResult, ShellKind, ShellProfile } from "./types.ts";
export { CHECK_ACTIONS, SHELL_KINDS } from "./types.ts";
