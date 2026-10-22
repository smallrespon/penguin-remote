// 飞书交互卡片（Card 2.0）构建：Run 回复的卡片版渲染器。
// 与 render.ts 的文本版同源——同一批分区（定稿走 finalParts，保证答案不丢）、
// 同一套预算装配思路（超预算先整块丢中间分区，展不开再段内截断），只是载体不同。
// 结构按 lark-cli 实测可发送、可 patch 的形态组织：思考与工具调用都放进默认收起的折叠面板。

import type { FinalOutcome, PreviewPart, PreviewState, ThoughtPart, ToolPart } from "./render.js";
import { fenceFor, finalParts, fencedOutput, thoughtPanelTitle } from "./render.js";
import { fitMiddleDroppingPreferred } from "./budget.js";
import { redact } from "./logger.js";

/** 整卡 JSON.stringify 后的字符预算：飞书 patch 上限 30KB，留余量。 */
export const CARD_BUDGET_CHARS = 20000;

/** 思考折叠面板里思考全文的字符上限：超了头尾对半砍、中间标注省略字数（ADR-0007）。 */
export const THOUGHT_PANEL_LIMIT = 2000;

/** 飞书单卡元素个数硬上限（折叠面板内部元素也计数）；丢分区的逻辑顺带覆盖，这里兜底。 */
const MAX_ELEMENTS = 200;

/** 标题模板色（Card 2.0 header.template 取值）。 */
export type CardTemplate = "blue" | "green" | "red";

/** markdown 元素：正文与提示原样展开；思考标签与面板内容用小字（notation）。 */
export interface MarkdownElement {
  tag: "markdown";
  content: string;
  text_size?: "notation";
}

/** 可折叠面板：工具调用的载体，默认收起，标题带名称与参数。 */
export interface CollapsiblePanelElement {
  tag: "collapsible_panel";
  expanded: boolean;
  header: { title: MarkdownElement };
  elements: MarkdownElement[];
}

/** Card 2.0 元素：本项目只用 markdown、hr 与可折叠面板三种。 */
export type CardElement = MarkdownElement | { tag: "hr" } | CollapsiblePanelElement;

/** Card 2.0 卡片 JSON 的结构化类型（schema / config / header / body）。 */
export interface RunCard {
  schema: "2.0";
  config: { update_multi: boolean; width_mode: "default" };
  header: { title: { tag: "plain_text"; content: string }; template: CardTemplate };
  body: { direction: "vertical"; padding: "12px 12px 16px 12px"; elements: CardElement[] };
}

/** 占位卡：Run 开始前先落地，拿到 message_id 后再 patch 成预览卡。 */
export function placeholderCard(): RunCard {
  return card("🦐 思考中…", "blue", []);
}

/** 错误卡：会话准备失败、断流等定稿前的失败，把脱敏后的错误文本 patch 进占位卡。 */
export function errorCard(text: string): RunCard {
  // 错误文本由调用方脱敏后传入，原样呈现（普通 markdown 元素，不做行内代码那样的反引号替换）；
  // 不走预算装配——错误文本短，且这是失败路径，不需要再丢分区。
  const content = text === "" ? "（无错误信息）" : text;
  return card("❌ 未正常完成", "red", [{ tag: "markdown", content }]);
}

/** 忙卡：会话忙（409 / Lane 忙）时把「请稍候」提示 patch 进占位卡，不留「思考中」僵尸卡。 */
export function busyCard(text: string): RunCard {
  // 与 errorCard 同一形态：文案由调用方给，这里只套外壳；不走预算装配——提示文本短，
  // 且忙提示不是 Run 结果，没有分区可丢。
  const content = text === "" ? "（无提示内容）" : text;
  return card("⏳ 请稍候", "blue", [{ tag: "markdown", content }]);
}

/** 预览卡：Run 进行中，按当前分区渲染（思考一行标签、工具收进面板、正文展开）。 */
export function buildPreviewCard(state: PreviewState): RunCard {
  return assemble("🦐 执行中…", "blue", state.parts, "preview", []);
}

/** 定稿卡：分区与文本定稿同源（finalParts），页脚带用量；未正常完成时带状态与原因。 */
export function buildRunCard(outcome: FinalOutcome, state: PreviewState): RunCard {
  const completed = outcome.status === "completed";
  return assemble(
    completed ? "✅ 完成" : "❌ 未正常完成",
    completed ? "green" : "red",
    finalParts(outcome, state),
    "final",
    footer(outcome),
  );
}

