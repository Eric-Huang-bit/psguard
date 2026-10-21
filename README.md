# psguard

[English](README.en.md)

psguard 让编码 agent 在 Windows 上发命令时，先对照实际会执行的 shell 做检查。能安全改写的写法会在同一次调用里改完并执行；会删到盘符或系统目录的命令直接拒绝。

需要 Node.js 22.18 或更新版本。没有第三方依赖。

## 命令

```powershell
node cli/main.ts check "cd server && npm install"
node cli/main.ts run "Write-Output one && Write-Output two"
node cli/main.ts mcp
node cli/main.ts install
```

| 命令 | 行为 |
| --- | --- |
| `check` | 只判断，不执行 |
| `run` | `allow`，以及可以安全改写的命令，会真正执行 |
| `mcp` | 启动 stdio MCP 服务，工具名是 `psguard` |
| `install` | 说明如何让当前目录的 Cursor / Claude Code hook 生效 |

省略 `--shell` 时，用 psguard 自己会启动的 PowerShell：优先真实的 `pwsh.exe`，否则是 Windows PowerShell 5.1。`WindowsApps` 目录和 0 字节文件会跳过。这不是 IDE 里设置的默认终端。

`--shell` 可以是 `powershell-5.1`、`powershell-7`、`cmd` 或 `git-bash`。没有可用的 `pwsh.exe` 时，`powershell-7` 会直接失败。

退出码：`check` 在建议时是 2，拒绝时是 3。`run` 使用命令自己的退出码；建议但不能执行是 2，拒绝是 3，超时是 124。

## 同一次调用里会改写并执行

这些改写保持「失败就停」，不会把 `&&` 换成总会继续的分号。

- PowerShell 5.1 的 `&&` 和 `||`
- `head`、`tail`、`grep`、`wc -l`、按行截取的 `sed` 和 `awk`、`find -name`
- `mkdir -p`、`touch`、`cp`、`mv`、`which`、`basename`、`dirname`、`cat -n`、`tee`、`uniq`、`echo -n`
- `ls -la`，以及 PowerShell 5.1 上的 `curl -fsSL`
- `export`、`set NAME=value`、行首的 `NAME=value`、`$USERPROFILE` 这类环境变量
- Bash 风格的 `\"`。`echo rmdir ...` 这种安全复现不会被改写
- 带完整正文的 `python` / `node` heredoc
- 指向具体子目录的 `rm -rf`
- 能对应起来的 cmdlet：Git Bash 上的 `Get-Content | Select-Object -First`，cmd 上的 `Get-ChildItem -Name`

PowerShell 7 上的 `&&` 保持原样。`curl -fsSL` 也只在 5.1 上改成 `curl.exe`。

## 会拒绝并且不执行

- `cmd /c` 里用 `\"` 包住路径的 `rmdir /s` 或 `rd /s`。PowerShell 不把 `\"` 当转义，目标可能变成盘符根
- `rm -rf`、`rmdir /s`、`rd /s`、`Remove-Item -Recurse` 指向盘符根、`*`、`.`、`..`
- 上述删除指向 `Windows`、`Program Files`、`Program Files (x86)`、`ProgramData`、`PerfLogs`，或正好指向 `C:\Users`、某个用户目录根

具体子目录上的普通 `Remove-Item -LiteralPath` 会放行。拒绝结果里没有另一条删除命令。

下面这些只返回说明，不执行：没有正文的 heredoc、正文里出现 `'@` 的 heredoc、`tail -f`、复杂的 `sed` / `awk` / `grep -P`。

## 不覆盖的范围

- 不翻译完整 bash，也不模拟 GNU coreutils。那是 [fauxnix](https://github.com/20000419/fauxnix) 的范围。
- 不提供持久 PowerShell 会话。那是 [PowerShell.MCP](https://github.com/yotsuda/PowerShell.MCP) 和 [ripple](https://github.com/yotsuda/ripple) 的范围。
- 不读取 IDE 的默认终端。Cursor 和 Claude Code 里名为 Bash 的工具不改写。Codex 在 Windows 上的 shell 工具名叫 Bash，会改写。
- 不靠提示词提醒模型。内置 Shell / PowerShell 只有接了本仓库的 hook 才会先经过 psguard。

## 接到 agent

仓库里已经带了 hook：

- `.cursor/hooks.json` 拦截 Cursor 的 `Shell` 和 `beforeShellExecution`
- `.claude/settings.json` 拦截 Claude Code 的 `PowerShell` 和 `Shell`
- `.codex/hooks.json` 拦截 Codex 的 `Bash`。Codex 把 Windows 上的 shell 命令也标成 `Bash`，统一执行入口 `exec_command` 同样匹配这条规则

在这个目录打开对应工具后，这些 hook 会在命令执行前改写。Cursor 和 Claude Code 里名为 Bash 的工具保持原样。Codex 如果没有加载 hook，在 `config.toml` 里确认 `[features] hooks = true`，并在 Codex 里信任这个 hook。

MCP 也可以单独接。把路径换成这台机器上的 `cli/main.ts`。Node 会直接运行 TypeScript。

Claude Code：

```powershell
claude mcp add psguard -- node C:\path\to\psguard\cli\main.ts mcp
```

Cursor 的 `mcp.json`：

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

Codex 的 `config.toml`：

```toml
[mcp_servers.psguard]
command = "node"
args = ["C:\\path\\to\\psguard\\cli\\main.ts", "mcp"]
```

MCP 入参是 `command`。`shell` 和 `execute` 可以省略，`execute` 默认是 true。返回 JSON，包含 `action`、`reason`、`executed`。改写过的调用还有 `suggestion` 和 `executedCommand`。真正执行之后才有 `exitCode`、`stdout`、`stderr`。

`executed` 为 true 且 `exitCode` 为 0，就是这一次已经通过。`reject`，以及不能安全执行的 `advise`，`isError` 为 true。

## 布局

```text
src/check.ts          判断 allow、advise、reject，不启动进程
src/rewrite.ts        把常见写法改成当前 shell 能跑的命令
src/run.ts            执行 allow 和可安全改写的命令，保留退出码
src/shell.ts          选择并探测实际会启动的 shell
cli/main.ts           check、run、mcp、install
mcp/server.ts         stdio MCP
hooks/rewrite-command.ts
  Cursor 和 Claude Code 的执行前改写
tests/                语料、执行、hook、安全和 MCP
```

问题从哪来，写在 [`前期调研.md`](前期调研.md)。语料格式写在 [`tests/corpus/FORMAT.md`](tests/corpus/FORMAT.md)。

## 开发

```powershell
npm test
```

测试使用 `C:\example`、`D:\example` 和临时目录。拒绝类命令只交给替身执行器，不会真正删除文件。

## 安全

放行的 PowerShell 命令在新进程里执行，使用 `-NoProfile` 和 `-ExecutionPolicy Bypass`。psguard 不提权，也不读取交互输入。

## 许可证

MIT。
