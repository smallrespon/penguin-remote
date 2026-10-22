import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CARD_BUDGET_CHARS,
  buildPreviewCard,
  buildRunCard,
  busyCard,
  errorCard,
  placeholderCard,
  type CardElement,
  type CollapsiblePanelElement,
  type RunCard,
} from "../src/card.js";
import { BUSY_HINT, applyEvent, emptyPreview, formatFinalText } from "../src/render.js";
import type { RunEvent } from "../src/run-event.js";
import { footerOf, hasText, markdownAt, panelAt, panelsOf } from "./helpers/card-shape.js";

// 单元测试用的事件构造器（与 render.test.ts 同款形态）。
const textDelta = (text: string): RunEvent => ({ type: "text.delta", role: "assistant", text });
const textDone = (text: string): RunEvent => ({ type: "text.done", role: "assistant", text });
const thinkingDelta = (thinking: string, at = "2026-10-21T10:00:00.000Z"): RunEvent => ({ type: "thinking.delta", thinking, at });
const thinkingDone = (thinking: string, at = "2026-10-21T10:00:05.000Z"): RunEvent => ({ type: "thinking.done", thinking, at });
const toolCallDone = (id: string, name: string, args = "{}", at = "2026-10-21T10:00:00.000Z"): RunEvent => ({
  type: "tool_call.done",
  name,
  arguments: args,
  tool_call_id: id,
  at,
});
const toolResultDone = (id: string, output: string, at = "2026-10-21T10:00:02.000Z"): RunEvent => ({
  type: "tool_result.done",
  output,
  tool_call_id: id,
  at,
});

/** 折叠面板里的第一个 markdown 元素内容（步面板的内容载体；分组面板里是嵌套面板，取不到）。 */
function panelContent(panel: CollapsiblePanelElement): string {
  const first = panel.elements[0];
  return first !== undefined && first.tag === "markdown" ? first.content : "";
}

/** 顶层元素里的全部折叠面板（不含分组面板里嵌套的步面板）。 */
function topPanels(card: RunCard): CollapsiblePanelElement[] {
  return card.body.elements.filter(
    (element): element is CollapsiblePanelElement => element.tag === "collapsible_panel",
  );
}

/** 递归元素个数：折叠面板本身算 1，面板里的元素（可能还是面板）继续累计（飞书 200 上限同口径）。 */
function countAll(elements: CardElement[]): number {
  return elements.reduce(
    (total, element) => total + (element.tag === "collapsible_panel" ? 1 + countAll(element.elements) : 1),
    0,
  );
}

/** 连续 text.delta + text.done 落一个已收尾的正文分区。 */
function appendText(state: ReturnType<typeof emptyPreview>, text: string): ReturnType<typeof emptyPreview> {
  return applyEvent(applyEvent(state, textDelta(text)), textDone(text));
}

test("card：占位卡是蓝色「思考中」，正文为空", () => {
  const card = placeholderCard();
  assert.equal(card.schema, "2.0");
  assert.deepEqual(card.config, { update_multi: true, width_mode: "default" });
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "🦐 思考中…" }, template: "blue" });
  assert.deepEqual(card.body, { direction: "vertical", padding: "12px 12px 16px 12px", elements: [] });
});

test("card：预览卡是蓝色「执行中」", () => {
  const card = buildPreviewCard(emptyPreview());
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "🦐 执行中…" }, template: "blue" });
  assert.deepEqual(card.body.elements, []);
});

test("card：错误卡是红色「❌ 未正常完成」，正文原样携带脱敏后的错误文本", () => {
  const card = errorCard("执行失败：`lark-cli` 不见了");
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "❌ 未正常完成" }, template: "red" });
  assert.deepEqual(card.body.elements, [{ tag: "markdown", content: "执行失败：`lark-cli` 不见了" }]);
  assert.deepEqual(card.config, { update_multi: true, width_mode: "default" }, "卡片外壳与其它卡一致");
});

test("card：错误文本为空字符串时正文用占位文案", () => {
  const card = errorCard("");
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "❌ 未正常完成" }, template: "red" });
  assert.deepEqual(card.body.elements, [{ tag: "markdown", content: "（无错误信息）" }]);
});

