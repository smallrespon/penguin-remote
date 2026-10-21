// 会话 API 客户端测试：建会话 / PATCH / tasks / abort / approvals / SSE 订阅与解析。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SessionApiError,
  SessionBusyError,
  SessionClient,
  type StreamItem,
} from "../src/penguin/sessions.js";
import { FakeSessionServer, frame } from "./helpers/fake-sessions.js";

function client(server: FakeSessionServer): SessionClient {
  return new SessionClient({ fetchAuthed: server.fetchAuthed });
}

test("createSession：成对下发 model、带 workspace 与 allow-all", async () => {
  const server = new FakeSessionServer();
  const info = await client(server).createSession("default_project", "default_agent", {
    workspace: "/tmp/ws",
    model: { provider: "stepfun", modelId: "step-3" },
  });
  const create = server.requests.find((r) => r.method === "POST" && r.path.endsWith("/sessions"));
  assert.equal(create?.path, "/projects/default_project/agents/default_agent/sessions");
  assert.deepEqual(create?.body, {
    client: "cli",
    approvalMode: "allow-all",
    workspace: "/tmp/ws",
    modelId: "step-3",
    provider: "stepfun",
  });
  assert.equal(info.sessionId, "session-fake-1");
  assert.equal(info.modelId, "step-3");
  assert.equal(info.status, "idle");
});

test("createSession：无档位时只发 client 与审批模式", async () => {
  const server = new FakeSessionServer();
  await client(server).createSession("p", "a");
  const create = server.requests.find((r) => r.method === "POST");
  assert.deepEqual(create?.body, { client: "cli", approvalMode: "allow-all" });
});

test("patchThinkingLevel / sessionInfo 走 PATCH 与 GET", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  await api.patchThinkingLevel(created.sessionId, "high");
  assert.deepEqual(server.requests.at(-1), {
    method: "PATCH",
    path: `/sessions/${created.sessionId}`,
    body: { thinkingLevel: "high" },
  });
  const info = await api.sessionInfo(created.sessionId);
  assert.equal(info.sessionId, created.sessionId);
});

test("startTask：投递 input 文本数组，202 解析 sessionId 与 queued", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  const started = await api.startTask(created.sessionId, "现在几点");
  const post = server.requests.at(-1);
  assert.equal(post?.method, "POST");
  assert.equal(post?.path, `/sessions/${created.sessionId}/tasks`);
  assert.deepEqual(post?.body, { input: [{ type: "text", text: "现在几点" }] });
  assert.deepEqual(started, { sessionId: created.sessionId, queued: false });
});

test("startTask：409 转为 SessionBusyError", async () => {
  const server = new FakeSessionServer();
  server.nextTaskStatus = 409;
  await assert.rejects(() => client(server).startTask("s1", "hi"), SessionBusyError);
});

test("startTask：其他非 2xx 抛 SessionApiError", async () => {
  const server = new FakeSessionServer();
  server.nextTaskStatus = 500;
  await assert.rejects(() => client(server).startTask("s1", "hi"), SessionApiError);
});

test("abort：202 = 真的中断了，204 = 无在跑任务", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  assert.equal(await api.abort(created.sessionId), false);
  await api.startTask(created.sessionId, "hi");
  assert.equal(await api.abort(created.sessionId), true);
});

test("decideApproval：204 → true，404 → false", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  assert.equal(await api.decideApproval(created.sessionId, "tc1", "deny"), true);
  assert.deepEqual(server.approvalCalls, [{ sessionId: created.sessionId, toolCallId: "tc1", decision: "deny" }]);
  // 会话不存在（或审批已裁决）：404 → false
  assert.equal(await api.decideApproval("nope", "tc1", "allow"), false);
});

test("stream：ready 等首帧，随后按序产出条目，ping 被跳过", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  server.scripts.set(created.sessionId, [
    frame.taskState("idle"),
    frame.ping(),
    frame.omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "你好" }),
    frame.taskState("running"),
    frame.omni({ type: "text", role: "assistant", text: "你好", stop_reason: "completed" }),
    frame.event({ type: "request_end", status: "completed" }),
    frame.taskState("idle"),
    frame.done(),
  ]);
  const stream = await api.stream(created.sessionId);
  await stream.ready();
  const items: StreamItem[] = [];
  for await (const item of stream) items.push(item);
  assert.deepEqual(
    items.map((item) => (item.kind === "server" ? item.event.type : item.message.payload.type)),
    ["task_state", "partial_text", "task_state", "text", "request_end", "task_state"],
  );
  const text = items[1];
  assert.equal(text?.kind === "omni" ? text.message.payload.text : undefined, "你好");
});

test("stream：非 2xx 直接抛 SessionApiError", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  await assert.rejects(() => api.stream("missing"), SessionApiError);
});

test("stream：close 后迭代立即结束", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  const stream = await api.stream(created.sessionId);
  await stream.ready();
  await stream.close();
  const next = await stream.next();
  assert.equal(next.done, true);
});

test("stream：坏 JSON 帧抛出（调用方按断流处置）", async () => {
  const server = new FakeSessionServer();
  const api = client(server);
  const created = await api.createSession("p", "a");
  server.scripts.set(created.sessionId, ["data: {不是 json\n\n"]);
  const stream = await api.stream(created.sessionId);
  await stream.ready();
  await assert.rejects(async () => {
    for await (const _item of stream) void _item;
  });
});
