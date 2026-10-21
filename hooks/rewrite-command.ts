import { checkCommand } from "../src/check.ts";

const host = readHost(process.argv);
const raw = await readStdin();
if (raw.trim() === "") {
  process.stdout.write("{}\n");
  process.exit(0);
}

let message: {
  tool_name?: string;
  tool_input?: { command?: string };
  command?: string;
};
try {
  message = JSON.parse(raw) as typeof message;
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const toolName = message.tool_name ?? "";
if (isBashTool(toolName, host) || !isShellTool(toolName, message, host)) {
  process.stdout.write(host === "cursor" ? "{\"continue\":true}\n" : "{}\n");
  process.exit(0);
}

const command = message.tool_input?.command ?? message.command;
if (typeof command !== "string" || command.trim() === "") {
  process.stdout.write(host === "cursor" ? "{\"continue\":true}\n" : "{}\n");
  process.exit(0);
}

const verdict = checkCommand(command, { kind: "powershell-5.1" });
if (verdict.action === "allow") {
  process.stdout.write(host === "cursor" ? "{\"continue\":true}\n" : "{}\n");
  process.exit(0);
}

if (verdict.action === "advise" && verdict.runnable === true && verdict.suggestion !== undefined) {
  const updated = { ...(message.tool_input ?? {}), command: verdict.suggestion };
  if (host === "cursor") {
    process.stdout.write(`${JSON.stringify({
      continue: true,
      permission: "allow",
      updated_input: updated,
    })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: host === "codex" ? { command: verdict.suggestion } : updated,
      },
    })}\n`);
  }
  process.exit(0);
}

const reason = verdict.reason;
if (host === "cursor") {
  process.stdout.write(`${JSON.stringify({
    continue: false,
    permission: "deny",
    agent_message: reason,
  })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}
process.exit(0);

function isBashTool(name: string, host: Host): boolean {
  return host !== "codex" && name.toLowerCase() === "bash";
}

function isShellTool(
  name: string,
  message: { command?: string; tool_input?: { command?: string } },
  host: Host,
): boolean {
  const normalized = name.toLowerCase();
  if (normalized === "" && (message.command !== undefined || message.tool_input?.command !== undefined)) {
    return true;
  }
  const names = ["shell", "powershell", "run_terminal_cmd", "local_shell", "exec_command"];
  if (host === "codex") {
    names.push("bash");
  }
  return names.includes(normalized);
}

function readHost(argv: string[]): Host {
  const index = argv.indexOf("--host");
  if (argv[index + 1] === "cursor") {
    return "cursor";
  }
  if (argv[index + 1] === "codex") {
    return "codex";
  }
  return "claude";
}

type Host = "claude" | "cursor" | "codex";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}
