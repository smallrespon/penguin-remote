import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLACEHOLDER_TEXT,
  RunPreview,
  applyEvent,
  emptyPreview,
  formatFinalText,
  renderPreview,
  shouldFlush,
  type PreviewOptions,
} from "../src/render.js";
import { executeRun } from "../src/penguin/runner.js";
import { createLogger } from "../src/logger.js";
import type { OutboundMessage } from "../src/channels/types.js";
import { FakeChannel } from "./helpers/fake-channel.js";
import { flatText } from "./helpers/flat-text.js";
import { FakeSessionServer, frame, sessionClient, waitForTask } from "./helpers/fake-sessions.js";
import type { RunEvent } from "../src/run-event.js";

// 单元测试用的事件构造器（旧 AMSP fake 的同款形态，现在直接用 Bridge 自有事件）。
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

const OPTIONS: PreviewOptions = { throttleMs: 1500, throttleChars: 300, maxChars: 3500 };

const silent = createLogger("error", () => {});

test("render：text.delta 追加到最后一个未收尾的正文分区", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("现在"));
  state = applyEvent(state, textDelta("八点"));
  assert.deepEqual(state.parts, [{ kind: "text", text: "现在八点" }]);
  assert.equal(renderPreview(state, OPTIONS), "现在八点");
});

test("render：text.done 用权威全文替换未收尾的正文分区", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("现在"));
  state = applyEvent(state, textDone("现在是二十点整"));
  assert.deepEqual(state.parts, [{ kind: "text", text: "现在是二十点整", done: true }]);
  assert.equal(renderPreview(state, OPTIONS), "现在是二十点整");
});

test("render：text.done 前面没有未收尾正文时新建一个已收尾分区", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDone("第一段"));
  state = applyEvent(state, textDone("第二段"));
  assert.deepEqual(state.parts, [
    { kind: "text", text: "第一段", done: true },
    { kind: "text", text: "第二段", done: true },
  ]);
  assert.equal(renderPreview(state, OPTIONS), "第一段\n\n第二段");
});

test("render：thinking.delta 累加进同一个思考分区，done 用事件时间闭合", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDelta("一下", "2026-10-21T10:00:01.000Z"));
  state = applyEvent(state, thinkingDone("先想一下", "2026-10-21T10:00:04.230Z"));
  assert.deepEqual(state.parts, [
    { kind: "thought", chars: 4, startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:00:04.230Z" },
  ]);
});

test("render：thinking.done 的 thinking 为空时保留累加的字符数", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("想", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDone("", "2026-10-21T10:00:02.000Z"));
  assert.deepEqual(state.parts, [
    { kind: "thought", chars: 1, startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:00:02.000Z" },
  ]);
});

test("render：思考分区已闭合后新的思考另起一个分区", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("甲", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, thinkingDone("甲", "2026-10-21T10:00:01.000Z"));
  state = applyEvent(state, thinkingDelta("乙", "2026-10-21T10:00:02.000Z"));
  assert.deepEqual(state.parts, [
    { kind: "thought", chars: 1, startedAt: "2026-10-21T10:00:00.000Z", endedAt: "2026-10-21T10:00:01.000Z" },
    { kind: "thought", chars: 1, startedAt: "2026-10-21T10:00:02.000Z" },
  ]);
});

test("render：没有未闭合思考分区时 thinking.done 追加一个零耗时分区", () => {
  const state = applyEvent(emptyPreview(), thinkingDone("整段思考", "2026-10-21T10:00:03.000Z"));
  assert.deepEqual(state.parts, [
    {
      kind: "thought",
      chars: 4,
      startedAt: "2026-10-21T10:00:03.000Z",
      endedAt: "2026-10-21T10:00:03.000Z",
    },
  ]);
});

