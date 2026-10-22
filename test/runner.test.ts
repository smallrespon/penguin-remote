// runner 测试（ADR-0005 会话 API 版）：新建/续接会话、档位下发、终局文案、
// 断流即中止、审批应答、会话自愈、定稿与降级。
// 回复承载为飞书交互卡片（ADR-0006）：占位 / 预览 / 定稿三态都走卡片，
// 卡片发送或 patch 失败时退回原有文本链路——两类承载都要覆盖。

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { executeRun, type RunHandle } from "../src/penguin/runner.js";
import { createLogger } from "../src/logger.js";
import { BUSY_HINT, PLACEHOLDER_TEXT } from "../src/render.js";
import type { OutboundMessage } from "../src/channels/types.js";
import { busyCard, errorCard, placeholderCard } from "../src/card.js";
import { FakeSessionServer, frame, sessionClient } from "./helpers/fake-sessions.js";
import { cardOf, flatText, footerOf, panelsOf } from "./helpers/card-shape.js";
import { textOf } from "./helpers/flat-text.js";
import { FakeChannel } from "./helpers/fake-channel.js";
import { waitFor } from "./helpers/wait.js";

const silent = createLogger("error", () => {});

const AGENT = { projectId: "default_project", agentId: "default_agent" };

/** 最后一次编辑的文本（没有编辑过时为空串）。 */
function lastEditedText(channel: FakeChannel): string {
  const last = channel.edited.at(-1);
  return last === undefined ? "" : textOf(last.message);
}

/** 最后一次编辑投递出去的消息（定稿 patch 同一张卡时，定稿就是它；没有编辑过时是空文本）。 */
function lastEdited(channel: FakeChannel): OutboundMessage {
  return channel.edited.at(-1)?.message ?? { kind: "text", text: "" };
}

/** 最后一次发送出去的消息（降级后定稿新发一条时，定稿就是它；没有发送过时是空文本）。 */
function lastSentMessage(channel: FakeChannel): OutboundMessage {
  return channel.sent.at(-1)?.message ?? { kind: "text", text: "" };
}

/** 一轮正常 Run 的帧脚本：思考 → 工具 → 正文 → 用量 → idle。 */
function happyScript(): Array<string | { hang: true }> {
  return [
    frame.taskState("idle"),
    frame.event({ type: "request_begin" }),
    frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "让" }),
    frame.omni({ type: "partial_thinking", role: "assistant", event_type: "delta", thinking: "想" }),
    frame.omni({ type: "thinking", role: "assistant", thinking: "想" }),
    frame.taskState("running"),
    frame.omni({ type: "tool_call", role: "assistant", name: "exec_command", arguments: '{"cmd":"date"}', tool_call_id: "tc1" }),
    frame.omni({ type: "tool_call_output", role: "user", output: "Tue Oct 21", tool_call_id: "tc1" }),
    frame.omni({ type: "text", role: "assistant", text: "今天 21 号", stop_reason: "completed" }),
    frame.event({ type: "token_usage", request: { total: 42 }, session: { total: 42 } }),
    frame.event({ type: "request_end", status: "completed" }),
    frame.taskState("idle"),
    frame.done(),
  ];
}

async function runOnce(
  server: FakeSessionServer,
  channel: FakeChannel,
  overrides: Partial<Parameters<typeof executeRun>[1]> = {},
  onStart?: (handle: RunHandle) => void,
) {
  return executeRun(
    { channel, logger: silent },
    {
      chatId: "oc_chat",
      input: "今天几号",
      agent: AGENT,
      sessionId: null,
      client: sessionClient(server),
      preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
      ...overrides,
      ...(onStart ? { onStart } : {}),
    },
  );
}