/** 装配槽：一个分区对应一个元素；droppableFirst 标记预算紧张时优先整块丢弃的分区（思考，ADR-0007）。 */
interface Slot {
  element: CardElement;
  droppableFirst: boolean;
}

/** 装配：分区 → 元素，过预算装配，再套上卡片外壳。 */
function assemble(
  title: string,
  template: CardTemplate,
  parts: PreviewPart[],
  mode: "preview" | "final",
  footer: CardElement[],
): RunCard {
  // 一个分区恰好渲染成一个元素（思考与工具都是折叠面板），所以「丢分区」就是丢元素。
  const slots: Slot[] = parts.map((part) => ({
    element: partElement(part, mode),
    droppableFirst: part.kind === "thought",
  }));
  const elementsOf = (candidate: Slot[]): CardElement[] => [...candidate.map((slot) => slot.element), ...footer];
  const fits = (candidate: Slot[]): boolean =>
    JSON.stringify(card(title, template, elementsOf(candidate))).length <= CARD_BUDGET_CHARS &&
    countElements(elementsOf(candidate)) <= MAX_ELEMENTS;
  // 丢分区循环与 render.ts 同构，共用 budget.ts 的内核；思考面板优先丢（ADR-0007）。
  // 连头尾两个分区都放不下时返回 null，走卡片刻的段内截断（capSlots）。
  const kept = fitMiddleDroppingPreferred(
    slots,
    fits,
    (dropped): Slot => ({ element: dropNotice(dropped), droppableFirst: false }),
    (slot) => slot.droppableFirst,
  );
  return card(title, template, elementsOf(kept ?? capSlots(slots, fits)));
}

/** 分区 → 元素：正文与提示原样展开；思考与工具进默认收起的折叠面板。 */
function partElement(part: PreviewPart, mode: "preview" | "final"): CardElement {
  switch (part.kind) {
    case "text":
      return { tag: "markdown", content: part.text };
    case "thought":
      return thoughtPanel(part, mode);
    case "notice":
      return { tag: "markdown", content: part.text };
    case "tool":
      return toolPanel(part);
  }
}

/** 思考分区 → 折叠面板：标题是思考标签（带运行状态），面板里是完整思考全文（ADR-0007）。 */
function thoughtPanel(part: ThoughtPart, mode: "preview" | "final"): CollapsiblePanelElement {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "markdown", content: thoughtPanelTitle(part, mode) } },
    elements: [{ tag: "markdown", content: thinkingBody(part), text_size: "notation" }],
  };
}

/**
 * 思考面板内容：完整思考全文，先脱敏再按上限头尾截断，围栏代码块保真。
 * 上限按脱敏后的全文计（省略标注计入这 2000 字，围栏另加约 8 字符）；
 * 思考文本为空时给占位说明（与工具面板的「（无详情）」同一套路）。
 * 脱敏放在渲染时：思考经多个 delta 累积，只有拿全全文才能命中跨 delta 拼出来的密钥
 * （工具参数在 tool_call.done 就拿到完整字符串，所以才在累积时脱敏）。
 */
function thinkingBody(part: ThoughtPart): string {
  const text = redact(part.text);
  if (text === "") return "（无思考内容）";
  const fence = fenceFor(text);
  return `${fence}\n${capContent(text, THOUGHT_PANEL_LIMIT)}\n${fence}`;
}

/** 工具分区 → 折叠面板：标题「🔧 名称 · 状态 · 参数」，面板里是参数与输出的围栏块。 */
function toolPanel(part: ToolPart): CollapsiblePanelElement {
  const args = part.args === undefined || part.args === "" ? undefined : part.args;
  const output = part.output === undefined || part.output === "" ? undefined : part.output;
  // 状态只看 output 到没到：没到就是运行中，到了（含空串）就是运行完毕（ADR-0007）。
  const state = part.output === undefined ? "运行中…" : "运行完毕";
  // 反引号会撑破标题里的行内代码与面板里的围栏，先换成单引号（与 render.ts 的 renderTool 一致）。
  const shownArgs = args === undefined ? undefined : args.replace(/`/g, "'");
  const title =
    shownArgs === undefined
      ? `**🔧 ${part.name} · ${state}**`
      : `**🔧 ${part.name} · ${state}** · \`${shownArgs}\``;
  const blocks: string[] = [];
  if (shownArgs !== undefined) blocks.push(`\`\`\`json\n${shownArgs}\n\`\`\``);
  if (output !== undefined) blocks.push(fencedOutput(output));
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "markdown", content: title } },
    elements: [
      { tag: "markdown", content: blocks.length > 0 ? blocks.join("\n\n") : "（无详情）", text_size: "notation" },
    ],
  };
}