test("render：tool_call.done 记下 id 与名称，参数压空白后截断到 80 字", () => {
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", `{"command":"${"x".repeat(100)}"}`));
  const part = state.parts.at(-1);
  assert.equal(part?.kind, "tool");
  if (part?.kind !== "tool") return;
  assert.equal(part.id, "c1");
  assert.equal(part.name, "exec_command");
  assert.equal(part.args, `{"command":"${"x".repeat(68)}…`);
});

test("render：tool_call.done 的参数里的密钥被打码", () => {
  const state = applyEvent(
    emptyPreview(),
    toolCallDone("c1", "exec_command", '{"token":"penguin_abcdef123456","command":"ls"}'),
  );
  const part = state.parts.at(-1);
  assert.equal(part?.kind, "tool");
  if (part?.kind !== "tool") return;
  assert.equal(part.args, '{"token":"penguin_***","command":"ls"}');
});

test("render：tool_call.done 完整落在截断范围内的密钥被打码成 penguin_***", () => {
  const state = applyEvent(
    emptyPreview(),
    toolCallDone("c1", "exec_command", `{"token":"penguin_abcdef123456","command":"${"x".repeat(100)}"}`),
  );
  const part = state.parts.at(-1);
  assert.equal(part?.kind, "tool");
  if (part?.kind !== "tool") return;
  assert.ok(part.args?.includes("penguin_***"), `密钥应被打码：${part.args}`);
  assert.ok(!part.args?.includes("abcdef123456"), `密钥本体泄漏：${part.args}`);
});

test("render：tool_call.done 先脱敏再截断，跨 80 字切口的密钥不漏片段", () => {
  // 密钥起点在切口之前：若先截断，只会留下 "penguin_sup" 这种不完整片段，redact 的正则匹配不到。
  const args = `{"x":"${"x".repeat(52)}","token":"penguin_supersecret"}`;
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", args));
  const part = state.parts.at(-1);
  assert.equal(part?.kind, "tool");
  if (part?.kind !== "tool") return;
  assert.ok(!part.args?.includes("supersecret"), `密钥本体泄漏：${part.args}`);
  assert.doesNotMatch(part.args ?? "", /penguin_[A-Za-z0-9_-]/, `密钥片段泄漏：${part.args}`);
  assert.ok(part.args?.includes("penguin_***"), `打码标记应完整可见：${part.args}`);
});

test("render：tool_call.done 参数为空时不记 args", () => {
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command", ""));
  const part = state.parts.at(-1);
  assert.deepEqual(part, { kind: "tool", id: "c1", name: "exec_command" });
});

test("render：tool_result.done 回填到最后一个同 id 且没有输出的工具分区", () => {
  let state = emptyPreview();
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = applyEvent(state, toolCallDone("c2", "read_file", '{"path":"a.ts"}'));
  state = applyEvent(state, toolResultDone("c1", "a.ts\nb.ts"));
  assert.deepEqual(state.parts, [
    { kind: "tool", id: "c1", name: "exec_command", args: '{"command":"ls"}', output: "a.ts\nb.ts" },
    { kind: "tool", id: "c2", name: "read_file", args: '{"path":"a.ts"}' },
  ]);
});

test("render：tool_result.done 找不到对应调用时追加一个通用工具分区", () => {
  const state = applyEvent(emptyPreview(), toolResultDone("c9", "孤儿输出"));
  assert.deepEqual(state.parts, [{ kind: "tool", id: "c9", name: "工具", output: "孤儿输出" }]);
});

test("render：审批与压缩提示按事件顺序落成提示分区", () => {
  let state = emptyPreview();
  state = applyEvent(state, {
    type: "approval.requested",
    tool_call: { tool_call_id: "c1", name: "exec_command", arguments: '{"command":"rm -rf /"}' },
  });
  state = applyEvent(state, { type: "compaction.started" });
  assert.deepEqual(state.parts, [
    { kind: "notice", text: "⚠️ 等待审批：`exec_command`" },
    { kind: "notice", text: "🗜️ 正在压缩上下文…" },
  ]);
  assert.equal(
    renderPreview(state, OPTIONS),
    "⚠️ 等待审批：`exec_command`\n\n🗜️ 正在压缩上下文…",
  );
});

