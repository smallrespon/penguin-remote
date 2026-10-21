// 命令路由器：纯函数解析。不碰 IO，全部行为可离线单测。

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 命令清单：帮助文本的唯一事实来源。 */
const COMMANDS: ReadonlyArray<{ usage: string; summary: string }> = [
  { usage: "/new", summary: "新开会话（上下文干净）" },
  { usage: "/sessions", summary: "列出本聊天最近用过的会话" },
  { usage: "/use <序号>", summary: "切回某个旧会话续聊" },
  { usage: "/project", summary: "列出 / 切换 Project（`/project <名字>`）" },
  { usage: "/agent", summary: "列出 / 切换 Agent（`/agent <名字>`）" },
  { usage: "/model <名字>", summary: "切换模型（`/model` 列出可用模型）" },
  { usage: "/thinking low|medium|high|xhigh|max", summary: "切换思考档位" },
  { usage: "/workspace <路径>", summary: "切换工作区" },
  { usage: "/skill <名字>", summary: "一次性使用 Skill；`/skill <名字> on` 粘滞；`/skill off` 关闭" },
  { usage: "/status", summary: "当前绑定与会话状态" },
  { usage: "/stop", summary: "中断正在执行的任务" },
];

export type Command =
  | { kind: "help" }
  | { kind: "new" }
  | { kind: "sessions" }
  | { kind: "use"; index: number }
  | { kind: "project" }
  | { kind: "project.select"; name: string }
  | { kind: "agent" }
  | { kind: "agent.select"; name: string }
  | { kind: "model" }
  | { kind: "model.select"; name: string }
  | { kind: "thinking"; level: ThinkingLevel }
  | { kind: "workspace"; path: string }
  | { kind: "skill"; name: string | null; mode: "once" | "on" | "off" }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "invalid"; command: string; reason: string }
  | { kind: "unknown"; command: string }
  | { kind: "run"; text: string };

const COMMAND_PATTERN = /^\/([a-zA-Z][\w-]*)[ \t]*(.*)$/s;

/** 解析一条用户输入为命令或 Run 输入。 */
export function parseCommand(text: string): Command {
  const trimmed = text.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (match === null) return { kind: "run", text: trimmed };
  const name = (match[1] ?? "").toLowerCase();
  const rest = (match[2] ?? "").trim();

  switch (name) {
    case "help":
      return { kind: "help" };
    case "new":
      return { kind: "new" };
    case "sessions":
      return { kind: "sessions" };
    case "use": {
      const index = Number(rest);
      if (!Number.isInteger(index) || index < 1) {
        return { kind: "invalid", command: "use", reason: "用法：`/use <序号>`，序号见 `/sessions`" };
      }
      return { kind: "use", index };
    }
    case "project":
      return rest === "" ? { kind: "project" } : { kind: "project.select", name: rest };
    case "agent":
      return rest === "" ? { kind: "agent" } : { kind: "agent.select", name: rest };
    case "model":
      return rest === "" ? { kind: "model" } : { kind: "model.select", name: rest };
    case "thinking": {
      const level = rest.toLowerCase();
      if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
        return {
          kind: "invalid",
          command: "thinking",
          reason: `用法：\`/thinking ${THINKING_LEVELS.join("|")}\``,
        };
      }
      return { kind: "thinking", level: level as ThinkingLevel };
    }
    case "workspace":
      if (rest === "") return { kind: "invalid", command: "workspace", reason: "用法：`/workspace <路径>`" };
      return { kind: "workspace", path: rest };
    case "skill": {
      if (rest.toLowerCase() === "off") return { kind: "skill", name: null, mode: "off" };
      const parts = rest.split(/\s+/);
      const skillName = parts[0] ?? "";
      if (skillName === "") {
        return { kind: "invalid", command: "skill", reason: "用法：`/skill <名字> [on|off]`" };
      }
      if (parts.length > 1 && parts[1]?.toLowerCase() === "on") {
        return { kind: "skill", name: skillName, mode: "on" };
      }
      if (parts.length > 1) {
        return { kind: "invalid", command: "skill", reason: "用法：`/skill <名字>` 或 `/skill <名字> on`" };
      }
      return { kind: "skill", name: skillName, mode: "once" };
    }
    case "status":
      return { kind: "status" };
    case "stop":
      return { kind: "stop" };
    default:
      return { kind: "unknown", command: name };
  }
}

/** Skill 提示词注入：Bridge 不传输 skill 内容，只在 input 前加一句指令。 */
export function formatSkillInput(skill: string, text: string): string {
  return `请使用 skill「${skill}」完成以下任务：${text}`;
}

/** 帮助文本；常驻一句风险提示（ADR-0004）。 */
export function helpText(): string {
  const lines = ["**命令列表**", ...COMMANDS.map((c) => `- \`${c.usage}\` ${c.summary}`)];
  lines.push(
    "",
    "不带命令的文本会直接派给 Agent 执行。",
    "",
    "⚠️ 风险提示：任何能给这个机器人发消息的人，都能全权限驱动它背后的 Agent（allow-all 审批、无 allowlist）。请在受控聊天中使用。",
  );
  return lines.join("\n");
}
