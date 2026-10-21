# psguard

[中文](README.md)

psguard checks a coding agent's command against the shell that will actually run it on Windows. Rewrites that are safe to apply run in the same call. Commands that can delete a drive root or a system directory are refused.

Node.js 22.18 or newer is required. There are no third-party dependencies.

## Commands

```powershell
node cli/main.ts check "cd server && npm install"
node cli/main.ts run "Write-Output one && Write-Output two"
node cli/main.ts mcp
node cli/main.ts install
```

| Command | Behavior |
| --- | --- |
| `check` | Judge only. Nothing is executed |
| `run` | Executes `allow`, and rewrites that are safe to run |
| `mcp` | Starts the stdio MCP server. The tool name is `psguard` |
| `install` | Prints how the Cursor and Claude Code hooks in this directory take effect |

When `--shell` is omitted, psguard uses the PowerShell executable it will spawn: a real `pwsh.exe` when one exists, otherwise Windows PowerShell 5.1. Paths under `WindowsApps` and 0-byte files are skipped. This is not the IDE's default terminal profile.

`--shell` accepts `powershell-5.1`, `powershell-7`, `cmd`, or `git-bash`. `powershell-7` fails immediately when no usable `pwsh.exe` exists.

Exit codes: `check` returns 2 for advise and 3 for reject. `run` returns the command's own exit code. A non-runnable advise is 2, reject is 3, and a timeout is 124.

## Rewritten and executed in one call

These rewrites stop when an earlier command fails. `&&` is not replaced with a semicolon that always continues.

- `&&` and `||` on PowerShell 5.1
- `head`, `tail`, `grep`, `wc -l`, line-range `sed` and `awk`, and `find -name`
- `mkdir -p`, `touch`, `cp`, `mv`, `which`, `basename`, `dirname`, `cat -n`, `tee`, `uniq`, and `echo -n`
- `ls -la`, and `curl -fsSL` on PowerShell 5.1
- `export`, `set NAME=value`, a leading `NAME=value`, and environment names such as `$USERPROFILE`
- Bash-style `\"`. The safe `echo rmdir ...` reproduction is left unchanged
- A `python` or `node` heredoc that includes its full body
- `rm -rf` of one specific subdirectory
- Cmdlets that have a direct equivalent: `Get-Content | Select-Object -First` on Git Bash, and `Get-ChildItem -Name` on cmd

`&&` stays as written on PowerShell 7. `curl -fsSL` is rewritten to `curl.exe` only on PowerShell 5.1.

## Refused and not executed

- `rmdir /s` or `rd /s` inside `cmd /c` when the path is wrapped in `\"`. PowerShell does not treat `\"` as an escape, so the target can collapse to the drive root
- `rm -rf`, `rmdir /s`, `rd /s`, and `Remove-Item -Recurse` aimed at a drive root, `*`, `.`, or `..`
- The same deletes aimed at `Windows`, `Program Files`, `Program Files (x86)`, `ProgramData`, `PerfLogs`, exactly `C:\Users`, or exactly a user-profile root

An ordinary `Remove-Item -LiteralPath` of a specific subdirectory is allowed. A reject result does not include a rewritten delete command.

These return an explanation and are not executed: a heredoc with no body, a heredoc whose body contains `'@`, `tail -f`, and complex `sed`, `awk`, or `grep -P`.

## Out of scope

- psguard does not translate all of bash and does not emulate GNU coreutils. That is what [fauxnix](https://github.com/20000419/fauxnix) does.
- psguard does not host a persistent PowerShell session. That is what [PowerShell.MCP](https://github.com/yotsuda/PowerShell.MCP) and [ripple](https://github.com/yotsuda/ripple) do.
- psguard does not read the IDE's default terminal. A tool named Bash in Cursor or Claude Code is not rewritten. Codex names its Windows shell tool Bash, and that call is rewritten.
- Prompt rules are not the mechanism. A built-in Shell or PowerShell tool passes through psguard only when this repository's hook is active.

## Use it with an agent

Hooks are already in the repository:

- `.cursor/hooks.json` covers Cursor `Shell` and `beforeShellExecution`
- `.claude/settings.json` covers Claude Code `PowerShell` and `Shell`
- `.codex/hooks.json` covers Codex `Bash`. On Windows, Codex labels its shell commands `Bash`, and unified `exec_command` matches that same rule

Open this directory in the matching tool and those hooks rewrite commands before they run. A tool named Bash in Cursor or Claude Code is left unchanged. If Codex does not load the hook, set `[features] hooks = true` in `config.toml` and trust the hook in Codex.

MCP can be connected on its own. Replace the path with `cli/main.ts` on this machine. Node runs the TypeScript entry directly.

Claude Code:

```powershell
claude mcp add psguard -- node C:\path\to\psguard\cli\main.ts mcp
```

Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "psguard": {
      "command": "node",
      "args": ["C:\\path\\to\\psguard\\cli\\main.ts", "mcp"]
    }
  }
}
```

Codex `config.toml`:

```toml
[mcp_servers.psguard]
command = "node"
args = ["C:\\path\\to\\psguard\\cli\\main.ts", "mcp"]
```

The MCP argument is `command`. `shell` and `execute` may be omitted. `execute` defaults to true. The tool returns JSON with `action`, `reason`, and `executed`. A rewrite also includes `suggestion` and `executedCommand`. `exitCode`, `stdout`, and `stderr` are present only after a command runs.

`executed: true` and `exitCode: 0` means the call finished. `isError` is true for `reject`, and for an `advise` that is not safe to run.

## Layout

```text
src/check.ts          allow, advise, and reject, without spawning
src/rewrite.ts        rewrites common commands for the current shell
src/run.ts            runs allow and safe rewrites, and keeps the exit code
src/shell.ts          selects and probes the shell that will actually start
cli/main.ts           check, run, mcp, install
mcp/server.ts         stdio MCP
hooks/rewrite-command.ts
  pre-execution rewrite for Cursor and Claude Code
tests/                corpus, execution, hooks, safety, and MCP
```

The background for the project is in [`前期调研.md`](前期调研.md), in Chinese. The corpus format is in [`tests/corpus/FORMAT.md`](tests/corpus/FORMAT.md).

## Development

```powershell
npm test
```

Tests use `C:\example`, `D:\example`, and temporary directories. Rejected commands are handed to a stand-in runner and do not delete files.

## Safety

Allowed PowerShell commands run in a new process with `-NoProfile` and `-ExecutionPolicy Bypass`. psguard does not raise privileges and does not read interactive input.

## License

MIT.
