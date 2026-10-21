// runner 测试：429 退避重试、409 会话忙提示、定稿与降级、onStart 句柄。

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AmspClient, AmspRun } from "../src/penguin/amsp.js";
import { AmspClient as AmspClientClass } from "../src/penguin/amsp.js";
import { executeRun } from "../src/penguin/runner.js";
import { createLogger } from "../src/logger.js";
import { BUSY_HINT, PLACEHOLDER_TEXT } from "../src/render.js";
import { FakeAmspServer, runDone, textDelta, textDone } from "./helpers/fake-amsp.js";
import { FakeChannel } from "./helpers/fake-channel.js";
import { waitFor } from "./helpers/wait.js";

const silent = createLogger("error", () => {});

const TOO_MANY = { status: 429, body: { error: { code: "too_many_runs", message: "too many runs" } } };
const BUSY = {
  status: 409,
  body: { error: { code: "task_in_progress", message: "This Session already has a Task in progress." } },
};

function client(server: FakeAmspServer): AmspClient {
  return new AmspClientClass({
    baseUrl: server.baseUrl,
    agent: { projectId: "default_project", agentId: "default_agent" },
    apiKey: "penguin_test",
    fetch: server.fetch,
  });
}

/** 跑一次 Run；返回 report promise、占位消息与 abort 句柄收集器。 */
function runOnce(server: FakeAmspServer, channel: FakeChannel, onStart?: (run: AmspRun) => void) {
  return executeRun(
    { channel, logger: silent },
    {
      chatId: "oc_chat",
      input: "现在几点",
      client: client(server),
      preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
      ...(onStart ? { onStart } : {}),
    },
  );
}

test("429 后退避重试：重开 Run 后成功，abort 句柄指向最新一次尝试", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const started: AmspRun[] = [];
  server.nextError = TOO_MANY;

  const reportPromise = runOnce(server, channel, (run) => started.push(run));
  await waitFor(() => server.runRequests().length === 1);
  await waitFor(() => server.runs.length === 1, 5000);

  const run = server.lastRun();
  server.push(run, textDelta("现在"));
  server.push(run, textDone("现在八点"));
  server.push(run, runDone());
  server.close(run);

  const report = await reportPromise;
  assert.equal(server.runRequests().length, 2, "429 后重开一次");
  assert.equal(started.length, 2, "每次尝试都回调 onStart");
  assert.equal(await started[1]?.sessionId, run.sessionId, "/stop 拿到的应是重开后的 Run");
  assert.equal(report.status, "completed");
  assert.equal(report.usageTotal, 42);
  // 占位消息只发一次，最终文本编辑到它上面；没有多余失败提示
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0]?.markdown, PLACEHOLDER_TEXT);
  assert.match(channel.edited.at(-1)?.markdown ?? "", /现在八点/);
  assert.ok(!channel.sent.some((m) => m.markdown.includes("执行失败")));
});

test("429 重试耗尽（3 次）后把错误回复给用户", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  server.nextError = TOO_MANY;

  const reportPromise = runOnce(server, channel);
  await waitFor(() => server.runRequests().length === 1);
  server.nextError = TOO_MANY;
  await waitFor(() => server.runRequests().length === 2);
  server.nextError = TOO_MANY;

  const report = await reportPromise;
  assert.equal(server.runRequests().length, 3, "首次 + 2 次重试");
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /Agent 并发已达上限/);
  assert.match(channel.edited.at(-1)?.markdown ?? "", /执行失败/);
  assert.equal(channel.edited.length, 1, "只把结局写进占位消息");
});

test("409 会话忙：回复忙提示而非错误堆栈，且不重试", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  server.nextError = BUSY;

  const report = await runOnce(server, channel);
  assert.equal(server.runRequests().length, 1, "409 不重试");
  assert.equal(report.status, "failed");
  assert.match(report.error ?? "", /Task in progress/);
  // 结局写进占位消息（同一条），不再停在「思考中…」
  assert.equal(channel.edited.at(-1)?.markdown, BUSY_HINT);
  assert.equal(channel.sent.length, 1);
});

test("Run 失败时占位消息被更新为失败原因，不停在「思考中…」", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  server.nextError = { status: 500, body: { error: { code: "boom", message: "server exploded" } } };

  const report = await runOnce(server, channel);
  assert.equal(report.status, "failed");
  assert.equal(channel.sent.length, 1, "只发过占位消息");
  const failure = channel.edited.at(-1)?.markdown ?? "";
  assert.match(failure, /^执行失败：/);
  assert.ok(failure.includes("server exploded"), "失败原因应带给用户");
});

test("审批策略可注入：allowAll 策略放行审批请求", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const reportPromise = executeRun(
    { channel, logger: silent, approvals: { decide: () => "allow" } },
    {
      chatId: "oc_chat",
      input: "现在几点",
      client: client(server),
      preview: { throttleMs: 0, throttleChars: 0, maxChars: 3500 },
    },
  );
  await waitFor(() => server.runs.length > 0);
  const run = server.lastRun();
  server.push(run, {
    type: "approval.requested",
    at: new Date().toISOString(),
    tool_call: { tool_call_id: "call_9", name: "exec_command", arguments: '{"command":"ls"}' },
  });
  server.push(run, textDone("已允许后继续"));
  server.push(run, runDone());
  server.close(run);

  const report = await reportPromise;
  assert.equal(report.status, "completed");
  assert.deepEqual(server.approvalCalls, [
    { sessionId: run.sessionId, toolCallId: "call_9", decision: "allow" },
  ]);
});

test("审批请求：v1 一律拒绝，并在预览里说明（allow-all 模式下不会发生）", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const reportPromise = runOnce(server, channel);
  await waitFor(() => server.runs.length > 0);
  const run = server.lastRun();
  server.push(run, {
    type: "approval.requested",
    at: new Date().toISOString(),
    tool_call: { tool_call_id: "call_9", name: "exec_command", arguments: '{"command":"ls"}' },
  });
  server.push(run, textDone("被拒绝后继续"));
  server.push(run, runDone());
  server.close(run);

  const report = await reportPromise;
  assert.equal(report.status, "completed");
  assert.deepEqual(server.approvalCalls, [
    { sessionId: run.sessionId, toolCallId: "call_9", decision: "deny" },
  ]);
  // 预览里既有「等待审批」也有「已拒绝」的说明
  const preview = channel.edited.map((e) => e.markdown).join("\n");
  assert.match(preview, /等待审批：`exec_command`/);
  assert.match(preview, /已拒绝 `exec_command`/);
});