/** 定稿页脚：hr + 一行小字；未正常完成的文案与 formatFinalText 完全一致，只是载体不同。 */
function footer(outcome: FinalOutcome): CardElement[] {
  const usage = outcome.usage === null ? "用量未知" : `用量 ${outcome.usage.total} tokens`;
  const content =
    outcome.status === "completed"
      ? usage
      : `未正常完成（${outcome.status}）：${outcome.error?.message ?? outcome.error?.code ?? outcome.status}\n${usage}`;
  return [{ tag: "hr" }, { tag: "markdown", content, text_size: "notation" }];
}

/** 丢分区处的标注：与 render.ts fitBudget 的 marker 同文案。 */
function dropNotice(dropped: number): CardElement {
  return { tag: "markdown", content: `……（中间省略 ${dropped} 个分区）……` };
}

/** 元素个数（含嵌套）：飞书单卡 200 元素上限连 collapsible_panel 内部的元素一起算。 */
function countElements(elements: CardElement[]): number {
  return elements.reduce(
    (total, element) => total + (element.tag === "collapsible_panel" ? 1 + element.elements.length : 1),
    0,
  );
}

/**
 * 展不开（连头尾两个分区都放不下）时的段内截断：开头元素最多拿一半预算，
 * 剩余给结尾元素；单分区时全部预算给它。JSON 转义会让字符数膨胀，
 * 按原始字符预算砍完重测，仍超预算就整体对半收紧，直到放得下。
 */
function capSlots(slots: Slot[], fits: (candidate: Slot[]) => boolean): Slot[] {
  const first = slots[0];
  if (first === undefined) return slots;
  const last = slots.at(-1) ?? first;
  const single = slots.length === 1;
  const dropped = slots.length - 2;
  const middle = dropped > 0 ? [{ element: dropNotice(dropped), droppableFirst: false } satisfies Slot] : [];
  for (let budget = CARD_BUDGET_CHARS; budget > 0; budget = Math.floor(budget / 2)) {
    const cappedFirst = capSlot(first, single ? budget : Math.floor(budget / 2));
    const tailBudget = budget - contentLength(cappedFirst.element);
    const candidate = single ? [cappedFirst] : [cappedFirst, ...middle, capSlot(last, tailBudget)];
    if (fits(candidate)) return candidate;
  }
  // 防御：空内容的骨架卡片本身远小于预算，理论上到不了这里。
  return single ? [capSlot(first, 0)] : [capSlot(first, 0), ...middle, capSlot(last, 0)];
}

/** 元素的原始内容字符数（JSON 测长前的口径）：markdown 看 content，折叠面板看面板内容。 */
function contentLength(element: CardElement): number {
  if (element.tag === "markdown") return element.content.length;
  if (element.tag === "collapsible_panel") {
    return element.elements.reduce((total, item) => total + item.content.length, 0);
  }
  return 0;
}

/** 段内截断单个元素的内容：首尾对半砍、中间标注省略字数（与 render.ts 的 capBlock 同算法）。 */
function capElement(element: CardElement, budget: number): CardElement {
  if (element.tag === "markdown") return { ...element, content: capContent(element.content, budget) };
  if (element.tag === "collapsible_panel") {
    return {
      ...element,
      elements: element.elements.map((item) => ({ ...item, content: capContent(item.content, budget) })),
    };
  }
  return element;
}

/** 槽位版段内截断：元素换掉，优先丢弃标记不动。 */
function capSlot(slot: Slot, budget: number): Slot {
  return { ...slot, element: capElement(slot.element, budget) };
}

/** 内容超预算：首尾对半砍、中间标注省略字数；结果保证不超过预算。 */
function capContent(content: string, budget: number): string {
  if (budget <= 0) return "";
  if (content.length <= budget) return content;
  const omitted = content.length - budget;
  const note = `…（中间省略 ${omitted} 字）…`;
  const half = Math.floor((budget - note.length - 4) / 2); // 4 = 标注两边的 "\n\n"
  if (half <= 0) return `${content.slice(0, budget - 1)}…`;
  return `${content.slice(0, half)}\n\n${note}\n\n${content.slice(-half)}`;
}

/** 卡片外壳：header 用 plain_text 标题 + 模板色，body 纵向排列。 */
function card(title: string, template: CardTemplate, elements: CardElement[]): RunCard {
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "default" },
    header: { title: { tag: "plain_text", content: title }, template },
    body: { direction: "vertical", padding: "12px 12px 16px 12px", elements },
  };
}