test("新建会话：档位下发 + thinking PATCH + 定稿卡片含分区与用量页脚", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();

  const report = await runOnce(server, channel, {
    settings: { workspace: "/tmp/ws", model: { provider: "stepfun", modelId: "step-3" }, thinkingLevel: "high" },
  });

  // 建会话带齐档位（model 成对）；thinkingLevel 走 PATCH
  const create = server.requests.find((r) => r.method === "POST" && r.path.endsWith("/sessions"));
  assert.deepEqual(create?.body, {
    client: "cli",
    approvalMode: "allow-all",
    workspace: "/tmp/ws",
    modelId: "step-3",
    provider: "stepfun",
  });
  const patch = server.requests.find((r) => r.method === "PATCH");
  assert.deepEqual(patch?.body, { thinkingLevel: "high" });

  // 占位即一张「思考中」卡片，后续都在它上面 patch
  assert.deepEqual(channel.sent[0]?.message, { kind: "card", card: placeholderCard() });
  assert.ok(channel.edited.length >= 1, `应有预览 patch，实际 ${channel.edited.length}`);
  assert.ok(channel.edited.every((e) => e.message.kind === "card"), "预览更新应全是卡片 patch");
  assert.ok(
    channel.edited.some((e) => e.message.kind === "card" && e.message.card.header.title.content === "🦐 执行中…"),
    "预览期间卡片 header 应是「执行中」",
  );

  // 定稿卡：绿色「✅ 完成」，思考折叠面板、工具折叠面板、正文、用量页脚齐全
  const final = cardOf(lastEdited(channel));
  assert.equal(final.header.title.content, "✅ 完成");
  assert.equal(final.header.template, "green");
  assert.match(flatText(lastEdited(channel)), /🧠 思考 · 运行完毕 · 1 字/);
  const thoughtPanel = panelsOf(final).find((p) => p.header.title.content.includes("🧠"));
  assert.ok(thoughtPanel !== undefined, "思考应收进折叠面板");
  assert.equal(thoughtPanel?.expanded, false, "思考面板默认收起");
  const panel = panelsOf(final).find((p) => p.header.title.content.includes("exec_command"));
  assert.ok(panel !== undefined, "工具调用应收进折叠面板");
  assert.equal(panel?.expanded, false, "工具面板默认收起");
  assert.match(panel?.header.title.content ?? "", /exec_command/);
  assert.match(panel?.header.title.content ?? "", /"cmd":"date"/);
  assert.match(panel?.header.title.content ?? "", /运行完毕/);
  assert.ok(flatText(lastEdited(channel)).includes("今天 21 号"), "正文要在");
  assert.equal(footerOf(final), "用量 42 tokens");

  assert.equal(report.status, "completed");
  assert.equal(report.sessionId, "session-fake-1");
  assert.equal(report.usageTotal, 42);
  assert.equal(report.requests, 1);
  assert.equal(report.modelId, "step-3");
});

test("续接会话：不再建会话，直接投递", async () => {
  const server = new FakeSessionServer();
  const client = sessionClient(server);
  const existing = await client.createSession("default_project", "default_agent");
  server.defaultScript = happyScript();
  const channel = new FakeChannel();

  const report = await runOnce(server, channel, { sessionId: existing.sessionId });

  assert.equal(server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/sessions")).length, 1);
  assert.equal(report.sessionId, existing.sessionId);
  assert.equal(report.status, "completed");
});

test("409 会话忙：占位卡被 patch 成忙卡（⏳ 请稍候），且不中断别人的任务", async () => {
  const server = new FakeSessionServer();
  server.nextTaskStatus = 409;
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.equal(report.status, "failed");
  assert.equal(channel.sent[0]?.message.kind, "card", "占位仍是卡片");
  // 忙提示也 patch 进占位卡：不留「思考中」僵尸卡，也不另发新消息
  assert.deepEqual(lastEdited(channel), { kind: "card", card: busyCard(BUSY_HINT) });
  assert.ok(channel.edited.every((e) => e.message.kind === "card"), "没有对该卡发起过文本 edit");
  assert.equal(channel.sent.length, 1, "忙提示不另发新消息");
  assert.equal(server.requests.some((r) => r.path.endsWith("/abort")), false);
});

test("409 会话忙（文本载体）：占位文本被编辑成 BUSY_HINT，且不中断别人的任务", async () => {
  const server = new FakeSessionServer();
  server.nextTaskStatus = 409;
  const channel = new FakeChannel();
  // 占位卡片就发不出去：整条 Run 走文本链路，忙提示编辑进占位文本
  channel.failSendKinds = ["card"];

  const report = await runOnce(server, channel);

  assert.equal(report.status, "failed");
  assert.equal(channel.sent[0]?.message.kind, "text", "占位退化为文本");
  assert.equal(lastEditedText(channel), BUSY_HINT);
  assert.equal(channel.sent.length, 1, "忙提示不另发新消息");
  assert.equal(server.requests.some((r) => r.path.endsWith("/abort")), false);
});

test("流中断（没看到 running 就结束）：显式中止，占位卡 patch 成错误卡", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = [frame.taskState("idle"), frame.done()];
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.equal(report.status, "failed");
  assert.equal(server.requests.some((r) => r.path.endsWith("/abort")), true);
  // 断流同样收敛到错误卡：红色「未正常完成」+ 脱敏后的错误文本
  assert.deepEqual(lastEdited(channel), {
    kind: "card",
    card: errorCard("执行失败：事件流在 Run 结束前中断"),
  });
});