test("card：忙卡是蓝色「⏳ 请稍候」，正文原样携带 BUSY_HINT", () => {
  const card = busyCard(BUSY_HINT);
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "⏳ 请稍候" }, template: "blue" });
  assert.deepEqual(card.body.elements, [{ tag: "markdown", content: BUSY_HINT }]);
  assert.deepEqual(card.config, { update_multi: true, width_mode: "default" }, "卡片外壳与其它卡一致");
});

test("card：忙提示为空字符串时正文用占位文案", () => {
  const card = busyCard("");
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "⏳ 请稍候" }, template: "blue" });
  assert.deepEqual(card.body.elements, [{ tag: "markdown", content: "（无提示内容）" }]);
});

test("card：定稿完成卡是绿色「✅ 完成」，页脚是 hr 加用量行", () => {
  const card = buildRunCard({ status: "completed", text: "答完了", usage: { total: 42 } }, appendText(emptyPreview(), "答完了"));
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "✅ 完成" }, template: "green" });
  assert.equal(card.body.elements.at(-2)?.tag, "hr", "用量行前面必须有一条 hr");
  assert.equal(footerOf(card), "用量 42 tokens");
});

test("card：定稿完成但 usage 为 null 时页脚是「用量未知」", () => {
  const card = buildRunCard({ status: "completed", text: "答完了", usage: null }, appendText(emptyPreview(), "答完了"));
  assert.equal(footerOf(card), "用量未知");
});

test("card：定稿失败卡是红色「❌ 未正常完成」，页脚文案与 formatFinalText 一致", () => {
  const outcome = {
    status: "aborted",
    text: "做到一半",
    error: { code: "user_abort", message: "用户中断" },
    usage: { total: 7 },
  };
  const card = buildRunCard(outcome, appendText(emptyPreview(), "做到一半"));
  assert.deepEqual(card.header, { title: { tag: "plain_text", content: "❌ 未正常完成" }, template: "red" });
  // 文本定稿里 "---" 之后的部分就是卡片页脚的 content：载体不同，文案一致。
  const textFooter = formatFinalText(outcome, appendText(emptyPreview(), "做到一半")).split("\n\n---\n").at(-1);
  assert.equal(footerOf(card), textFooter);
  assert.equal(footerOf(card), "未正常完成（aborted）：用户中断\n用量 7 tokens");
  assert.equal(card.body.elements.at(-2)?.tag, "hr");
});

test("card：定稿失败且没有 error 时页脚退到 status", () => {
  const outcome = { status: "fatal", text: "半途而废", usage: null };
  const card = buildRunCard(outcome, appendText(emptyPreview(), "半途而废"));
  assert.equal(footerOf(card), "未正常完成（fatal）：fatal\n用量未知");
});

