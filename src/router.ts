// 命令解析（纯函数）。T4 只区分「跑任务」与「未知命令」；T5 补全控制命令。

export type ParsedInput =
  | { kind: "run"; text: string }
  | { kind: "unknown-command"; command: string };

const COMMAND_PATTERN = /^\/([a-zA-Z][\w-]*)\s*(.*)$/s;

/** 解析一条用户输入：以 / 开头且形如命令的视为命令，其余都是 Run 输入。 */
export function parseInput(text: string): ParsedInput {
  const trimmed = text.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (match === null) return { kind: "run", text: trimmed };
  return { kind: "unknown-command", command: match[1] ?? "" };
}
