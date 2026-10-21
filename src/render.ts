// Run 收尾文案：AMSP 结果 → 发给飞书的最终文本。
// 增量渲染（流式预览）在 T6 加入，同文件扩展。

import type { AmspRunOutcome } from "./penguin/amsp.js";

function formatUsage(usage: { total: number } | null): string {
  if (usage === null) return "用量未知";
  return `用量 ${usage.total} tokens`;
}

/** 一次 Run 结束后发给聊天的最终文本。 */
export function formatFinalText(outcome: AmspRunOutcome): string {
  const body = outcome.text.trim() === "" ? "（本轮没有文本输出）" : outcome.text.trim();
  if (outcome.status === "completed") {
    return `${body}\n\n---\n${formatUsage(outcome.usage)}`;
  }
  const reason = outcome.error?.message ?? outcome.error?.code ?? outcome.status;
  return `${body}\n\n---\n未正常完成（${outcome.status}）：${reason}\n${formatUsage(outcome.usage)}`;
}

/** 面向用户的错误提示。 */
export function formatRunFailure(error: unknown): string {
  if (error instanceof Error && error.message !== "") return `执行失败：${error.message}`;
  return `执行失败：${String(error)}`;
}