test("card：思考渲染成默认收起的折叠面板，标题带「运行完毕」，面板是完整思考全文", () => {
  const state = applyEvent(
    applyEvent(emptyPreview(), thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z")),
    thinkingDone("先想一下", "2026-10-21T10:00:04.230Z"),
  );
  const card = buildRunCard({ status: "completed", text: "答完了", usage: { total: 1 } }, state);
  const panel = panelAt(card);
  assert.equal(panel.expanded, false, "默认收起");
  assert.equal(panel.header.title.content, "**🧠 思考 · 运行完毕 · 4 字 · 4.2s**");
  assert.deepEqual(panel.elements, [{ tag: "markdown", content: "```\n先想一下\n```", text_size: "notation" }]);
});

test("card：预览里未闭合的思考标题显示「运行中…」，面板同样是累积全文", () => {
  const state = applyEvent(emptyPreview(), thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  const panel = panelAt(buildPreviewCard(state));
  assert.equal(panel.expanded, false, "默认收起");
  assert.equal(panel.header.title.content, "**🧠 思考 · 运行中… · 4 字**");
  assert.deepEqual(panel.elements, [{ tag: "markdown", content: "```\n先想一下\n```", text_size: "notation" }]);
});

test("card：定稿时仍未闭合的思考段标题不带状态词", () => {
  const state = applyEvent(emptyPreview(), thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  const panel = panelAt(buildRunCard({ status: "completed", text: "答完了", usage: { total: 1 } }, state));
  assert.equal(panel.header.title.content, "**🧠 思考 · 4 字**", "没等到 thinking.done 就不标「运行完毕」");
});

test("card：思考全文超过 2000 字时面板内容头尾对半砍并标注省略字数", () => {
  const thinking = "甲".repeat(1500) + "乙".repeat(1500);
  const state = applyEvent(emptyPreview(), thinkingDone(thinking, "2026-10-21T10:00:04.230Z"));
  const panel = panelAt(buildRunCard({ status: "completed", text: "答完了", usage: { total: 1 } }, state));
  const content = panelContent(panel);
  assert.ok(content.startsWith("```\n甲"), "开头要留下");
  assert.ok(content.endsWith("乙\n```"), "结尾要留下");
  assert.match(content, /…（中间省略 \d+ 字）…/);
  assert.ok(content.length <= 2000 + 16, `面板内容应受 2000 字上限约束，实际 ${content.length}`);
});

test("card：思考全文先脱敏再截断，跨 delta 拼起来的密钥也打码", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("密钥是 penguin_", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDelta("abcdef123456，记住它", "2026-10-21T10:00:01.000Z"));
  state = applyEvent(state, thinkingDone("", "2026-10-21T10:00:02.000Z"));
  const content = panelContent(panelAt(buildPreviewCard(state)));
  assert.ok(!content.includes("abcdef123456"), `密钥本体泄漏：${content}`);
  assert.ok(content.includes("penguin_***"), `打码标记应完整可见：${content}`);
});

test("card：思考全文自带 ``` 时围栏加长，代码块不被提前合上", () => {
  const state = applyEvent(emptyPreview(), thinkingDone("看这段\n```\nconst a = 1;\n```\n完", "2026-10-21T10:00:04.230Z"));
  const panel = panelAt(buildRunCard({ status: "completed", text: "答完了", usage: { total: 1 } }, state));
  const content = panelContent(panel);
  assert.ok(content.startsWith("````\n"), content);
  assert.ok(content.endsWith("\n````"), content);
});

test("card：正文原样展开，不进面板", () => {
  const card = buildPreviewCard(appendText(emptyPreview(), "第一行\n\n第二行"));
  assert.deepEqual(card.body.elements, [{ tag: "markdown", content: "第一行\n\n第二行" }]);
  assert.equal(
    card.body.elements.filter((element) => element.tag === "collapsible_panel").length,
    0,
    "正文不该进面板",
  );
});

test("card：提示分区原样展开", () => {
  const card = buildPreviewCard(applyEvent(emptyPreview(), { type: "compaction.started" }));
  assert.deepEqual(card.body.elements, [{ tag: "markdown", content: "🗜️ 正在压缩上下文…" }]);
});

test("card：工具渲染成默认收起的折叠面板，标题带名称与参数，面板含参数与输出围栏块", () => {
  let state = emptyPreview();
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = applyEvent(state, toolResultDone("c1", "a.ts\nb.ts"));
  const card = buildPreviewCard(state);
  const panel = panelAt(card);
  assert.equal(panel.expanded, false, "默认收起");
  assert.equal(panel.header.title.tag, "markdown");
  assert.equal(panel.header.title.content, '**🔧 exec_command · 运行完毕 · 2.0s** · `{"command":"ls"}`');
  assert.deepEqual(panel.elements, [
    {
      tag: "markdown",
      content: `${["```json", '{"command":"ls"}', "```"].join("\n")}\n\n${["```", "a.ts", "b.ts", "```"].join("\n")}`,
      text_size: "notation",
    },
  ]);
});

test("card：工具参数里的反引号换成单引号，避免撑破标题行内代码", () => {
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", '{"command":"echo `hi`"}'));
  const panel = panelAt(buildPreviewCard(state));
  assert.equal(panel.header.title.content, '**🔧 exec_command · 运行中…** · `{"command":"echo \'hi\'"}`');
  assert.ok(!panelContent(panel).includes("`hi`"), "面板围栏里也不该出现反引号");
});

test("card：工具输出超长时沿用 fencedOutput 的截断标注", () => {
  const output = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  const content = panelContent(panelAt(buildPreviewCard(state)));
  assert.ok(content.includes("第 20 行"), "末尾行要留下");
  assert.ok(!content.includes("第 12 行"), "第 12 行应被丢掉");
  assert.match(content, /（已截断，共 20 行，显示末尾 8 行）/);
});

test("card：工具输出自带 ``` 时围栏加长，代码块不被提前合上", () => {
  const output = "```\nconst a = 1;\n```";
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  const content = panelContent(panelAt(buildPreviewCard(state)));
  assert.ok(content.includes("````\n```\nconst a = 1;\n```\n````"), content);
});

test("card：无参数无输出的工具面板显示「（无详情）」", () => {
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", ""));
  const panel = panelAt(buildPreviewCard(state));
  assert.equal(panel.header.title.content, "**🔧 exec_command · 运行中…**", "没有参数时标题只有名称与状态");
  assert.deepEqual(panel.elements, [{ tag: "markdown", content: "（无详情）", text_size: "notation" }]);
});

test("card：只有输出没有参数时面板只有输出围栏块", () => {
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", "")), toolResultDone("c1", "结果"));
  const panel = panelAt(buildPreviewCard(state));
  assert.equal(panel.header.title.content, "**🔧 exec_command · 运行完毕 · 2.0s**");
  assert.deepEqual(panel.elements, [{ tag: "markdown", content: "```\n结果\n```", text_size: "notation" }]);
});

test("card：工具面板标题在收到 output 后从「运行中…」变「运行完毕」，空 output 也算完毕", () => {
  let state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  assert.match(panelAt(buildPreviewCard(state)).header.title.content, /运行中…/, "没收到 output 时是运行中");
  state = applyEvent(state, toolResultDone("c1", ""));
  assert.match(panelAt(buildPreviewCard(state)).header.title.content, /运行完毕/, "output 为空字符串也算运行完毕");
});

test("card：分区按 Run 真实时序排列，工具可夹在两段正文之间", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, toolCallDone("c1", "read_file", '{"path":"src/render.ts"}'));
  state = appendText(state, "先看渲染器");
  state = applyEvent(state, toolCallDone("c2", "exec_command", '{"command":"pnpm test"}'));
  state = appendText(state, "再跑测试");
  const card = buildPreviewCard(state);
  // 思考与第一次工具调用相邻 → 合成一个分组；其后的工具调用单独一步，仍是 ADR-0007 的单面板
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["collapsible_panel", "markdown", "collapsible_panel", "markdown"],
  );
  assert.equal(markdownAt(card, 1), "先看渲染器");
  assert.equal(markdownAt(card, 3), "再跑测试");
  const group = panelAt(card, 0);
  assert.equal(group.header.title.content, "**🧰 运行中… · 2 步**");
  assert.equal(group.elements.length, 2, "组内两步各是一个嵌套面板");
  const lone = card.body.elements[2];
  assert.equal(lone?.tag, "collapsible_panel");
  if (lone?.tag !== "collapsible_panel") return;
  assert.equal(lone.header.title.content, '**🔧 exec_command · 运行中…** · `{"command":"pnpm test"}`');
});