test("render：回复分区按 Run 真实时序渲染，工具可夹在两段正文之间", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, toolCallDone("c1", "read_file", '{"path":"src/render.ts"}'));
  state = applyEvent(state, textDelta("先看渲染器"));
  state = applyEvent(state, textDone("先看渲染器"));
  state = applyEvent(state, toolCallDone("c2", "exec_command", '{"command":"pnpm test"}'));
  state = applyEvent(state, textDelta("再跑测试"));
  state = applyEvent(state, textDone("再跑测试"));
  const markdown = renderPreview(state, OPTIONS);
  const at = (needle: string): number => {
    const index = markdown.indexOf(needle);
    assert.ok(index >= 0, `渲染结果里应出现 ${needle}：\n${markdown}`);
    return index;
  };
  assert.ok(at("🧠 思考中…（4 字）") < at("read_file"), "思考分区在最前");
  assert.ok(at("read_file") < at("先看渲染器"), "第一次工具调用在第一段正文之前");
  assert.ok(at("先看渲染器") < at("exec_command"), "第一段正文在第二次工具调用之前");
  assert.ok(at("exec_command") < at("再跑测试"), "工具调用夹在两段正文之间");
});

test("render：思考分区流式显示「思考中」，定稿显示耗时（毫秒精度）", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  assert.match(renderPreview(state, OPTIONS), /^\*\*🧠 思考中…（4 字）\*\*$/m);
  state = applyEvent(state, thinkingDone("先想一下", "2026-10-21T10:00:04.230Z"));
  assert.match(renderPreview(state, OPTIONS), /^\*\*🧠 思考 · 4 字 · 4\.2s\*\*$/m);
});

test("render：工具分区输出走围栏代码块，参数里的反引号换成单引号", () => {
  const state = applyEvent(
    emptyPreview(),
    toolCallDone("c1", "exec_command", '{"command":"echo `hi`"}'),
  );
  const state2 = applyEvent(state, toolResultDone("c1", "hi\n再见"));
  assert.equal(
    renderPreview(state2, OPTIONS),
    ["**🔧 exec_command**", "`{\"command\":\"echo 'hi'\"}`", "output:", "```", "hi", "再见", "```"].join("\n"),
  );
});

test("render：工具输出按行保留末尾 8 行，超出行数时标注", () => {
  const output = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  const markdown = renderPreview(state, OPTIONS);
  assert.ok(markdown.includes("第 20 行"), "末尾行要留下");
  assert.ok(!markdown.includes("第 12 行"), "第 12 行应被丢掉");
  assert.ok(markdown.includes("第 13 行"), "第 13 行是末尾 8 行的第一行");
  assert.match(markdown, /（已截断，共 20 行，显示末尾 8 行）/);
});

test("render：工具输出每行截到 100 字符", () => {
  const output = `短行\n${"x".repeat(150)}`;
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  const markdown = renderPreview(state, OPTIONS);
  assert.ok(markdown.includes(`\n${"x".repeat(100)}…\n`), "长行应截到 100 字符再加省略号");
});

test("render：工具输出自带 ``` 时围栏加到四反引号", () => {
  const output = "```\nconst a = 1;\n```";
  const state = applyEvent(applyEvent(emptyPreview(), toolCallDone("c1", "exec_command")), toolResultDone("c1", output));
  assert.ok(renderPreview(state, OPTIONS).includes("````\n```\nconst a = 1;\n```\n````"));
});

test("render：单个正文段超过 maxChars 时首尾保留、中间标注省略", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("a".repeat(4000)));
  const markdown = renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: 1000 });
  assert.ok(markdown.length <= 1000 + 40, `实际 ${markdown.length}`);
  assert.match(markdown, /中间省略 \d+ 字/);
});

