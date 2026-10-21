// 渲染器：AMSP 事件 → 增量 markdown（流式预览）。
// 纯函数核心（applyEvent / renderPreview / shouldFlush）+ 薄状态壳 RunPreview。

import type { AmspEvent } from "@prismshadow/amsp";

export interface PreviewOptions {
  /** 距上次编辑 ≥ 该毫秒才允许再编辑。 */
  throttleMs: number;
  /** 或累积 ≥ 该字符数。 */
  throttleChars: number;
  /** 单条预览消息的字符上限。 */
  maxChars: number;
}

/** 工具输出在预览里截断到多长。 */
export const TOOL_OUTPUT_LIMIT = 200;

export const PLACEHOLDER_TEXT = "🦐 思考中…";

/** 聊天正在执行中的提示（Lane 忙、409 会话忙共用）。 */
export const BUSY_HINT = "⏳ 这个聊天正在执行中，`/stop` 可中断，请稍候再发。";

export interface PreviewState {
  /** 累积的正文（assistant 文本）。 */
  text: string;
  thinkingChars: number;
  tools: string[];
  toolOutputs: string[];
  /** 非正文的提示行（压缩、审批等）。 */
  notices: string[];
  /** 已收尾的 text.done 条数。 */
  doneTexts: number;
}

export function emptyPreview(): PreviewState {
  return { text: "", thinkingChars: 0, tools: [], toolOutputs: [], notices: [], doneTexts: 0 };
}

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 把一个 AMSP 事件折叠进预览状态（纯函数，返回新状态）。 */
export function applyEvent(state: PreviewState, event: AmspEvent): PreviewState {
  switch (event.type) {
    case "text.delta":
      if (event.role !== "assistant" || event.text === "") return state;
      return { ...state, text: state.text + event.text };
    case "text.done": {
      if (event.role !== "assistant" || event.text === "") return state;
      // .done 是权威全文：第一条替换掉累积的增量，后续条目按段拼接。
      const text =
        state.doneTexts === 0 ? event.text : `${state.text}\n\n${event.text}`;
      return { ...state, text, doneTexts: state.doneTexts + 1 };
    }
    case "thinking.delta":
      return { ...state, thinkingChars: state.thinkingChars + event.thinking.length };
    case "tool_call.done":
      return { ...state, tools: [...state.tools, `🔧 调用 \`${event.name}\``] };
    case "tool_result.done":
      if (event.output === "") return state;
      return { ...state, toolOutputs: [...state.toolOutputs, `└ ${truncate(event.output, TOOL_OUTPUT_LIMIT)}`] };
    case "approval.requested":
      return { ...state, notices: [...state.notices, `⚠️ 等待审批：\`${event.tool_call.name}\``] };
    case "compaction.started":
      return { ...state, notices: [...state.notices, "🗜️ 正在压缩上下文…"] };
    default:
      return state;
  }
}

/** 渲染当前预览 markdown；超上限时首尾各留一半、中间标注省略。 */
export function renderPreview(state: PreviewState, options: PreviewOptions): string {
  const parts: string[] = [];
  if (state.thinkingChars > 0) parts.push(`🧠 思考中…（${state.thinkingChars} 字）`);
  if (state.text !== "") parts.push(state.text);
  if (state.tools.length > 0) parts.push(state.tools.join("\n"));
  if (state.toolOutputs.length > 0) parts.push(state.toolOutputs.join("\n"));
  if (state.notices.length > 0) parts.push(state.notices.join("\n"));
  const joined = parts.join("\n\n");
  if (joined.length <= options.maxChars) return joined;
  const half = Math.floor(options.maxChars / 2);
  const omitted = joined.length - options.maxChars;
  return `${joined.slice(0, half)}\n\n…（中间省略 ${omitted} 字）…\n\n${joined.slice(-half)}`;
}

/** 节流判断：距今够久，或累积够多，才值得编辑一次。 */
export function shouldFlush(
  state: PreviewState,
  lastFlush: { at: number; chars: number },
  now: number,
  options: PreviewOptions,
): boolean {
  if (state.text.length === 0 && state.tools.length === 0 && state.toolOutputs.length === 0 && state.notices.length === 0) {
    return false;
  }
  if (now - lastFlush.at >= options.throttleMs) return true;
  return previewLength(state) - lastFlush.chars >= options.throttleChars;
}

function previewLength(state: PreviewState): number {
  return renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: Number.MAX_SAFE_INTEGER }).length;
}

/** 有状态薄壳：给 runner 用；节流判断与渲染都委托纯函数。 */
export class RunPreview {
  private state: PreviewState = emptyPreview();
  private lastFlush: { at: number; chars: number } = { at: 0, chars: 0 };
  private readonly options: PreviewOptions;

  constructor(options: PreviewOptions) {
    this.options = options;
  }

  update(event: AmspEvent): void {
    this.state = applyEvent(this.state, event);
  }

  markdown(): string {
    return renderPreview(this.state, this.options);
  }

  /** 到了该编辑的时候吗（内部记录上次flush 的时间与长度）。 */
  due(now: number): boolean {
    return shouldFlush(this.state, this.lastFlush, now, this.options);
  }

  noteFlushed(now: number): void {
    this.lastFlush = { at: now, chars: previewLength(this.state) };
  }
}

function formatUsage(usage: { total: number } | null): string {
  if (usage === null) return "用量未知";
  return `用量 ${usage.total} tokens`;
}

/** 一次 Run 结束后发给聊天的最终文本。 */
export function formatFinalText(outcome: {
  status: string;
  text: string;
  error?: { code: string; message: string };
  usage: { total: number } | null;
}): string {
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
