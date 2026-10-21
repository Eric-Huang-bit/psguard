import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORPUS_SHELLS = [
  "powershell-5.1",
  "powershell-7",
  "cmd",
  "git-bash",
] as const;

export const CORPUS_ACTIONS = ["allow", "advise", "reject"] as const;

export const CORPUS_TAGS = [
  "chain-operator",
  "unix-tool",
  "alias-clash",
  "env-syntax",
  "dialect-mismatch",
  "destructive-quoting",
  "safe-contrast",
] as const;

export interface CorpusSource {
  name: string;
  url: string;
}

export interface CorpusCase {
  id: string;
  shell: (typeof CORPUS_SHELLS)[number];
  command: string;
  action: (typeof CORPUS_ACTIONS)[number];
  tag: (typeof CORPUS_TAGS)[number];
  summary: string;
  detail: string;
  execute: false;
  source: CorpusSource;
}

export interface CorpusFile {
  version: 1;
  cases: CorpusCase[];
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function loadCorpus(): CorpusFile {
  const path = join(dirname(fileURLToPath(import.meta.url)), "cases.json");
  return JSON.parse(readFileSync(path, "utf8")) as CorpusFile;
}

export function validateCorpus(file: CorpusFile): string[] {
  const errors: string[] = [];
  if (file.version !== 1) {
    errors.push("version 必须是 1");
  }
  if (!Array.isArray(file.cases) || file.cases.length < 20) {
    errors.push("cases 至少 20 条");
    return errors;
  }

  const seen = new Set<string>();
  for (const item of file.cases) {
    const at = item.id || "(missing id)";
    if (!ID_PATTERN.test(item.id ?? "")) {
      errors.push(`${at}: id 须为小写英文连字符`);
    }
    if (seen.has(item.id)) {
      errors.push(`${at}: id 重复`);
    }
    seen.add(item.id);
    if (!CORPUS_SHELLS.includes(item.shell)) {
      errors.push(`${at}: shell 不在允许列表`);
    }
    if (!CORPUS_ACTIONS.includes(item.action)) {
      errors.push(`${at}: action 不在允许列表`);
    }
    if (!CORPUS_TAGS.includes(item.tag)) {
      errors.push(`${at}: tag 不在允许列表`);
    }
    if (typeof item.command !== "string" || item.command.trim() === "") {
      errors.push(`${at}: command 为空`);
    }
    if (typeof item.summary !== "string" || item.summary.trim() === "") {
      errors.push(`${at}: summary 为空`);
    }
    if (typeof item.detail !== "string" || item.detail.trim() === "") {
      errors.push(`${at}: detail 为空`);
    }
    if (item.execute !== false) {
      errors.push(`${at}: execute 必须是 false`);
    }
    if (!item.source?.url?.startsWith("https://")) {
      errors.push(`${at}: source.url 必须以 https:// 开头`);
    }
    if (typeof item.source?.name !== "string" || item.source.name.trim() === "") {
      errors.push(`${at}: source.name 为空`);
    }
    if (item.action === "reject" && item.tag !== "destructive-quoting") {
      errors.push(`${at}: reject 只能用于 destructive-quoting`);
    }
    if (item.tag === "destructive-quoting" && item.action !== "reject") {
      errors.push(`${at}: destructive-quoting 的 action 必须是 reject`);
    }
  }
  return errors;
}