test("render：思考分区加超长正文时总长受控，正文不被整体丢弃", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, textDelta("答".repeat(3600)));
  const markdown = renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: 3500 });
  assert.ok(markdown.length <= 3510, `总长应受控，实际 ${markdown.length}`);
  assert.match(markdown, /🧠 思考/, "思考标签要保留");
  const bodyChars = (markdown.match(/答/g) ?? []).length;
  assert.ok(bodyChars >= 1000, `正文应大段残留，实际 ${bodyChars}`);
});

test("render：多个分区合计超过 maxChars 时从中间整块丢弃并标注", () => {
  let state = emptyPreview();
  for (const piece of ["甲".repeat(400), "乙".repeat(400), "丙".repeat(400), "丁".repeat(400)]) {
    state = applyEvent(state, textDelta(piece));
    state = applyEvent(state, textDone(piece));
  }
  const markdown = renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: 1300 });
  assert.ok(markdown.length <= 1300, `实际 ${markdown.length}`);
  assert.match(markdown, /……（中间省略 1 个分区）……/);
  assert.ok(markdown.includes("甲".repeat(400)), "开头分区要留下");
  assert.ok(markdown.includes("乙".repeat(400)), "靠前的分区要留下");
  assert.ok(!markdown.includes("丙".repeat(400)), "最中间的分区被整块丢弃");
  assert.ok(markdown.includes("丁".repeat(400)), "结尾分区要留下");
});

test("render：预算再紧就继续丢分区，直到只保得住头尾", () => {
  let state = emptyPreview();
  for (const piece of ["一".repeat(200), "二".repeat(200), "三".repeat(200), "四".repeat(200), "五".repeat(200), "六".repeat(200)]) {
    state = applyEvent(state, textDelta(piece));
    state = applyEvent(state, textDone(piece));
  }
  const markdown = renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: 500 });
  assert.ok(markdown.length <= 500, `实际 ${markdown.length}`);
  assert.match(markdown, /……（中间省略 4 个分区）……/);
  assert.ok(markdown.startsWith("一".repeat(200)), "开头分区要留下");
  assert.ok(markdown.endsWith("六".repeat(200)), "结尾分区要留下");
  assert.ok(!markdown.includes("三".repeat(200)), "中间分区被整块丢弃");
});

test("render：节流——时间未到且增量不足时不必编辑", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("短"));
  const last = { at: 1000, chars: 0 };
  assert.equal(shouldFlush(state, last, 1200, OPTIONS), false, "1.5s 内且增量 <300 字");
  assert.equal(shouldFlush(state, last, 2500, OPTIONS), true, "超过 1.5s");
  const big = applyEvent(state, textDelta("y".repeat(400)));
  assert.equal(shouldFlush(big, last, 1100, OPTIONS), true, "增量 ≥300 字");
});

test("render：空状态不值得编辑", () => {
  assert.equal(shouldFlush(emptyPreview(), { at: 0, chars: 0 }, 999_999, OPTIONS), false);
});

test("render：RunPreview 累积事件、按节流吐 markdown，并给出定稿快照", () => {
  const preview = new RunPreview(OPTIONS);
  assert.equal(preview.due(999_999), false, "还没有任何分区");
  preview.update(textDelta("现在"));
  assert.equal(preview.due(100), false, "1.5s 内且增量不足");
  assert.equal(preview.due(2000), true, "超过 1.5s");
  preview.noteFlushed(2000);
  assert.equal(preview.due(2100), false, "刚 flush 过，增量也没涨");
  assert.equal(preview.markdown(), "现在");
  assert.deepEqual(preview.snapshot(), { parts: [{ kind: "text", text: "现在" }] });
  preview.addNotice("🗜️ 正在压缩上下文…");
  assert.deepEqual(preview.snapshot().parts.at(-1), { kind: "notice", text: "🗜️ 正在压缩上下文…" });
});

