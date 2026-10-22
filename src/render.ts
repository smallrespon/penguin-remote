// 渲染器：Run 事件 → 增量 markdown（流式预览）。
// 纯函数核心（applyEvent / renderPreview / shouldFlush）+ 薄状态壳 RunPreview。
// 数据模型是单一有序的「回复分区」列表：思考、工具调用、正文、提示按 Run 的真实时序排列。

import type { RunEvent } from "./run-event.js";

import { fitMiddleDropping } from "./budget.js";
import { redact } from "./logger.js";

export interface PreviewOptions {
  /** 距上次编辑 ≥ 该毫秒才允许再编辑。 */
  throttleMs: number;
  /** 或累积 ≥ 该字符数。 */
  throttleChars: number;
  /** 单条预览消息的字符上限。 */
  maxChars: number;
}

/** 上次 flush 的位置标记：发生时间与当时的渲染长度，节流判断用。 */
export interface FlushMark {
  at: number;
  chars: number;
}

/** 工具调用参数在预览里截断到多长。 */
export const TOOL_ARGS_LIMIT = 80;

/** 工具输出在预览里最多保留几行（保留末尾）。 */
export const TOOL_OUTPUT_MAX_LINES = 8;

/** 工具输出的单行截到多宽。 */
export const TOOL_OUTPUT_LINE_WIDTH = 100;

export const PLACEHOLDER_TEXT = "🦐 思考中…";

/** 聊天正在执行中的提示（Lane 忙、409 会话忙共用）。 */
export const BUSY_HINT = "⏳ 这个聊天正在执行中，`/stop` 可中断，请稍候再发。";

/** 正文分区：模型输出的一段文字。 */
export interface TextPart {
  kind: "text";
  text: string;
  /** text.done 收尾后为 true；未收尾的段落还会被后续 delta 追加。 */
  done?: boolean;
}

/** 思考分区：记全文、字符数与起止时间；全文只驻内存，供卡片的思考折叠面板使用（ADR-0007）。 */
export interface ThoughtPart {
  kind: "thought";
  chars: number;
  /** 思考全文（未脱敏；脱敏在渲染时做，见 card.ts 的 thoughtPanel）。 */
  text: string;
  startedAt: string;
  endedAt?: string;
}

/** 工具调用分区：一个 tool_call_id 一行，参数与输出可选。 */
export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  args?: string;
  output?: string;
  /** tool_call 事件时间（ADR-0010：每步耗时的起点）。 */
  startedAt?: string;
  /** tool_result 事件时间（回填输出时一并记下，耗时的终点）。 */
  endedAt?: string;
}

/** 提示分区：审批、压缩等非正文信息。 */
export interface NoticePart {
  kind: "notice";
  text: string;
}

export type PreviewPart = TextPart | ThoughtPart | ToolPart | NoticePart;

export interface PreviewState {
  /** 有序的回复分区。 */
  parts: PreviewPart[];
}

/**
 * 渲染场合：流式预览（Run 进行中）还是定稿（Run 结束）。
 * 只影响一处——未闭合的思考段在预览里显示「思考中…」，定稿里按已闭合样式显示。
 */
type RenderMode = "preview" | "final";

export function emptyPreview(): PreviewState {
  return { parts: [] };
}