test("card：连续的思考与工具分区合并成一个分组面板，组内每步一个嵌套面板，全部默认收起", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDone("先想一下", "2026-10-21T10:00:04.230Z"));
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}', "2026-10-21T10:00:04.500Z"));
  state = applyEvent(state, toolResultDone("c1", "a.ts\nb.ts", "2026-10-21T10:00:05.700Z"));
  const card = buildRunCard({ status: "completed", text: "答完了", usage: { total: 1 } }, state);
  // 一个分组面板 + 正文 + 页脚；组内两步各是一个嵌套面板
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["collapsible_panel", "markdown", "hr", "markdown"],
  );
  const group = panelAt(card);
  assert.equal(group.expanded, false, "分组默认收起");
  assert.equal(group.header.title.content, "**🧰 运行完毕 · 2 步 · 5.7s**", "组耗时 = 组内最后事件时间 − 第一个事件时间");
  assert.equal(group.elements.length, 2, "组内两步");
  const steps = group.elements;
  const thoughtStep = steps[0];
  const toolStep = steps[1];
  assert.equal(thoughtStep?.tag, "collapsible_panel");
  assert.equal(toolStep?.tag, "collapsible_panel");
  if (thoughtStep?.tag !== "collapsible_panel" || toolStep?.tag !== "collapsible_panel") return;
  assert.equal(thoughtStep.expanded, false, "组内每步同样默认收起");
  assert.equal(toolStep.expanded, false);
  assert.equal(thoughtStep.header.title.content, "**🧠 思考 · 运行完毕 · 4 字 · 4.2s**", "思考步标题沿用 ADR-0007");
  assert.equal(toolStep.header.title.content, '**🔧 exec_command · 运行完毕 · 1.2s** · `{"command":"ls"}`');
  assert.deepEqual(thoughtStep.elements, [{ tag: "markdown", content: "```\n先想一下\n```", text_size: "notation" }]);
  assert.ok(panelContent(toolStep).includes("a.ts"), "工具步面板内容是参数与输出围栏块");
});