test("formatFinalText：累积正文与 outcome 一致时按分区原样定稿", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("先想一下", "2026-10-21T10:00:00.000Z"));
  state = applyEvent(state, textDelta("第一部"));
  state = applyEvent(state, textDone("第一部"));
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = applyEvent(state, textDelta("全部完成"));
  state = applyEvent(state, textDone("全部完成"));
  const text = formatFinalText({ status: "completed", text: "第一部\n\n全部完成", usage: { total: 42 } }, state);
  assert.match(text, /\*\*🧠 思考 · 4 字\*\*/, "未闭合的思考段按已闭合样式显示，且省去耗时");
  assert.match(text, /\*\*🔧 exec_command\*\*/);
  assert.ok(text.indexOf("第一部") < text.indexOf("全部完成"), "两段正文都在，且保持时序");
  assert.match(text, /\n\n---\n用量 42 tokens$/);
});

test("formatFinalText：累积正文与 outcome 不一致时改用 outcome 的单段正文", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("流式里的旧文本"));
  state = applyEvent(state, textDone("流式里的旧文本"));
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  const text = formatFinalText({ status: "completed", text: "最终答案", usage: { total: 42 } }, state);
  assert.ok(!text.includes("流式里的旧文本"), "旧正文分区应被删掉");
  assert.match(text, /\*\*🔧 exec_command\*\*/, "工具分区保留");
  assert.match(text, /最终答案\n\n---\n用量 42 tokens$/);
});

test("formatFinalText：outcome 没有正文且没有流式正文时给出占位说明", () => {
  const state = applyEvent(emptyPreview(), toolCallDone("c1", "exec_command"));
  const text = formatFinalText({ status: "completed", text: "   ", usage: null }, state);
  assert.match(text, /（本轮没有文本输出）\n\n---\n用量未知$/);
});

test("formatFinalText：outcome 没有正文时保留流式累积的正文（中断场景）", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("写到了一半"));
  const text = formatFinalText({ status: "aborted", text: "", usage: null }, state);
  assert.match(text, /写到了一半/);
  assert.ok(!text.includes("（本轮没有文本输出）"));
});

test("formatFinalText：比较正文时忽略空白差异", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("第一行\n  第二行"));
  state = applyEvent(state, textDone("第一行\n  第二行"));
  const text = formatFinalText({ status: "completed", text: "第一行 第二行", usage: { total: 1 } }, state);
  assert.match(text, /第一行\n {2}第二行/, "只有空白差异时保留分区原样");
});

test("formatFinalText：未正常完成时页脚带上状态与原因", () => {
  const state = applyEvent(emptyPreview(), textDone("做到一半"));
  const text = formatFinalText(
    { status: "aborted", text: "做到一半", error: { code: "user_abort", message: "用户中断" }, usage: { total: 7 } },
    state,
  );
  assert.match(text, /做到一半\n\n---\n未正常完成（aborted）：用户中断\n用量 7 tokens$/);
});

// ---- 集成：runner + 会话 API 假服务器（原 AMSP 版移植，ADR-0005） ----

const AGENT = { projectId: "default_project", agentId: "default_agent" };

/** 等 Bridge 把任务投递出去（此刻订阅已就绪），返回会话 id。 */
async function startedSession(server: FakeSessionServer): Promise<string> {
  return waitForTask(server);
}

/** 收尾三件套 + 流终止。 */
function finish(server: FakeSessionServer, sessionId: string, finalText: string): void {
  server.pushLive(sessionId, frame.omni({ type: "text", role: "assistant", text: finalText, stop_reason: "completed" }));
  server.pushLive(sessionId, frame.event({ type: "token_usage", request: { total: 42 }, session: { total: 42 } }));
  server.pushLive(sessionId, frame.event({ type: "request_end", status: "completed" }));
  server.pushLive(sessionId, frame.taskState("idle"));
  server.pushLive(sessionId, frame.done());
}

function startRun(server: FakeSessionServer, channel: FakeChannel) {
  return executeRun(
    { channel, logger: silent },
    {
      chatId: "oc_1",
      input: "长任务",
      agent: AGENT,
      sessionId: null,
      client: sessionClient(server),
      preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
    },
  );
}