test("fatal 终局：request_end 带错误，定稿卡写明未正常完成", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = [
    frame.taskState("running"),
    frame.event({ type: "request_end", status: "fatal", error_code: "auth", error_message: "403 quota" }),
    frame.taskState("idle"),
    frame.done(),
  ];
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.equal(report.status, "fatal");
  const final = cardOf(lastEdited(channel));
  assert.equal(final.header.title.content, "❌ 未正常完成");
  assert.equal(final.header.template, "red");
  assert.match(flatText(lastEdited(channel)), /未正常完成（fatal）/);
  assert.match(flatText(lastEdited(channel)), /403 quota/);
});

test("/stop：abort 后流补发 abort 事件与 idle，定稿卡结局为 aborted", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = [
    frame.taskState("idle"),
    frame.taskState("running"),
    frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "写了一" }),
    { hang: true },
  ];
  const channel = new FakeChannel();

  let handle: RunHandle | undefined;
  const promise = runOnce(server, channel, {}, (h) => {
    handle = h;
  });
  await waitFor(() => handle !== undefined);
  await handle?.abort();
  const report = await promise;

  assert.equal(report.status, "aborted");
  assert.equal(server.requests.some((r) => r.path.endsWith("/abort")), true);
  const final = cardOf(lastEdited(channel));
  assert.equal(final.header.template, "red");
  assert.match(flatText(lastEdited(channel)), /写了一/);
  assert.match(flatText(lastEdited(channel)), /未正常完成（aborted）/);
});

test("审批请求：先落「等待审批」预览，再按策略拒绝并把决定写进定稿卡", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = [
    frame.taskState("running"),
    frame.approval("tc7", "exec_command"),
    frame.taskState("idle"),
    frame.done(),
  ];
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.deepEqual(server.approvalCalls, [
    { sessionId: "session-fake-1", toolCallId: "tc7", decision: "deny" },
  ]);
  assert.match(flatText(lastEdited(channel)), /⚠️ 等待审批：`exec_command`/);
  assert.match(flatText(lastEdited(channel)), /🚫 已拒绝 `exec_command`/);
  assert.equal(report.status, "completed");
});

test("会话自愈：tasks 返回新 id 后改订阅新 id，定稿卡用新 id 的正文", async () => {
  const server = new FakeSessionServer();
  server.healTo = "session-healed";
  server.scripts.set("session-healed", [
    frame.taskState("idle"),
    frame.taskState("running"),
    frame.omni({ type: "text", role: "assistant", text: "自愈后完成", stop_reason: "completed" }),
    frame.taskState("idle"),
    frame.done(),
  ]);
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.equal(report.sessionId, "session-healed");
  assert.equal(report.status, "completed");
  assert.match(flatText(lastEdited(channel)), /自愈后完成/);
});

test("预览卡片 patch 失败：放弃预览，定稿新发一张卡（最后一条 sent 是定稿卡）", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  // 每条消息只许 patch 一次（模拟单条消息的更新次数上限）：第一次预览 patch 成功，
  // 之后一律失败。ADR-0006：卡片不换新消息续接，patch 失败即放弃预览，定稿新发卡片。
  channel.editLimitPerMessage = 1;

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.equal(channel.sent.length, 2, "占位卡 + 定稿新卡，不换消息续接");
  assert.ok(channel.sent.every((s) => s.message.kind === "card"), "发出的都应是卡片");
  // 占位卡只被成功 patch 过一次，之后没有再对任何卡片发起过编辑
  const placeholderId = channel.sent[0]?.messageId ?? "";
  assert.equal(channel.edited.length, 1, "成功 patch 之后不应再有编辑");
  assert.equal(channel.edited[0]?.messageId, placeholderId, "唯一一次编辑打在占位卡上");
  // 定稿作为最新一条消息发出，内容不丢
  const final = cardOf(lastSentMessage(channel));
  assert.equal(final.header.title.content, "✅ 完成");
  assert.match(flatText(lastSentMessage(channel)), /今天 21 号/);
  assert.equal(footerOf(final), "用量 42 tokens");
});

