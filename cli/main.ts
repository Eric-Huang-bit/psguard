import { ShellNotFoundError } from "../src/errors.ts";
import { runCommand } from "../src/run.ts";
import { checkCommand } from "../src/check.ts";
import { detectShell, resolveShell } from "../src/shell.ts";
import { SHELL_KINDS, type ShellKind, type ShellProfile } from "../src/types.ts";

const help = `psguard — 在 Windows 上检查并有条件地执行编码 agent 的命令

用法
  psguard check [--shell <shell>] "<command>"
  psguard run [--shell <shell>] "<command>"
  psguard mcp
  psguard install

shell  powershell-5.1 | powershell-7 | cmd | git-bash
       省略时使用 psguard 自己会启动的 PowerShell（真实的 pwsh.exe，否则是 5.1）。
       不读取 IDE 的默认终端设置。

check  只判断，不执行。advise 退出码 2，reject 退出码 3。
run    allow 和可安全改写的命令会执行。退出码是命令自己的退出码；超时是 124。
mcp      启动 stdio MCP 服务。工具名 psguard。
install  说明当前目录里 Cursor、Claude Code 和 Codex 的执行前 hook。
         Cursor / Claude Code 不改名为 Bash 的工具。Codex 在 Windows 上把 shell 也叫 Bash，这个会改写。

能安全改写的命令会在同一次调用里执行。
reject 不执行，也不给出另一条删除命令。
`;

const parsed = parseArgs(process.argv.slice(2));

if (parsed.help || parsed.verb === undefined) {
  process.stdout.write(help);
  process.exit(0);
}

if (parsed.verb === "mcp") {
  await import("../mcp/server.ts");
} else if (parsed.verb === "install") {
  installHooks();
} else {
  await runCli(parsed.verb, parsed.shell, parsed.command);
}

function installHooks(): void {
  process.stdout.write("已准备项目级 hook：.cursor/hooks.json、.claude/settings.json 和 .codex/hooks.json\n");
  process.stdout.write("在这个目录打开 Cursor、Claude Code 或 Codex 后，内置 shell 会先经过 psguard。\n");
  process.stdout.write("Cursor 和 Claude Code 不改名为 Bash 的工具。Codex 在 Windows 上的 shell 工具名叫 Bash，会被改写。\n");
  process.stdout.write("如果 Codex 没有加载 hook，在 config.toml 里确认 [features] hooks = true，并信任这个 hook。\n");
}

async function runCli(verb: string | undefined, shellName: string | undefined, command: string): Promise<void> {
  if (verb !== "check" && verb !== "run") {
    process.stderr.write(help);
    process.exit(1);
  }
  if (command.trim() === "") {
    process.stderr.write("需要一条命令。\n");
    process.exit(1);
  }

  let shell: ShellProfile;
  try {
    shell = shellName === undefined ? detectShell() : resolveShell(parseShell(shellName));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  try {
    if (verb === "check") {
      const result = checkCommand(command, shell);
      writeResult(result, false);
      process.exit(exitCodeFor(result.action, undefined));
    }
    const result = await runCommand(command, { shell: shell.kind });
    writeResult(result, true);
    process.exit(exitCodeFor(result.action, result.executed ? result.exitCode : undefined));
  } catch (error) {
    if (error instanceof ShellNotFoundError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function writeResult(
  result: {
    action: string;
    reason: string;
    suggestion?: string;
    executedCommand?: string;
    shell: ShellProfile;
    executed?: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  },
  ran: boolean,
): void {
  process.stdout.write(`action: ${result.action}\n`);
  process.stdout.write(`shell: ${result.shell.kind}\n`);
  if (result.shell.executable !== undefined) {
    process.stdout.write(`executable: ${result.shell.executable}\n`);
  }
  if (result.shell.version !== undefined) {
    process.stdout.write(`version: ${result.shell.version}\n`);
  }
  process.stdout.write(`reason: ${result.reason}\n`);
  if (result.suggestion !== undefined) {
    process.stdout.write(`suggestion: ${result.suggestion}\n`);
  }
  if (result.executedCommand !== undefined && result.executedCommand !== result.suggestion) {
    process.stdout.write(`executedCommand: ${result.executedCommand}\n`);
  }
  if (!ran) {
    return;
  }
  process.stdout.write(`executed: ${result.executed}\n`);
  if (result.exitCode !== undefined) {
    process.stdout.write(`exitCode: ${result.exitCode}\n`);
  }
  process.stdout.write("--- stdout\n");
  process.stdout.write(result.stdout ?? "");
  if (result.stdout !== undefined && !result.stdout.endsWith("\n") && result.stdout !== "") {
    process.stdout.write("\n");
  }
  process.stdout.write("--- stderr\n");
  process.stdout.write(result.stderr ?? "");
  if (result.stderr !== undefined && !result.stderr.endsWith("\n") && result.stderr !== "") {
    process.stdout.write("\n");
  }
}

function exitCodeFor(action: string, commandExit: number | undefined): number {
  if (action === "advise") {
    return 2;
  }
  if (action === "reject") {
    return 3;
  }
  return commandExit ?? 0;
}

function parseShell(value: string): ShellKind {
  if (SHELL_KINDS.includes(value as ShellKind)) {
    return value as ShellKind;
  }
  throw new ShellNotFoundError(`未知 shell ${value}。可选：${SHELL_KINDS.join("、")}。`);
}

function parseArgs(argv: string[]): {
  help: boolean;
  verb?: string;
  shell?: string;
  command: string;
} {
  let verb: string | undefined;
  let shell: string | undefined;
  let help = false;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--shell") {
      shell = argv[index + 1];
      index += 1;
      continue;
    }
    if (verb === undefined && (arg === "check" || arg === "run" || arg === "mcp" || arg === "install")) {
      verb = arg;
      continue;
    }
    rest.push(arg);
  }

  return { help, verb, shell, command: rest.join(" ") };
}