test("流式预览：Run 过程中按节流编辑占位消息，最终定稿一次", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const report = startRun(server, channel);
  const sessionId = await startedSession(server);

  server.pushLive(sessionId, frame.taskState("running"));
  server.pushLive(sessionId, frame.omni({ type: "partial_thinking", role: "assistant", event_type: "delta", thinking: "先想一下" }));
  await tick();
  server.pushLive(sessionId, frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "第一部" }));
  await tick();
  server.pushLive(sessionId, frame.omni({ type: "tool_call", role: "assistant", name: "exec_command", arguments: '{"command":"ls"}', tool_call_id: "c1" }));
  await tick();
  server.pushLive(sessionId, frame.omni({ type: "tool_call_output", role: "user", output: "输出", tool_call_id: "c1" }));
  await tick();
  finish(server, sessionId, "全部完成");
  await report;

  assert.equal(channel.sent.length, 1);
  assert.equal(flatText(channel.sent[0]?.message ?? { kind: "text", text: "" }), PLACEHOLDER_TEXT);
  assert.ok(channel.edited.length >= 4, `应有多次增量编辑，实际 ${channel.edited.length}`);
  assert.match(flatText(channel.edited.at(-1)?.message ?? { kind: "text", text: "" }), /全部完成/);
  assert.match(flatText(channel.edited.at(-1)?.message ?? { kind: "text", text: "" }), /用量 42 tokens/);
  // 中间某次编辑应包含思考行与工具行
  assert.ok(channel.edited.some((e) => /\*\*🧠 思考中…（4 字）\*\*/.test(flatText(e.message))));
  assert.ok(channel.edited.some((e) => /\*\*🔧 exec_command\*\*/.test(flatText(e.message))));
});

/**
 * 编辑快慢不一的 Channel：预览编辑慢、定稿编辑快。
 * 真实飞书里每次更新是一次独立的 lark-cli 调用，耗时不稳——在途的预览更新
 * 完全可能比后发出的定稿更新更晚落地，把定稿盖掉。
 */
class UnfairEditChannel extends FakeChannel {
  override async edit(messageId: string, message: OutboundMessage): Promise<void> {
    const delay = flatText(message).includes("用量") ? 0 : 60;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    await super.edit(messageId, message);
  }
}

test("流式预览：在途的预览编辑不得盖掉定稿（晚到的编辑被作废）", async () => {
  const server = new FakeSessionServer();
  const channel = new UnfairEditChannel();
  const report = startRun(server, channel);
  const sessionId = await startedSession(server);
  server.pushLive(sessionId, frame.taskState("running"));
  // 连续推事件：每次都排队一次（慢速）预览编辑，收尾时它们还在飞行中
  for (const piece of ["第一段", "第二段", "第三段"]) {
    server.pushLive(sessionId, frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: piece }));
  }
  finish(server, sessionId, "最终答案");
  await report;
  // 故意多等一会：让任何还在飞行中的预览编辑先落地，再看谁排在最后
  await new Promise((resolve) => setTimeout(resolve, 250));

  const last = channel.edited.at(-1);
  assert.match(flatText(last?.message ?? { kind: "text", text: "" }), /最终答案/, "最后一次编辑必须是定稿");
  assert.match(flatText(last?.message ?? { kind: "text", text: "" }), /用量 42 tokens/);
  const finals = channel.edited.filter((e) => flatText(e.message).includes("用量 42 tokens"));
  assert.equal(finals.length, 1, "定稿只应写一次");
  assert.equal(finals[0]?.messageId, last?.messageId, "定稿必须是最后一次落地");
});