test("预览卡片一次都没 patch 成功：放弃预览，定稿新发一张卡（结果不丢）", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  channel.failEditKinds = ["card"];

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.equal(channel.edited.length, 0, "patch 从未成功过，不该换消息白试");
  assert.equal(channel.sent.length, 2, "占位卡 + 定稿新卡");
  const final = cardOf(lastSentMessage(channel));
  assert.equal(final.header.title.content, "✅ 完成");
  assert.match(flatText(lastSentMessage(channel)), /今天 21 号/);
  assert.equal(footerOf(final), "用量 42 tokens");
});

/** 占位卡发得出去，之后的卡片既发不出也 patch 不动：卡片链路全程断。 */
class CardBrokenAfterPlaceholder extends FakeChannel {
  private cardSends = 0;

  constructor() {
    super();
    this.failEditKinds = ["card"];
  }

  override async send(chatId: string, message: OutboundMessage): Promise<string> {
    if (message.kind === "card") {
      this.cardSends += 1;
      if (this.cardSends > 1) throw new Error("FakeChannel: send(card) failed");
    }
    return super.send(chatId, message);
  }
}

test("卡片模式的定稿链路全断：patch 不动也发不出，退回文本兜底", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new CardBrokenAfterPlaceholder();

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.equal(channel.edited.length, 0, "预览 patch 从未成功");
  assert.equal(channel.sent.length, 2, "占位卡 + 文本兜底");
  assert.equal(channel.sent[0]?.message.kind, "card", "占位卡成功发出");
  const fallback = lastSentMessage(channel);
  assert.equal(fallback?.kind, "text", "定稿退回文本消息");
  assert.match(flatText(fallback), /今天 21 号/);
  assert.match(flatText(fallback), /用量 42 tokens/);
});

test("占位卡片发送失败：回退文本占位，整条 Run 走文本链路", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  channel.failSendKinds = ["card"];

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.equal(textOf(channel.sent[0]?.message ?? { kind: "text", text: "" }), PLACEHOLDER_TEXT);
  assert.ok(channel.sent.every((s) => s.message.kind === "text"), "整条 Run 都走文本链路");
  assert.ok(channel.edited.length >= 1, "预览应编辑占位消息");
  assert.ok(channel.edited.every((e) => e.message.kind === "text"), "预览更新应全是文本编辑");
  // 定稿沿用既有文本行为：编辑占位消息
  const final = lastEditedText(channel);
  assert.match(final, /🧠 思考 · 1 字/);
  assert.match(final, /🔧 exec_command/);
  assert.match(final, /今天 21 号/);
  assert.match(final, /用量 42 tokens/);
});

test("卡片彻底走不通（发送与 patch 全败）：定稿仍以文本形式发出，结果不丢", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  channel.failSendKinds = ["card"];
  channel.failEditKinds = ["card"];

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.ok(channel.sent.every((s) => s.message.kind === "text"), "不该发出任何卡片");
  const final = lastEditedText(channel);
  assert.match(final, /今天 21 号/);
  assert.match(final, /用量 42 tokens/);
});

test("编辑全部失败：降级为最终一次性发送", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  channel.failSendKinds = ["card"];
  channel.failEditKinds = ["text"];

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.equal(channel.edited.length, 0);
  const finals = channel.sent.filter((m) => textOf(m.message) !== PLACEHOLDER_TEXT);
  assert.match(textOf(finals.at(-1)?.message ?? { kind: "text", text: "" }), /今天 21 号/);
});

test("建会话失败：占位卡被 patch 成错误卡", async () => {
  const server = new FakeSessionServer();
  const client = sessionClient(server);
  client.createSession = async () => {
    throw new Error("model not found");
  };
  const channel = new FakeChannel();

  const report = await runOnce(server, channel, { client });

  assert.equal(report.status, "failed");
  assert.equal(report.sessionId, null);
  assert.equal(channel.sent[0]?.message.kind, "card", "占位是卡片");
  assert.deepEqual(lastEdited(channel), { kind: "card", card: errorCard("执行失败：model not found") });
});

// ---- T12：图片入站投递（ADR-0009）----

