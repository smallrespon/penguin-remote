// 会话 API 客户端测试：建会话 / PATCH / tasks / abort / approvals / SSE 订阅与解析。

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SessionApiError,
  SessionBusyError,
  SessionClient,
  type StreamItem,
  normalizeWorkspacePath,
} from "../src/penguin/sessions.js";
import { FakeSessionServer, frame } from "./helpers/fake-sessions.js";

function client(server: FakeSessionServer): SessionClient {
  return new SessionClient({ fetchAuthed: server.fetchAuthed });
}

/** 第 i 分钟的 ISO 时间戳（基准 + i 分钟，i 可以很大也不会分钟越界）。 */
function at(i: number): string {
  return new Date(Date.parse("2026-10-22T09:00:00.000Z") + i * 60_000).toISOString();
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

// ---- 会话列表（ADR-0008）----

test("listSessions：GET 当前 (project, agent) 的会话，按 lastActiveAt 倒序解析", async () => {
  const server = new FakeSessionServer();
  server.addSession({
    sessionId: "s_old",
    title: "旧会话",
    modelId: "step-3",
    lastActiveAt: "2026-10-20T09:00:00.000Z",
  });
  server.addSession({ sessionId: "s_new", title: null, lastActiveAt: "2026-10-22T09:00:00.000Z" });
  server.addSession({ sessionId: "s_mid", title: "中间", lastActiveAt: "2026-10-21T09:00:00.000Z" });

  const items = await client(server).listSessions("default_project", "default_agent");
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["s_new", "s_mid", "s_old"],
  );
  assert.deepEqual(items[0], {
    sessionId: "s_new",
    title: null,
    lastActiveAt: "2026-10-22T09:00:00.000Z",
    modelId: null,
    workspace: null,
  });
  const request = server.requests.at(-1);
  assert.equal(request?.method, "GET");
  assert.equal(request?.path, "/projects/default_project/agents/default_agent/sessions");
});

test("listSessions：过滤已归档会话", async () => {
  const server = new FakeSessionServer();
  server.addSession({ sessionId: "s_live", lastActiveAt: "2026-10-22T09:00:00.000Z" });
  server.addSession({ sessionId: "s_archived", archived: true, lastActiveAt: "2026-10-22T10:00:00.000Z" });

  const items = await client(server).listSessions("default_project", "default_agent");
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["s_live"],
  );
});

test("listSessions：按工作区过滤，只留当前工作区的未归档会话（ADR-0013）", async () => {
  const server = new FakeSessionServer();
  server.addSession({ sessionId: "s_mine_new", workspace: "/root/thesis", lastActiveAt: "2026-10-22T10:00:00.000Z" });
  server.addSession({ sessionId: "s_mine_old", workspace: "/root/thesis", lastActiveAt: "2026-10-22T08:00:00.000Z" });
  server.addSession({ sessionId: "s_other_ws", workspace: "/root/penguin_remote", lastActiveAt: "2026-10-22T11:00:00.000Z" });
  server.addSession({ sessionId: "s_mine_archived", workspace: "/root/thesis", archived: true, lastActiveAt: "2026-10-22T12:00:00.000Z" });
  server.addSession({ sessionId: "s_no_ws", workspace: null, lastActiveAt: "2026-10-22T13:00:00.000Z" });

  const items = await client(server).listSessions("default_project", "default_agent", { workspace: "/root/thesis" });
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["s_mine_new", "s_mine_old"],
    "只留当前工作区、未归档；别的工作区与服务端没报 workspace 的都排除",
  );
  assert.equal(items[0]?.workspace, "/root/thesis", "条目带出工作区");
});