/** 压空白：连续空白折叠成单个空格并去掉首尾；跨分区比较与单行展示都用这个形态。 */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 超长就砍掉尾巴加省略号。 */
function ellipsize(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 单行展示用：先压空白再截断（工具参数等）。 */
function truncate(text: string, limit: number): string {
  return ellipsize(squash(text), limit);
}

/** 把一个 AMSP 事件折叠进预览状态（纯函数，返回新状态）。 */
export function applyEvent(state: PreviewState, event: RunEvent): PreviewState {
  switch (event.type) {
    case "text.delta": {
      if (event.role !== "assistant" || event.text === "") return state;
      const last = state.parts.at(-1);
      // 紧跟着未收尾的正文段就是同一段话，继续追加。
      if (last?.kind === "text" && last.done !== true) {
        return { parts: [...state.parts.slice(0, -1), { ...last, text: last.text + event.text }] };
      }
      return { parts: [...state.parts, { kind: "text", text: event.text }] };
    }
    case "text.done": {
      if (event.role !== "assistant" || event.text === "") return state;
      // .done 是权威全文：替换掉未收尾的增量段；前面已是收尾段或非正文则另起一段。
      const last = state.parts.at(-1);
      if (last?.kind === "text" && last.done !== true) {
        return { parts: [...state.parts.slice(0, -1), { ...last, text: event.text, done: true }] };
      }
      return { parts: [...state.parts, { kind: "text", text: event.text, done: true }] };
    }
    case "thinking.delta": {
      const last = state.parts.at(-1);
      // 未闭合的思考段接着数；否则以本事件的 at 开一段新的。
      if (last?.kind === "thought" && last.endedAt === undefined) {
        return {
          parts: [
            ...state.parts.slice(0, -1),
            { ...last, chars: last.chars + event.thinking.length, text: last.text + event.thinking },
          ],
        };
      }
      return {
        parts: [
          ...state.parts,
          { kind: "thought", chars: event.thinking.length, text: event.thinking, startedAt: event.at },
        ],
      };
    }
    case "thinking.done": {
      const last = state.parts.at(-1);
      const unclosed = last?.kind === "thought" && last.endedAt === undefined ? last : undefined;
      // thinking.done 带的长度为 0 时（有的引擎只发 done），保留 delta 累加出来的值与文本；
      // 带了非空全文则以它为准（与 text.done 同一口径：done 事件是权威全文）。
      const chars = event.thinking.length !== 0 ? event.thinking.length : (unclosed?.chars ?? event.thinking.length);
      const text = event.thinking !== "" ? event.thinking : (unclosed?.text ?? event.thinking);
      if (unclosed !== undefined) {
        return { parts: [...state.parts.slice(0, -1), { ...unclosed, chars, text, endedAt: event.at }] };
      }
      return {
        parts: [...state.parts, { kind: "thought", chars, text, startedAt: event.at, endedAt: event.at }],
      };
    }
    case "tool_call.done": {
      // 先 redact 再 truncate：反过来会让跨过截断切口的密钥只漏出不完整片段，redact 的正则匹配不到。
      const args =
        event.arguments === ""
          ? undefined
          : truncate(redact(event.arguments), TOOL_ARGS_LIMIT);
      return {
        parts: [
          ...state.parts,
          {
            kind: "tool",
            id: event.tool_call_id,
            name: event.name,
            ...(args !== undefined ? { args } : {}),
            startedAt: event.at,
          },
        ],
      };
    }
    case "tool_result.done": {
      // 结果可能晚于下一个调用才到：回填到最后一个同 id 且还没有输出的调用上。
      const index = state.parts.findLastIndex(
        (part) => part.kind === "tool" && part.id === event.tool_call_id && part.output === undefined,
      );
      const output = redact(event.output);
      if (index === -1) {
        // 孤儿结果：只有终点没有起点——该步没有耗时（标题不给），但事件时间仍计入分组耗时。
        return { parts: [...state.parts, { kind: "tool", id: event.tool_call_id, name: "工具", output, endedAt: event.at }] };
      }
      const target = state.parts[index];
      if (target?.kind !== "tool") return state;
      const parts = [...state.parts];
      parts[index] = { ...target, output, endedAt: event.at };
      return { parts };
    }
    case "approval.requested":
      return { parts: [...state.parts, { kind: "notice", text: `⚠️ 等待审批：\`${event.tool_call.name}\`` }] };
    case "compaction.started":
      return { parts: [...state.parts, { kind: "notice", text: "🗜️ 正在压缩上下文…" }] };
    default:
      return state;
  }
}

/** 渲染当前预览 markdown；超预算时优先整块丢弃中间分区，展不开时结尾分区段内截断（绝不整块丢弃）。 */
export function renderPreview(state: PreviewState, options: PreviewOptions): string {
  return renderParts(state.parts, options.maxChars, "preview");
}

/** 定稿渲染：同样的规则；不另设预算（沿用「定稿不受 maxChars 约束」的现状）。 */
function renderFinal(state: PreviewState): string {
  return renderParts(state.parts, Number.MAX_SAFE_INTEGER, "final");
}

function renderParts(parts: PreviewPart[], maxChars: number, mode: RenderMode): string {
  const blocks = parts.map((part) => renderPart(part, mode)).filter((block) => block !== "");
  return fitBudget(blocks, maxChars);
}

/** 拼接后仍超预算：优先保头尾各若干段，从最中间开始整块丢弃，丢弃处标注省略了几个分区。 */
function fitBudget(blocks: string[], maxChars: number): string {
  const marker = (dropped: number): string => `……（中间省略 ${dropped} 个分区）……`;
  // 丢分区循环与 card.ts 同构，共用 budget.ts 的内核；放不下头尾两个分区时返回 null。
  const kept = fitMiddleDropping(blocks, (candidate) => candidate.join("\n\n").length <= maxChars, marker);
  if (kept !== null) return kept.join("\n\n");
  // 展不开两个分区：开头分区最多拿一半预算（信息量最高），剩下的都给结尾分区段内截断——
  // 最后一个分区通常是最终答案，永远不被整块丢弃；单分区状态下它就是全部内容。
  if (blocks.length === 1) return capBlock(blocks[0] ?? "", maxChars);
  const head = capBlock(blocks[0] ?? "", Math.floor(maxChars / 2));
  const dropped = blocks.length - 2;
  const note = dropped > 0 ? marker(dropped) : "";
  // 2 = 拼接用的一个 "\n\n"；丢过分区时再多一个分隔与标注的长度。
  const tailBudget = maxChars - head.length - note.length - (dropped > 0 ? 4 : 2);
  const tail = capBlock(blocks.at(-1) ?? "", tailBudget);
  return dropped > 0 ? `${head}\n\n${note}\n\n${tail}` : `${head}\n\n${tail}`;
}

/** 单个渲染块超预算：首尾对半砍、中间标注省略字数；结果保证不超过预算。 */
function capBlock(block: string, budget: number): string {
  if (budget <= 0) return "";
  if (block.length <= budget) return block;
  const omitted = block.length - budget;
  const note = `…（中间省略 ${omitted} 字）…`;
  const half = Math.floor((budget - note.length - 4) / 2); // 4 = 标注两边的 "\n\n"
  if (half <= 0) return `${block.slice(0, budget - 1)}…`;
  return `${block.slice(0, half)}\n\n${note}\n\n${block.slice(-half)}`;
}

function renderPart(part: PreviewPart, mode: RenderMode): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "thought":
      return thoughtTextLabel(part, mode);
    case "tool":
      return renderTool(part);
    case "notice":
      return part.text;
  }
}

