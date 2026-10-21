# 测试语料格式

`cases.json` 是检查器的规格。规则实现之后，行为测试应逐条对照这里的 `action`，并去掉 `behavior.test.ts` 里的 skip。

每条用例是一条公开失败的代表命令，或一条必须不被误伤的对照。路径一律用 `C:\example` 或 `D:\example`。语料测试只读取字符串，不把 `command` 交给 shell。

## 文件

```json
{
  "version": 1,
  "cases": []
}
```

## 字段

| 字段 | 要求 |
| --- | --- |
| `id` | 小写英文、数字、连字符。文件内唯一 |
| `shell` | `powershell-5.1`、`powershell-7`、`cmd`、`git-bash` 之一。指实际执行的 shell |
| `command` | 原始命令文本 |
| `action` | `allow`、`advise`、`reject` |
| `tag` | 见下方标签 |
| `summary` | 一行英文，说明期望 |
| `detail` | 中文说明。advise 写明建议方向，reject 写明为什么不能改写 |
| `execute` | 必须是 `false` |
| `source.name` | 来源简称 |
| `source.url` | `https://` 开头的公开链接 |

## 动作

- `allow`：命令和该 shell 匹配，或者它不属于本检查器要拦的类。
- `advise`：方言不匹配。返回一句可执行的改写建议，不自动执行，也不把 `&&` 换成总会继续的 `;`。
- `reject`：只留给毁坏性引号。`cmd /c` 或 `cmd /c` 等价形式里出现 `rmdir` 或 `rd` 的 `/s`，并且路径用 `\"` 包裹。检查器拒绝，不改写，不执行。

`echo rmdir ...` 是公开讨论里的安全复现，动作是 `allow`。`Remove-Item -LiteralPath` 是正常的 PowerShell 删除，动作是 `allow`。这两种都不能被拒绝规则误伤。

## 标签

- `chain-operator`：`&&`、`||`
- `unix-tool`：`head`、`tail`、`grep`、`sed`、`awk`、`find`、heredoc
- `alias-clash`：PowerShell 别名和 Unix 参数撞车，如 `ls -la`、`curl -fsSL`
- `env-syntax`：`export`、`$VAR` 与 `$env:VAR`
- `dialect-mismatch`：cmdlet 发到 bash/cmd，或反过来
- `destructive-quoting`：拒绝类
- `safe-contrast`：必须放行的对照

## 不做什么

不在语料里记录真实用户路径。不把整段事故命令原样复制进来。不为完整 bash 翻译补用例，那是别的项目的范围。