test("有图投递：text part 在前、image_url parts 按序在后", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();

  const report = await runOnce(server, channel, {
    input: "这两张图是什么",
    images: ["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"],
  });

  assert.equal(report.status, "completed");
  assert.deepEqual(server.taskPosts()[0]?.body, {
    input: [
      { type: "text", text: "这两张图是什么" },
      { type: "image_url", imageUrl: "data:image/png;base64,AAAA" },
      { type: "image_url", imageUrl: "data:image/jpeg;base64,BBBB" },
    ],
  });
});

test("无图投递：单 text part，与旧行为逐字一致（images 缺省与空数组等价）", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();

  await runOnce(server, channel);
  assert.deepEqual(server.taskPosts()[0]?.body, { input: [{ type: "text", text: "今天几号" }] });

  server.defaultScript = happyScript();
  await runOnce(server, channel, { images: [] });
  assert.deepEqual(server.taskPosts()[1]?.body, { input: [{ type: "text", text: "今天几号" }] });
});

test("纯图片投递：空文本只投 image_url parts，不注入占位文本", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();

  const report = await runOnce(server, channel, { input: "", images: ["data:image/png;base64,AAAA"] });

  assert.equal(report.status, "completed");
  assert.deepEqual(server.taskPosts()[0]?.body, {
    input: [{ type: "image_url", imageUrl: "data:image/png;base64,AAAA" }],
  });
});

test("发起 Run 日志只含文本摘要，不泄露 data URL", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  const lines: string[] = [];
  const logger = createLogger("info", (line) => lines.push(line));

  const report = await executeRun(
    { channel, logger },
    {
      chatId: "oc_chat",
      input: "看这张图",
      images: ["data:image/png;base64,QUJD"],
      agent: AGENT,
      sessionId: null,
      client: sessionClient(server),
      preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
    },
  );

  assert.equal(report.status, "completed");
  assert.ok(lines.some((line) => line.includes("发起 Run：看这张图")), `应记录文本摘要：${lines.join("\n")}`);
  assert.ok(!lines.some((line) => line.includes("data:image")), "日志不应出现 data URL");
});

// ---- T13：HTML 页交付（ADR-0012）----

/** 一轮正文为 text 的正常 Run（HTML 页交付测试用：正文可控）。 */
function textScript(text: string): Array<string | { hang: true }> {
  return [
    frame.taskState("idle"),
    frame.taskState("running"),
    frame.omni({ type: "text", role: "assistant", text, stop_reason: "completed" }),
    frame.taskState("idle"),
    frame.done(),
  ];
}

/** 一个真的 .html 文件（落在一次性临时目录里，用完删）。 */
async function makePage(name = "page.html"): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "runner-page-"));
  const path = join(dir, name);
  await writeFile(path, "<html><body>页面</body></html>");
  return { dir, path };
}

/** 假渲染器脚本：读 stdin，把 `-o` 指向的路径写成非空 HTML；exitCode 控制成败。 */
async function makeRenderer(exitCode: number): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "runner-render-")), "fake-am.mjs");
  await writeFile(
    path,
    [
      "import { writeFileSync } from \"node:fs\";",
      "const args = process.argv.slice(2);",
      "await new Promise((r) => { process.stdin.resume(); process.stdin.on(\"end\", r); });",
      `if (${exitCode} !== 0) { process.stderr.write("fake render boom\\n"); process.exit(${exitCode}); }`,
      "writeFileSync(args[args.indexOf(\"-o\") + 1], \"<html><body>渲染产物</body></html>\");",
    ].join("\n"),
  );
  return path;
}

test("回复含页面链接且文件存在：定稿卡剥掉死链，并发出 file 消息", async () => {
  const server = new FakeSessionServer();
  const page = await makePage();
  server.defaultScript = textScript(`结论如下。\n\n[打开页面](<${page.path}>)`);
  const channel = new FakeChannel();

  try {
    const report = await runOnce(server, channel);
    assert.equal(report.status, "completed");

    const final = flatText(lastEdited(channel));
    assert.ok(!final.includes("打开页面"), `死链应被剥掉：${final}`);
    assert.ok(final.includes("结论如下。"));

    const files = channel.sent.filter((s) => s.message.kind === "file");
    assert.equal(files.length, 1);
    assert.deepEqual(files[0]?.message, { kind: "file", path: page.path, name: "page.html" });
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});

test("回复里的页面文件不存在：不发文件消息，定稿卡保留原样", async () => {
  const server = new FakeSessionServer();
  const missing = join(tmpdir(), "penguin-remote-missing-page.html");
  server.defaultScript = textScript(`结论如下。\n\n[打开页面](<${missing}>)`);
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);
  assert.equal(report.status, "completed");
  assert.equal(channel.sent.filter((s) => s.message.kind === "file").length, 0);
  assert.ok(flatText(lastEdited(channel)).includes("打开页面"), "链接点不动也该让用户看见路径");
});