/** 思考分区的一行标签（卡片路径，ADR-0007）：流式显示「运行中…」，定稿按已闭合样式显示「运行完毕」与耗时。 */
export function thoughtPanelTitle(part: ThoughtPart, mode: RenderMode): string {
  // 定稿时还没闭合的思考段：按已闭合的样式显示，但拿不到耗时就省掉，也不标「运行完毕」——
  // 没等到 thinking.done 就没有终态，不谎报（ADR-0007）。
  if (part.endedAt === undefined) {
    return mode === "final" ? `**🧠 思考 · ${part.chars} 字**` : `**🧠 思考 · 运行中… · ${part.chars} 字**`;
  }
  const seconds = (Date.parse(part.endedAt) - Date.parse(part.startedAt)) / 1000;
  return `**🧠 思考 · 运行完毕 · ${part.chars} 字 · ${seconds.toFixed(1)}s**`;
}

/**
 * 起止时间 → 「X.Xs」（卡片路径的步耗时，ADR-0010）。
 * 任一端缺失或解析不出时返回 undefined：缺时间戳的事件不参与耗时计算，也不编造数字。
 */
export function durationLabel(startedAt: string | undefined, endedAt: string | undefined): string | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return `${((end - start) / 1000).toFixed(1)}s`;
}

/** 思考分区的一行标签（文本兜底路径）：与卡片路径分流，状态词只出现在卡片里（ADR-0007）。 */
function thoughtTextLabel(part: ThoughtPart, mode: RenderMode): string {
  if (part.endedAt === undefined) {
    return mode === "final" ? `**🧠 思考 · ${part.chars} 字**` : `**🧠 思考中…（${part.chars} 字）**`;
  }
  const seconds = (Date.parse(part.endedAt) - Date.parse(part.startedAt)) / 1000;
  return `**🧠 思考 · ${part.chars} 字 · ${seconds.toFixed(1)}s**`;
}

function renderTool(part: ToolPart): string {
  const lines = [`**🔧 ${part.name}**`];
  if (part.args !== undefined && part.args !== "") {
    // 反引号会撑破行内代码，先换成单引号。
    lines.push(`\`${part.args.replace(/`/g, "'")}\``);
  }
  if (part.output !== undefined && part.output !== "") {
    lines.push("output:", fencedOutput(part.output));
  }
  return lines.join("\n");
}

/** 围栏长度：内容自带 ``` 时把围栏加长，否则代码块会被提前合上。 */
export function fenceFor(text: string): string {
  return text.includes("```") ? "````" : "```";
}