test("listSessions：不传 workspace = 不限工作区（没设 /workspace 的聊天看全部）", async () => {
  const server = new FakeSessionServer();
  server.addSession({ sessionId: "s_a", workspace: "/root/a", lastActiveAt: "2026-10-22T10:00:00.000Z" });
  server.addSession({ sessionId: "s_b", workspace: "/root/b", lastActiveAt: "2026-10-22T09:00:00.000Z" });

  assert.deepEqual(
    (await client(server).listSessions("default_project", "default_agent")).map((item) => item.sessionId),
    ["s_a", "s_b"],
  );
  assert.deepEqual(
    (await client(server).listSessions("default_project", "default_agent", { workspace: null })).map((item) => item.sessionId),
    ["s_a", "s_b"],
    "显式传 null 同样是不限",
  );
});

test("listSessions：工作区路径尾部斜杠归一，/root/x/ 与 /root/x 能对上", async () => {
  const server = new FakeSessionServer();
  server.addSession({ sessionId: "s_mine", workspace: "/root/thesis", lastActiveAt: "2026-10-22T10:00:00.000Z" });
  server.addSession({ sessionId: "s_other", workspace: "/root/other", lastActiveAt: "2026-10-22T09:00:00.000Z" });

  const items = await client(server).listSessions("default_project", "default_agent", { workspace: "/root/thesis///" });
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["s_mine"],
  );
  assert.equal(normalizeWorkspacePath("/"), "/", "根目录归一后还是根目录");
  assert.equal(normalizeWorkspacePath("//"), "/", "整串斜杠兜底回根目录，不变成空过滤器");
  assert.equal(normalizeWorkspacePath(" /root/x/ "), "/root/x", "顺带 trim");
  assert.equal(normalizeWorkspacePath(""), "", "空串仍是空串（调用方按「不过滤」处理）");
});

test("listSessions：按 (project, agent) 隔离，别的 Agent 的会话看不到", async () => {
  const server = new FakeSessionServer();
  server.addSession({ sessionId: "s_mine", agentId: "default_agent", lastActiveAt: "2026-10-22T09:00:00.000Z" });
  server.addSession({ sessionId: "s_other", agentId: "coder", lastActiveAt: "2026-10-22T10:00:00.000Z" });

  const items = await client(server).listSessions("default_project", "default_agent");
  assert.deepEqual(
    items.map((item) => item.sessionId),
    ["s_mine"],
  );
});

test("listSessions：不截断，返回全部未归档会话（ADR-0011，截断移到网关展示层）", async () => {
  const server = new FakeSessionServer();
  for (let i = 1; i <= 60; i += 1) {
    server.addSession({ sessionId: `s${i}`, lastActiveAt: at(i) });
  }
  server.addSession({ sessionId: "s_notime" }); // 缺 lastActiveAt：排最后
  server.addSession({ sessionId: "s_archived", archived: true, lastActiveAt: at(61) }); // 已归档：不返回

  const items = await client(server).listSessions("default_project", "default_agent");
  assert.equal(items.length, 61, "超过旧的 10 条上限也全部返回（含缺时间的那条）");
  assert.equal(items[0]?.sessionId, "s60", "最新的在前");
  assert.equal(items[59]?.sessionId, "s1", "最旧的未归档会话也在");
  assert.equal(items[60]?.sessionId, "s_notime", "缺 lastActiveAt 的排最后");
  assert.ok(
    !items.some((item) => item.sessionId === "s_archived"),
    "已归档会话仍不返回",
  );
});

test("listSessions：响应缺 sessions 字段（或条目畸形）时给空列表", async () => {
  const api = new SessionClient({
    fetchAuthed: async () => new Response(JSON.stringify({ sessions: [null, "x", { title: "没有 id" }] }), { status: 200 }),
  });
  assert.deepEqual(await api.listSessions("default_project", "default_agent"), []);
});

test("listSessions：非 2xx 抛 SessionApiError", async () => {
  const server = new FakeSessionServer();
  server.nextListStatus = 500;
  await assert.rejects(() => client(server).listSessions("default_project", "default_agent"), SessionApiError);
});
