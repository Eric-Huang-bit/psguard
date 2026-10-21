/**
 * MCP tool contract. `shell` defaults to the PowerShell executable psguard
 * will spawn. That is not the IDE terminal profile.
 */
export const psguardTool = {
  name: "psguard",
  description:
    "Run a command on Windows. Common PowerShell mismatches (&&, head, grep, ls -la, curl -fsSL, export, rm -rf of one folder) are rewritten and executed in this same call. Success is executed true and exitCode 0. action reject was not executed; do not rewrite it into another delete.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "The exact command to check and maybe run.",
      },
      shell: {
        type: "string",
        enum: ["powershell-5.1", "powershell-7", "cmd", "git-bash"],
        description:
          "Optional. Omit to use the PowerShell psguard will spawn. Pass cmd or git-bash only when that is the real executor.",
      },
      execute: {
        type: "boolean",
        description: "Default true. When false, only check.",
      },
    },
  },
} as const;

export interface PsguardToolResult {
  action: "allow" | "advise" | "reject";
  reason: string;
  suggestion?: string;
  shell: string;
  /** Set only when action is allow and the command was executed. */
  exitCode?: number;
}