/** 工具输出的围栏代码块：保留末尾几行、每行限宽，超出行数时显式标注。 */
export function fencedOutput(output: string): string {
  const lines = output.split("\n");
  const kept = lines.length > TOOL_OUTPUT_MAX_LINES ? lines.slice(-TOOL_OUTPUT_MAX_LINES) : lines;
  const body = kept.map((line) => truncateLine(line, TOOL_OUTPUT_LINE_WIDTH)).join("\n");
  // 输出里自带 ``` 时把围栏加长，否则代码块会被提前合上。
  const fence = fenceFor(output);
  const note =
    lines.length > TOOL_OUTPUT_MAX_LINES
      ? `\n（已截断，共 ${lines.length} 行，显示末尾 ${TOOL_OUTPUT_MAX_LINES} 行）`
      : "";
  return `${fence}\n${body}\n${fence}${note}`;
}

/** 代码行裁剪：不压空白（围栏代码块里缩进有意义），只砍宽度。 */
function truncateLine(line: string, limit: number): string {
  return ellipsize(line, limit);
}

/** 节流判断：距今够久，或累积够多，才值得编辑一次。 */
export function shouldFlush(
  state: PreviewState,
  lastFlush: FlushMark,
  now: number,
  options: PreviewOptions,
): boolean {
  if (state.parts.length === 0) return false;
  if (now - lastFlush.at >= options.throttleMs) return true;
  return previewLength(state) - lastFlush.chars >= options.throttleChars;
}

function previewLength(state: PreviewState): number {
  return renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: Number.MAX_SAFE_INTEGER }).length;
}

/** 有状态薄壳：给 runner 用；节流判断与渲染都委托纯函数。 */
export class RunPreview {
  private state: PreviewState = emptyPreview();
  private lastFlush: FlushMark = { at: 0, chars: 0 };
  private readonly options: PreviewOptions;

  constructor(options: PreviewOptions) {
    this.options = options;
  }

  update(event: RunEvent): void {
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

  /** 追加一条非正文提示（如审批结果）。 */
  addNotice(text: string): void {
    this.state = { parts: [...this.state.parts, { kind: "notice", text }] };
  }

  /**
   * 当前分区快照，供定稿使用。
   * 直接返回内部 state 是安全的：applyEvent 与 addNotice 全是替换式更新（新数组、新对象），
   * 没有任何路径就地修改 parts 或其元素；后续 update 也是整体替换 state，
   * 所以调用方拿到引用后，内容不会再变。
   */
  snapshot(): PreviewState {
    return this.state;
  }
}

function formatUsage(usage: { total: number } | null): string {
  if (usage === null) return "用量未知";
  return `用量 ${usage.total} tokens`;
}

/** 一次 Run 的结局：formatFinalText 与 card.ts 的 buildRunCard 共用的入参形状（载体不同，口径一致）。 */
export interface FinalOutcome {
  status: string;
  text: string;
  error?: { code: string; message: string };
  usage: { total: number } | null;
}

/** 一次 Run 结束后发给聊天的最终文本。 */
export function formatFinalText(outcome: FinalOutcome, state: PreviewState): string {
  const body = renderFinal({ parts: finalParts(outcome, state) });
  if (outcome.status === "completed") {
    return `${body}\n\n---\n${formatUsage(outcome.usage)}`;
  }
  const reason = outcome.error?.message ?? outcome.error?.code ?? outcome.status;
  return `${body}\n\n---\n未正常完成（${outcome.status}）：${reason}\n${formatUsage(outcome.usage)}`;
}

/**
 * 定稿分区：流式攒下来的正文与 outcome 的正文（压空白后）一致，就按分区原样呈现，
 * 保住思考、工具与它们的时序；不一致说明 outcome 才是权威全文，换成它单独一段。
 * outcome 没有正文时（典型：中断发生在完整文本落盘前），保留流式累积的正文——
 * 那是当时最好的答案；连流式正文也没有，才给占位说明。
 */
export function finalParts(outcome: { text: string }, state: PreviewState): PreviewPart[] {
  const finalText = outcome.text.trim();
  const textParts = state.parts.filter((part): part is TextPart => part.kind === "text");
  const accumulated = textParts.map((part) => part.text).join("\n\n");
  if (finalText !== "") {
    if (squash(accumulated) === squash(finalText)) return state.parts;
    return [
      ...state.parts.filter((part) => part.kind !== "text"),
      { kind: "text", text: finalText, done: true },
    ];
  }
  if (textParts.length > 0) return state.parts;
  return [
    ...state.parts.filter((part) => part.kind !== "text"),
    { kind: "text", text: "（本轮没有文本输出）", done: true },
  ];
}

/** 面向用户的错误提示（密钥打码后）。 */
export function formatRunFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `执行失败：${redact(message === "" ? String(error) : message)}`;
}
