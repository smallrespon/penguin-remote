// runner 测试（ADR-0005 会话 API 版）：新建/续接会话、档位下发、终局文案、
// 断流即中止、审批应答、会话自愈、定稿与降级。

import assert from "node:assert/strict";
import { test } from "node:test";

import { executeRun, type RunHandle } from "../src/penguin/runner.js";
import { createLogger } from "../src/logger.js";
import { BUSY_HINT, PLACEHOLDER_TEXT } from "../src/render.js";
import { FakeSessionServer, frame, sessionClient } from "./helpers/fake-sessions.js";
import { FakeChannel } from "./helpers/fake-channel.js";
import { waitFor } from "./helpers/wait.js";

const silent = createLogger("error", () => {});

const AGENT = { projectId: "default_project", agentId: "default_agent" };

/** 一轮正常 Run 的帧脚本：思考 → 工具 → 正文 → 用量 → idle。 */
function happyScript(): Array<string | { hang: true }> {
  return [
    frame.taskState("idle"),
    frame.event({ type: "request_begin" }),
    frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "让" }),
    frame.omni({ type: "partial_thinking", role: "assistant", event_type: "delta", thinking: "想" }),
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

test("新建会话：档位下发 + thinking PATCH + 定稿含分区与用量页脚", async () => {
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

  assert.equal(channel.sent[0]?.markdown, PLACEHOLDER_TEXT);
  const final = channel.edited.at(-1)?.markdown ?? channel.sent.at(-1)?.markdown ?? "";
  assert.match(final, /🧠 思考 · 1 字/);
  assert.match(final, /🔧 exec_command/);
  assert.match(final, /今天 21 号/);
  assert.match(final, /用量 42 tokens/);

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

test("409 会话忙：提示 BUSY_HINT，且不中断别人的任务", async () => {
  const server = new FakeSessionServer();
  server.nextTaskStatus = 409;
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.equal(report.status, "failed");
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.equal(final, BUSY_HINT);
  assert.equal(server.requests.some((r) => r.path.endsWith("/abort")), false);
});

test("流中断（没看到 running 就结束）：显式中止并报失败", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = [frame.taskState("idle"), frame.done()];
  const channel = new FakeChannel();

  const report = await runOnce(server, channel);

  assert.equal(report.status, "failed");
  assert.equal(server.requests.some((r) => r.path.endsWith("/abort")), true);
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.match(final, /执行失败/);
});

test("fatal 终局：request_end 带错误，定稿写明未正常完成", async () => {
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
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.match(final, /未正常完成（fatal）/);
  assert.match(final, /403 quota/);
});

test("/stop：abort 后流补发 abort 事件与 idle，结局为 aborted", async () => {
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
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.match(final, /写了一/);
  assert.match(final, /未正常完成（aborted）/);
});

test("审批请求：先落「等待审批」预览，再按策略拒绝并把决定写进预览", async () => {
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
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.match(final, /⚠️ 等待审批：`exec_command`/);
  assert.match(final, /🚫 已拒绝 `exec_command`/);
  assert.equal(report.status, "completed");
});

test("会话自愈：tasks 返回新 id 后改订阅新 id，report 用新 id", async () => {
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
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.match(final, /自愈后完成/);
});

test("编辑全部失败：降级为最终一次性发送", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  channel.failEditWith = new Error("edit rejected");

  const report = await runOnce(server, channel);

  assert.equal(report.status, "completed");
  assert.equal(channel.edited.length, 0);
  const finals = channel.sent.filter((m) => m.markdown !== PLACEHOLDER_TEXT);
  assert.match(finals.at(-1)?.markdown ?? "", /今天 21 号/);
});

test("建会话失败：占位消息里写失败原因", async () => {
  const server = new FakeSessionServer();
  const client = sessionClient(server);
  client.createSession = async () => {
    throw new Error("model not found");
  };
  const channel = new FakeChannel();

  const report = await runOnce(server, channel, { client });

  assert.equal(report.status, "failed");
  assert.equal(report.sessionId, null);
  const final = channel.edited.at(-1)?.markdown ?? "";
  assert.match(final, /执行失败：model not found/);
});
