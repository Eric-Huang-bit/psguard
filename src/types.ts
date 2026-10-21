export const SHELL_KINDS = [
  "powershell-5.1",
  "powershell-7",
  "cmd",
  "git-bash",
] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

/** The shell that will actually execute the command, not the user's IDE setting. */
export interface ShellProfile {
  kind: ShellKind;
  executable?: string;
  version?: string;
  /** Console output code page of this executable. Used to decode pipes. */
  codePage?: number;
}

export const CHECK_ACTIONS = ["allow", "advise", "reject"] as const;

export type CheckAction = (typeof CHECK_ACTIONS)[number];

export interface CheckResult {
  action: CheckAction;
  /** One short reason an agent can read on the next turn. */
  reason: string;
  /** Present when action is "advise". */
  suggestion?: string;
  /** The suggestion is a complete command psguard may run immediately. */
  runnable?: boolean;
  shell: ShellProfile;
}
