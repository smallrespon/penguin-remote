import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PLACEHOLDER_TEXT,
  RunPreview,
  applyEvent,
  emptyPreview,
  renderPreview,
  shouldFlush,
  type PreviewOptions,
} from "../src/render.js";
import {
  FakeAmspServer,
  runDone,
  textDelta,
  textDone,
  thinkingDelta,
  toolCallDone,
  toolResultDone,
} from "./helpers/fake-amsp.js";
import { AmspClient } from "../src/penguin/amsp.js";
import { executeRun } from "../src/penguin/runner.js";
import { createLogger } from "../src/logger.js";
import { FakeChannel } from "./helpers/fake-channel.js";

const OPTIONS: PreviewOptions = { throttleMs: 1500, throttleChars: 300, maxChars: 3500 };

const silent = createLogger("error", () => {});

test("render：text.delta 累积为正文，thinking 折叠为一行计数", () => {
  let state = emptyPreview();
  state = applyEvent(state, thinkingDelta("思考"));
  state = applyEvent(state, thinkingDelta("中"));
  state = applyEvent(state, textDelta("现在"));
  state = applyEvent(state, textDelta("八点"));
  const markdown = renderPreview(state, OPTIONS);
  assert.match(markdown, /🧠 思考中…（3 字）/);
  assert.match(markdown, /现在八点/);
});

test("render：text.done 是权威全文，替换增量累积", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("现在"));
  state = applyEvent(state, textDone("现在是二十点整"));
  assert.match(renderPreview(state, OPTIONS), /^现在是二十点整$/m);
});

test("render：tool_call.done 追加调用行，tool_result.done 截断追加", () => {
  let state = emptyPreview();
  state = applyEvent(state, toolCallDone("c1", "exec_command", '{"command":"ls"}'));
  state = applyEvent(state, toolResultDone("c1", "x".repeat(500)));
  const markdown = renderPreview(state, OPTIONS);
  assert.match(markdown, /🔧 调用 `exec_command`/);
  assert.match(markdown, /└ x+…/);
  assert.ok(markdown.length < 600, `应截断，实际 ${markdown.length}`);
});

test("render：超过 maxChars 时首尾保留、中间标注省略", () => {
  let state = emptyPreview();
  state = applyEvent(state, textDelta("a".repeat(4000)));
  const markdown = renderPreview(state, { throttleMs: 0, throttleChars: 0, maxChars: 1000 });
  assert.ok(markdown.length <= 1000 + 40, `实际 ${markdown.length}`);
  assert.match(markdown, /中间省略 \d+ 字/);
});

test("render：未知事件类型被忽略", () => {
  const state = applyEvent(emptyPreview(), { type: "mcp_connect.done", at: "", status: "completed", results: [] });
  assert.deepEqual(state, emptyPreview());
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

test("流式预览：Run 过程中按节流编辑占位消息，最终定稿一次", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const client = new AmspClient({
    baseUrl: server.baseUrl,
    agent: { projectId: "default_project", agentId: "default_agent" },
    apiKey: "penguin_test",
    fetch: server.fetch,
  });
  const report = executeRun({ channel, logger: silent }, {
    chatId: "oc_1",
    input: "长任务",
    client,
    preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
  });
  const run = await nextRun(server);
  server.push(run, thinkingDelta("先想一下"));
  await tick();
  server.push(run, textDelta("第一部"));
  await tick();
  server.push(run, toolCallDone("c1", "exec_command"));
  await tick();
  server.push(run, toolResultDone("c1", "输出"));
  await tick();
  server.push(run, textDone("全部完成"));
  server.push(run, runDone());
  server.close(run);
  await report;

  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0]?.markdown, PLACEHOLDER_TEXT);
  assert.ok(channel.edited.length >= 4, `应有多次增量编辑，实际 ${channel.edited.length}`);
  assert.match(channel.edited.at(-1)?.markdown ?? "", /全部完成/);
  assert.match(channel.edited.at(-1)?.markdown ?? "", /用量 42 tokens/);
  // 中间某次编辑应包含思考行与工具行
  assert.ok(channel.edited.some((e) => /🧠 思考中…（4 字）/.test(e.markdown)));
  assert.ok(channel.edited.some((e) => /🔧 调用 `exec_command`/.test(e.markdown)));
});

test("流式预览：编辑失败时降级为最终一次性发送，结果不丢", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  channel.failEditWith = new Error("too many requests");
  const client = new AmspClient({
    baseUrl: server.baseUrl,
    agent: { projectId: "default_project", agentId: "default_agent" },
    apiKey: "penguin_test",
    fetch: server.fetch,
  });
  const report = executeRun({ channel, logger: silent }, {
    chatId: "oc_1",
    input: "长任务",
    client,
    preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
  });
  const run = await nextRun(server);
  server.push(run, textDelta("部分"));
  await tick();
  server.push(run, textDone("最终答案"));
  server.push(run, runDone());
  server.close(run);
  await report;

  assert.equal(channel.edited.length, 0, "编辑一直失败，不应重试");
  assert.equal(channel.sent.length, 2, "占位 + 降级后的总结");
  assert.match(channel.lastSent(), /最终答案/);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function nextRun(server: FakeAmspServer): Promise<ReturnType<FakeAmspServer["lastRun"]>> {
  const before = server.runs.length;
  const started = Date.now();
  while (server.runs.length <= before) {
    if (Date.now() - started > 1000) throw new Error("waitFor timeout");
    await tick();
  }
  return server.lastRun();
}