test("流式预览：编辑次数反复用尽时持续换新消息，定稿落在最新一条上", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  channel.editLimitPerMessage = 1;
  // 换消息续接是文本载体独有的行为（ADR-0006：卡片载体 patch 失败即放弃预览）：
  // 让占位卡片发不出去，整条 Run 走文本链路，专门覆盖续接逻辑。
  channel.failSendKinds = ["card"];
  const report = startRun(server, channel);
  const sessionId = await startedSession(server);
  server.pushLive(sessionId, frame.taskState("running"));
  for (const piece of ["第一段", "第二段", "第三段", "第四段"]) {
    server.pushLive(sessionId, frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: piece }));
    await tick();
  }
  finish(server, sessionId, "最终答案");
  await report;

  // 每条消息只允许编辑 1 次：占位 + 两次续接 + 定稿所在的那条
  assert.equal(channel.sent.length, 4, `应持续换消息续接，实际 ${channel.sent.length}`);
  const last = channel.sent.at(-1);
  const finalEdit = channel.edited.at(-1);
  // 定稿落在最新一条消息上：它还有编辑额度就编辑它，额度已用尽就作为最新一条消息直接发出
  const finalMarkdown =
    finalEdit !== undefined && finalEdit.messageId === last?.messageId
      ? flatText(finalEdit.message)
      : flatText(last?.message ?? { kind: "text", text: "" });
  assert.match(finalMarkdown, /最终答案/, "定稿应落在最新一条消息上");
  assert.match(finalMarkdown, /用量 42 tokens/, "定稿带用量页脚");
  // 每条消息都被编辑过，且编辑次数都不超过上限
  const counts = new Map<string, number>();
  for (const edit of channel.edited) counts.set(edit.messageId, (counts.get(edit.messageId) ?? 0) + 1);
  assert.ok([...counts.values()].every((n) => n <= 1), "不该有消息被编辑超过上限");
});

test("流式预览：更新从未成功过时直接降级为最终一次性发送，不白换消息", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  // 卡片承载（ADR-0006）：让卡片的更新一律失败
  channel.failEditKinds = ["card"];
  const report = startRun(server, channel);
  const sessionId = await startedSession(server);
  server.pushLive(sessionId, frame.taskState("running"));
  server.pushLive(sessionId, frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "部分" }));
  await tick();
  finish(server, sessionId, "最终答案");
  await report;

  assert.equal(channel.edited.length, 0, "更新从未成功，不该换消息白试");
  assert.equal(channel.sent.length, 2, "占位 + 降级后的总结");
  assert.match(flatText(channel.sent.at(-1)?.message ?? { kind: "text", text: "" }), /最终答案/);
});

test("流式预览：单条消息编辑次数用尽后换新消息继续，定稿落在新消息上", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  channel.editLimitPerMessage = 3;
  // 同上：换消息续接只属于文本载体，这里让占位卡片发不出去，专测文本链路。
  channel.failSendKinds = ["card"];
  const report = startRun(server, channel);
  const sessionId = await startedSession(server);
  server.pushLive(sessionId, frame.taskState("running"));
  for (const piece of ["第一段", "第二段", "第三段", "第四段"]) {
    server.pushLive(sessionId, frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: piece }));
    await tick();
  }
  finish(server, sessionId, "最终答案");
  await report;

  // 占位消息被编辑满 3 次，随后换一条新消息继续
  assert.equal(channel.sent.length, 2, "占位 + 换的新预览消息");
  const [placeholder, chained] = channel.sent;
  assert.equal(flatText(placeholder?.message ?? { kind: "text", text: "" }), PLACEHOLDER_TEXT);
  assert.match(flatText(chained?.message ?? { kind: "text", text: "" }), /第四段/, "新消息带着当前进度出现");
  const chainedId = chained?.messageId ?? "";
  assert.ok(channel.edited.some((e) => e.messageId === chainedId), "后续编辑应打到新消息上");
  // 定稿编辑在新消息上，而不是再发一条
  const finalEdit = channel.edited.at(-1);
  assert.equal(finalEdit?.messageId, chainedId);
  assert.match(flatText(finalEdit?.message ?? { kind: "text", text: "" }), /最终答案/);
  assert.match(flatText(finalEdit?.message ?? { kind: "text", text: "" }), /用量 42 tokens/);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
