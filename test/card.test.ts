import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CARD_BUDGET_CHARS,
  buildPreviewCard,
  buildRunCard,
  busyCard,
  errorCard,
  placeholderCard,
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
const toolCallDone = (id: string, name: string, args = "{}"): RunEvent => ({
  type: "tool_call.done",
  name,
  arguments: args,
  tool_call_id: id,
});
const toolResultDone = (id: string, output: string): RunEvent => ({
  type: "tool_result.done",
  output,
  tool_call_id: id,
});

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
  const content = panel.elements[0]?.content ?? "";
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
  const content = panelAt(buildPreviewCard(state)).elements[0]?.content ?? "";
  assert.ok(!content.includes("abcdef123456"), `密钥本体泄漏：${content}`);
  assert.ok(content.includes("penguin_***"), `打码标记应完整可见：${content}`);
});

test("card：思考全文自带 ``` 时围栏加长，代码块不被提前合上", () => {
  const state = applyEvent(emptyPreview(), thinkingDone("看这段\n```\nconst a = 1;\n```\n完", "2026-10-21T10:00:04.230Z"));
  const panel = panelAt(buildRunCard({ status: "completed", text: "答完了", usage: { total: 1 } }, state));
  const content = panel.elements[0]?.content ?? "";
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
  assert.equal(panel.header.title.content, '**🔧 exec_command · 运行完毕** · `{"command":"ls"}`');
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
  assert.ok(!panel.elements[0]?.content.includes("`hi`"), "面板围栏里也不该出现反引号");
});

test("card：工具输出超长时沿用 fencedOutput 的截断标注", () => {
  const output = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  const content = panelAt(buildPreviewCard(state)).elements[0]?.content ?? "";
  assert.ok(content.includes("第 20 行"), "末尾行要留下");
  assert.ok(!content.includes("第 12 行"), "第 12 行应被丢掉");
  assert.match(content, /（已截断，共 20 行，显示末尾 8 行）/);
});

test("card：工具输出自带 ``` 时围栏加长，代码块不被提前合上", () => {
  const output = "```\nconst a = 1;\n```";
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  const content = panelAt(buildPreviewCard(state)).elements[0]?.content ?? "";
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
  assert.equal(panel.header.title.content, "**🔧 exec_command · 运行完毕**");
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
  assert.deepEqual(
    card.body.elements.map((element) => element.tag),
    ["collapsible_panel", "collapsible_panel", "markdown", "collapsible_panel", "markdown"],
  );
  assert.equal(markdownAt(card, 2), "先看渲染器");
  assert.equal(markdownAt(card, 4), "再跑测试");
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