test("card：预览期分组标题只报「🧰 运行中… · N 步」，不定终态", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}', "2026-10-21T10:00:04.500Z"));
  state = applyEvent(state, toolResultDone("c1", "a.ts", "2026-10-21T10:00:05.700Z"));
  // 哪怕两步都已闭合，Run 没结束就不标「运行完毕」
  assert.equal(panelAt(buildPreviewCard(state)).header.title.content, "**🧰 运行中… · 2 步**");
});

test("card：定稿时组内有步未闭合，分组标题只写「🧰 N 步」——不标状态、不给耗时，不谎报完毕", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDone("先想一下", "2026-10-21T10:00:04.230Z"));
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}', "2026-10-21T10:00:04.500Z"));
  const card = buildRunCard({ status: "completed", text: "答完了", usage: null }, state);
  assert.equal(panelAt(card).header.title.content, "**🧰 2 步**");
});

test("card：组耗时按组内全部事件时间算，孤儿结果的 endedAt 也计入首末跨度", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDone("先想一下", "2026-10-21T10:00:01.000Z"));
  state = applyEvent(state, toolResultDone("c9", "迟到的输出", "2026-10-21T10:00:05.000Z"));
  const card = buildRunCard({ status: "completed", text: "答完了", usage: null }, state);
  assert.equal(panelAt(card).header.title.content, "**🧰 运行完毕 · 2 步 · 5.0s**", "10:00:00 → 10:00:05");
});

test("card：text 与 notice 分区打断分组，组在它们之间断开", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("甲", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = appendText(state, "中间夹一段正文");
  state = applyEvent(state, toolCallDone("c2", "read_file", '{"path":"a.ts"}'));
  state = applyEvent(state, thinkingDelta("乙", "2026-10-21T10:00:05.000Z"));
  const card = buildPreviewCard(state);
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["collapsible_panel", "markdown", "collapsible_panel"],
    "正文把前后两组断开，各自成组",
  );
  assert.equal(panelAt(card, 0).header.title.content, "**🧰 运行中… · 2 步**");
  assert.equal(topPanels(card)[1]?.header.title.content, "**🧰 运行中… · 2 步**");
  assert.equal(markdownAt(card, 1), "中间夹一段正文");
});

test("card：提示分区（notice）也打断分组", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("甲", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, toolCallDone("c1", "exec_command"));
  state = applyEvent(state, { type: "compaction.started" });
  state = applyEvent(state, toolCallDone("c2", "read_file"));
  state = applyEvent(state, thinkingDelta("乙", "2026-10-21T10:00:05.000Z"));
  const card = buildPreviewCard(state);
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["collapsible_panel", "markdown", "collapsible_panel"],
  );
  assert.equal(markdownAt(card, 1), "🗜️ 正在压缩上下文…");
});