test("配置渲染器且回复含富围栏：自动渲染成 HTML 页并发文件消息", async () => {
  const server = new FakeSessionServer();
  const script = await makeRenderer(0);
  server.defaultScript = textScript("来选一个。\n\n```a2ui\n" + JSON.stringify({
    type: "choice",
    question: "选哪个？",
    options: [{ label: "甲", recommended: true }, { label: "乙" }],
  }) + "\n```");
  const channel = new FakeChannel();

  try {
    const report = await runOnce(server, channel, { htmlRenderScript: script });
    assert.equal(report.status, "completed");

    const files = channel.sent.filter((s) => s.message.kind === "file");
    assert.equal(files.length, 1, "应发出一个自动渲染的页面");
    const file = files[0]?.message;
    assert.equal(file?.kind, "file");
    if (file?.kind !== "file") return;
    assert.match(file.path, /page\.html$/);
    assert.equal(file.name, "page.html");
    // 临时产物用后即删：文件与它所在的临时目录都不该残留
    await waitFor(() => !existsSync(file.path));
    assert.equal(existsSync(dirname(file.path)), false, "临时目录也该收掉");
  } finally {
    await rm(dirname(script), { recursive: true, force: true });
  }
});

test("未配置渲染器：含富围栏也不渲染，不发文件消息", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = textScript("来选一个。\n\n```a2ui\n" + JSON.stringify({
    type: "choice",
    question: "选哪个？",
    options: [{ label: "甲" }, { label: "乙" }],
  }) + "\n```");
  const channel = new FakeChannel();

  await runOnce(server, channel, { htmlRenderScript: null });
  assert.equal(channel.sent.filter((s) => s.message.kind === "file").length, 0);
});

test("渲染失败：不发文件消息，定稿卡照常发出", async () => {
  const server = new FakeSessionServer();
  const script = await makeRenderer(3);
  server.defaultScript = textScript("来选一个。\n\n```a2ui\n" + JSON.stringify({
    type: "choice",
    question: "选哪个？",
    options: [{ label: "甲" }, { label: "乙" }],
  }) + "\n```");
  const channel = new FakeChannel();

  try {
    const report = await runOnce(server, channel, { htmlRenderScript: script });
    assert.equal(report.status, "completed");
    assert.equal(channel.sent.filter((s) => s.message.kind === "file").length, 0);
    assert.ok(flatText(lastEdited(channel)).includes("来选一个。"), "定稿卡不能受影响");
  } finally {
    await rm(dirname(script), { recursive: true, force: true });
  }
});

test("Agent 已产出页面时不再自动渲染（不双发）", async () => {
  const server = new FakeSessionServer();
  const page = await makePage();
  const script = await makeRenderer(0);
  server.defaultScript = textScript(`结论如下。\n\n[打开页面](<${page.path}>)\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\``);
  const channel = new FakeChannel();

  try {
    await runOnce(server, channel, { htmlRenderScript: script });
    const files = channel.sent.filter((s) => s.message.kind === "file");
    assert.equal(files.length, 1, "只发 Agent 自己产出的那一页");
    assert.deepEqual(files[0]?.message, { kind: "file", path: page.path, name: "page.html" });
  } finally {
    await rm(page.dir, { recursive: true, force: true });
    await rm(dirname(script), { recursive: true, force: true });
  }
});

test("文件消息发送失败：只记日志，定稿卡不受影响", async () => {
  const server = new FakeSessionServer();
  const page = await makePage();
  server.defaultScript = textScript(`结论如下。\n\n[打开页面](<${page.path}>)`);
  const channel = new FakeChannel();
  channel.failSendKinds = ["file"];

  try {
    const report = await runOnce(server, channel);
    assert.equal(report.status, "completed");
    assert.ok(flatText(lastEdited(channel)).includes("结论如下。"));
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});