test("card：工具步标题带耗时；孤儿结果没有 startedAt，标题不给耗时（缺起点不编造）", () => {
  let state = emptyPreview();
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}', "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, toolResultDone("c1", "a.ts", "2026-10-21T10:00:02.500Z"));
  assert.equal(
    panelAt(buildPreviewCard(state)).header.title.content,
    '**🔧 exec_command · 运行完毕 · 2.5s** · `{"command":"ls"}`',
  );
  const orphan = applyEvent(emptyPreview(), toolResultDone("c9", "孤儿输出", "2026-10-21T10:00:02.000Z"));
  assert.equal(panelAt(buildPreviewCard(orphan)).header.title.content, "**🔧 工具 · 运行完毕**");
});

test("card：定稿分区与文本定稿同源，答案不丢", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = appendText(state, "第一部");
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = appendText(state, "全部完成");
  const card = buildRunCard({ status: "completed", text: "第一部\n\n全部完成", usage: { total: 42 } }, state);
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["collapsible_panel", "markdown", "collapsible_panel", "markdown", "hr", "markdown"],
  );
  assert.equal(markdownAt(card, 1), "第一部");
  assert.equal(markdownAt(card, 3), "全部完成");
  assert.equal(footerOf(card), "用量 42 tokens");
});

test("card：定稿改用 outcome 的权威全文时，旧正文分区被换成新的一段", () => {
  const state = appendText(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", '{"command":"ls"}')), "流式里的旧文本");
  const card = buildRunCard({ status: "completed", text: "最终答案", usage: { total: 42 } }, state);
  assert.ok(!hasText(card, "流式里的旧文本"), "旧正文分区应被删掉");
  assert.ok(hasText(card, "最终答案"), "outcome 的权威全文要出现");
  assert.equal(panelAt(card).header.title.content, '**🔧 exec_command · 运行中…** · `{"command":"ls"}`', "工具分区保留");
});

test("card：outcome 没有正文且没有流式正文时给出占位说明", () => {
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command"));
  const card = buildRunCard({ status: "completed", text: "   ", usage: null }, state);
  assert.ok(hasText(card, "（本轮没有文本输出）"), "应有占位说明");
  assert.equal(footerOf(card), "用量未知");
});

test("card：多个分区合计超预算时从最中间整块丢弃并标注，最后一个分区保留", () => {
  const pieces = Array.from({ length: 60 }, (_, i) => `第 ${i} 段：${"甲".repeat(380)}`);
  let state = emptyPreview();
  for (const piece of pieces) state = appendText(state, piece);
  const card = buildPreviewCard(state);
  assert.ok(JSON.stringify(card).length <= CARD_BUDGET_CHARS, `实际 ${JSON.stringify(card).length}`);
  assert.ok(card.body.elements.length <= 200, `元素数 ${card.body.elements.length}`);
  const markers = card.body.elements.filter(
    (element) => element.tag === "markdown" && /……（中间省略 \d+ 个分区）……/.test(element.content),
  );
  assert.equal(markers.length, 1, "应有且仅有一条丢弃标注");
  const markerIndex = card.body.elements.indexOf(markers[0]!);
  assert.ok(markerIndex > 0 && markerIndex < card.body.elements.length - 1, "标注应插在幸存头尾之间，不在队尾");
  assert.equal(markdownAt(card, 0), pieces[0], "开头分区要留下");
  assert.ok(hasText(card, pieces.at(-1) ?? ""), "最后一个分区（最终答案）永不整块丢");
  const middle = pieces[30];
  assert.ok(middle !== undefined);
  assert.ok(!hasText(card, middle), "最中间的分区被整块丢弃");
});

test("card：单个分区超大时内容首尾对半砍并标注省略字数，仍不超预算", () => {
  const answer = "答".repeat(60000);
  const card = buildRunCard({ status: "completed", text: answer, usage: { total: 1 } }, appendText(emptyPreview(), answer));
  assert.ok(JSON.stringify(card).length <= CARD_BUDGET_CHARS, `实际 ${JSON.stringify(card).length}`);
  const content = markdownAt(card, 0);
  assert.match(content, /…（中间省略 \d+ 字）…/);
  assert.ok(content.startsWith("答"), "开头要留下");
  assert.ok(content.endsWith("答"), "结尾要留下");
});

test("card：分区数超过飞书单卡 200 元素上限时继续丢分区", () => {
  let state = emptyPreview();
  for (let i = 0; i < 300; i += 1) state = appendText(state, `第 ${i} 段`);
  const card = buildPreviewCard(state);
  assert.ok(card.body.elements.length <= 200, `实际 ${card.body.elements.length}`);
  assert.ok(
    card.body.elements.some(
      (element) => element.tag === "markdown" && /……（中间省略 \d+ 个分区）……/.test(element.content),
    ),
    "应有丢弃标注",
  );
});

test("card：超预算时优先整块丢弃思考面板，正文与工具面板保住", () => {
  // 6 段思考（各顶满 2000 字上限）+ 6 段正文，合计远超 20KB 预算。
  // 同权丢弃会从最中间开始连正文一起丢；优先丢思考则应正文全留、思考成片消失。
  let state = emptyPreview();
  for (let i = 0; i < 6; i += 1) {
    state = applyEvent(state, thinkingDone("甲".repeat(2000), `2026-10-21T10:00:0${i}Z.000Z`));
    state = appendText(state, "乙".repeat(2500));
  }
  const card = buildPreviewCard(state);
  assert.ok(JSON.stringify(card).length <= CARD_BUDGET_CHARS, `实际 ${JSON.stringify(card).length}`);
  assert.ok(panelsOf(card).length < 6, "思考面板应被优先丢弃");
  assert.equal(
    card.body.elements.filter((element) => element.tag === "markdown" && element.content === "乙".repeat(2500)).length,
    6,
    "6 段正文都不该被丢",
  );
  assert.ok(
    card.body.elements.some(
      (element) => element.tag === "markdown" && /……（中间省略 \d+ 个分区）……/.test(element.content),
    ),
    "应有丢弃标注",
  );
});

test("card：超预算时整组丢弃，丢弃标注按组内真实分区数计（一个组含多个分区时不计组数）", () => {
  // 5 组、每组 3 步（思考 + 工具 + 思考），组间夹短正文；合计远超 20KB 预算。
  let state = emptyPreview();
  for (let i = 0; i < 5; i += 1) {
    const at = (second: number): string => `2026-10-21T10:00:${String(second).padStart(2, "0")}.000Z`;
    state = applyEvent(state, thinkingDone("甲".repeat(2000), at(i * 10)));
    state = applyEvent(state, toolCallDone(`c${i}`, "exec_command", '{"command":"ls"}', at(i * 10 + 1)));
    state = applyEvent(state, toolResultDone(`c${i}`, "行".repeat(100), at(i * 10 + 2)));
    state = applyEvent(state, thinkingDone("乙".repeat(2000), at(i * 10 + 3)));
    if (i < 4) state = appendText(state, `第 ${i} 段正文`);
  }
  const card = buildPreviewCard(state);
  assert.ok(JSON.stringify(card).length <= CARD_BUDGET_CHARS, `实际 ${JSON.stringify(card).length}`);
  const markers = card.body.elements.filter(
    (element) => element.tag === "markdown" && /……（中间省略 \d+ 个分区）……/.test(element.content),
  );
  assert.equal(markers.length, 1, "应有且仅有一条丢弃标注");
  const marker = markers[0];
  assert.ok(marker !== undefined && marker.tag === "markdown");
  const droppedParts = Number(/……（中间省略 (\d+) 个分区）……/.exec(marker?.tag === "markdown" ? marker.content : "")?.[1]);
  const survivingGroups = topPanels(card).length;
  assert.ok(survivingGroups < 5, "应有组被整组丢弃");
  assert.equal(droppedParts, (5 - survivingGroups) * 3, "标注按真实分区数（每组 3 步）累计，不按组数");
  for (let i = 0; i < 4; i += 1) assert.ok(hasText(card, `第 ${i} 段正文`), "分组是细节，正文不被丢");
});

test("card：分组嵌套计入元素个数，超飞书 200 元素上限时继续丢组", () => {
  // 100 组、每组「思考 + 工具」两步：每组 5 个元素（组面板 + 2 个步面板 + 2 个内容 markdown）。
  let state = emptyPreview();
  for (let i = 0; i < 100; i += 1) {
    state = applyEvent(state, thinkingDone("想", "2026-10-21T10:00:00.000Z"));
    state = applyEvent(state, toolCallDone(`c${i}`, "exec_command", '{"command":"ls"}'));
    if (i % 5 === 4) state = appendText(state, `第 ${i} 段`);
  }
  const card = buildPreviewCard(state);
  assert.ok(JSON.stringify(card).length <= CARD_BUDGET_CHARS, `实际 ${JSON.stringify(card).length}`);
  assert.ok(countAll(card.body.elements) <= 200, `递归元素数 ${countAll(card.body.elements)}`);
  assert.ok(
    card.body.elements.some(
      (element) => element.tag === "markdown" && /……（中间省略 \d+ 个分区）……/.test(element.content),
    ),
    "应有丢弃标注",
  );
});

test("card：连头尾都放不下时，组面板内容按占比分摊预算、递归截断到最内层 markdown", () => {
  let state = emptyPreview();
  for (let i = 0; i < 5; i += 1) state = applyEvent(state, thinkingDone("甲".repeat(2000), `2026-10-21T10:00:0${i}.000Z`));
  state = appendText(state, "答".repeat(60000));
  const card = buildRunCard({ status: "completed", text: "答".repeat(60000), usage: { total: 1 } }, state);
  assert.ok(JSON.stringify(card).length <= CARD_BUDGET_CHARS, `实际 ${JSON.stringify(card).length}`);
  const group = panelAt(card);
  assert.equal(group.elements.length, 5, "5 步思考都在组里");
  for (const step of group.elements) {
    if (step.tag !== "collapsible_panel") throw new Error("组内应是嵌套面板");
    assert.match(panelContent(step), /…（中间省略 \d+ 字）…/, "最内层 markdown 被递归截断");
  }
  assert.match(markdownAt(card, 1), /…（中间省略 \d+ 字）…/, "结尾正文同样段内截断");
});

test("card：五种卡片都能 JSON.stringify 往返", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = appendText(state, "正文");
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = applyEvent(state, toolResultDone("c1", "a.ts"));
  const cards: RunCard[] = [
    placeholderCard(),
    buildPreviewCard(state),
    buildRunCard({ status: "completed", text: "正文", usage: { total: 3 } }, state),
    buildRunCard(
      { status: "aborted", text: "正文", error: { code: "user_abort", message: "用户中断" }, usage: null },
      state,
    ),
    errorCard("执行失败：会话准备失败"),
  ];
  for (const card of cards) {
    assert.deepEqual(JSON.parse(JSON.stringify(card)), card, "序列化往返应保持一致");
  }
});

test("card：元素只带 Card 2.0 允许的字段", () => {
  let state = emptyPreview();
  state = appendText(state, "正文");
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = applyEvent(state, toolResultDone("c1", "a.ts"));
  const card = buildRunCard({ status: "completed", text: "正文", usage: { total: 1 } }, state);
  const allowed: Record<string, readonly string[]> = {
    markdown: ["tag", "content", "text_size"],
    hr: ["tag"],
    collapsible_panel: ["tag", "expanded", "header", "elements"],
  };
  for (const element of card.body.elements) {
    for (const key of Object.keys(element)) {
      assert.ok(allowed[element.tag]?.includes(key), `${element.tag} 不该有字段 ${key}`);
    }
  }
  const panel = panelAt(card);
  assert.deepEqual(Object.keys(panel.header.title).sort(), ["content", "tag"]);
  assert.deepEqual(Object.keys(panel.elements[0] ?? {}).sort(), ["content", "tag", "text_size"]);
});
