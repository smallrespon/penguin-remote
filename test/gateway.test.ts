import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Gateway, BUSY_HINT } from "../src/gateway.js";
import { LaneQueue } from "../src/lanes.js";
import { createLogger } from "../src/logger.js";
import { AmspClient } from "../src/penguin/amsp.js";
import { Registry } from "../src/registry.js";
import { RunLog } from "../src/runlog.js";
import { loadConfig } from "../src/config.js";
import { formatSkillInput, helpText, parseCommand } from "../src/router.js";
import { FakeAmspServer, runDone, textDelta, textDone } from "./helpers/fake-amsp.js";
import { FakeChannel } from "./helpers/fake-channel.js";

const silent = createLogger("error", () => {});

function makeConfig() {
  return loadConfig({
    AMSP_BASE_URL: "http://localhost/api/amsp/v1",
    DEFAULT_PROJECT_ID: "default_project",
    DEFAULT_AGENT_ID: "default_agent",
  });
}

async function makeGateway(server: FakeAmspServer, channel = new FakeChannel(), stateDir?: string) {
  const dir = stateDir ?? (await mkdtemp(join(tmpdir(), "pr-state-")));
  const registry = await Registry.load(dir, {
    projectId: "default_project",
    agentId: "default_agent",
  });
  const runLog = await RunLog.load(dir);
  const gateway = new Gateway({
    config: makeConfig(),
    channel,
    lanes: new LaneQueue(),
    logger: silent,
    registry,
    runLog,
    clientFor: async ({ projectId, agentId }) =>
      new AmspClient({
        baseUrl: server.baseUrl,
        agent: `${projectId}/${agentId}`,
        apiKey: "penguin_test",
        fetch: server.fetch,
      }),
  });
  return { gateway, channel, registry, runLog, stateDir: dir };
}

/** 等下一个 run 出现，推完事件后收尾。 */
async function completeRun(server: FakeAmspServer, events: Parameters<FakeAmspServer["push"]>[1][]) {
  await waitFor(() => server.runs.length > 0);
  const run = server.lastRun();
  for (const event of events) server.push(run, event);
  server.close(run);
}

/** 取第 n 次 runs 请求的 input。 */
function inputOf(server: FakeAmspServer, index: number): string {
  const body = server.requests[index]?.body as { input?: string } | undefined;
  return body?.input ?? "";
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("waitFor timeout"));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

// ---- T4 回归：最小闭环 ----

test("最小闭环：飞书一句话 → AMSP run → 同聊天收到一条最终回复", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  const received = channel.receive("现在几点");
  await completeRun(server, [textDelta("现在是"), textDelta("20:00"), textDone("现在是20:00"), runDone()]);
  await received;

  assert.equal(server.requests.length, 1);
  assert.deepEqual(server.requests[0]?.body, { input: "现在几点" });
  assert.equal(channel.sent.length, 1);
  assert.match(channel.lastSent(), /现在是20:00/);
  assert.match(channel.lastSent(), /用量 42 tokens/);
});

test("最小闭环：Run 进行中同聊天再来消息 → 只提示不排队", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  const first = channel.receive("第一个任务");
  await waitFor(() => server.runs.length > 0);
  await channel.receive("第二个任务");
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.lastSent(), BUSY_HINT);
  assert.equal(server.runs.length, 1, "不应发起第二个 Run");

  await completeRun(server, [textDelta("完成"), textDone("完成"), runDone()]);
  await first;
  assert.equal(server.runs.length, 1);
});

// ---- T5：Registry ----

test("Registry：update 原子落盘，重启（重新 load）后绑定与历史恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-state-"));
  const first = await Registry.load(dir, { projectId: "p", agentId: "a" });
  await first.update("oc_1", (b) => {
    b.sessionId = "session-1";
    b.skillSticky = "lark-im";
  });
  await first.noteSession("oc_1", { sessionId: "session-1", title: "第一个任务" });
  await first.noteSession("oc_1", { sessionId: "session-2", title: "第二个任务" });

  const raw = JSON.parse(await readFile(join(dir, "bindings.json"), "utf8"));
  assert.equal(raw.bindings.oc_1.sessionId, "session-2");
  assert.equal(raw.bindings.oc_1.history.length, 2);
  assert.equal(raw.bindings.oc_1.history[0]?.sessionId, "session-2");

  const reloaded = await Registry.load(dir, { projectId: "p2", agentId: "a2" });
  const binding = reloaded.bindingFor("oc_1");
  assert.equal(binding.sessionId, "session-2");
  assert.equal(binding.skillSticky, "lark-im");
  assert.equal(binding.history.length, 2);
  // 未写过的聊天用默认档位
  assert.equal(reloaded.bindingFor("oc_new").projectId, "p2");
});

test("Registry：历史去重置顶并封顶 10 条；损坏文件按全新开始", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-state-"));
  const registry = await Registry.load(dir, { projectId: "p", agentId: "a" });
  for (let i = 1; i <= 12; i++) {
    await registry.noteSession("oc_1", { sessionId: `s${i}`, title: `任务 ${i}` });
  }
  await registry.noteSession("oc_1", { sessionId: "s3", title: "任务 3" });
  const binding = registry.bindingFor("oc_1");
  assert.equal(binding.history.length, 10);
  assert.equal(binding.history[0]?.sessionId, "s3", "重复 session 置顶且不重复");

  await mkdtemp(join(tmpdir(), "pr-state-")).then(async (dir2) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir2, "bindings.json"), "{ 坏 JSON", "utf8");
    const recovered = await Registry.load(dir2, { projectId: "p", agentId: "a" });
    assert.equal(recovered.bindingFor("oc_1").history.length, 0);
  });
});

test("Registry：并发 update 串行落盘，最终文件是最后一次写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-state-"));
  const registry = await Registry.load(dir, { projectId: "p", agentId: "a" });
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      registry.update("oc_1", (b) => {
        b.sessionId = `s${i}`;
      }),
    ),
  );
  await registry.flush();
  const raw = JSON.parse(await readFile(join(dir, "bindings.json"), "utf8"));
  assert.equal(raw.bindings.oc_1.sessionId, "s19");
  const files = await readdir(dir);
  assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), [], "临时文件应已清掉");
});

// ---- T5：控制命令 ----

test("/new 后下一条消息开新会话；/sessions 与 /use 续聊", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  // 第一轮：新会话
  const first = channel.receive("第一问");
  await completeRun(server, [textDone("答 1"), runDone()]);
  await first;

  // /sessions 列出
  await channel.receive("/sessions");
  const sessionId = server.runs[0]?.sessionId ?? "";
  assert.match(channel.lastSent(), new RegExp(sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // /new 清绑定
  await channel.receive("/new");
  assert.match(channel.lastSent(), /已新开会话/);

  // 第二轮：不带 session_id
  const second = channel.receive("第二问");
  await completeRun(server, [textDone("答 2"), runDone()]);
  await second;
  const secondBody = server.requests.at(-1)?.body as { session_id?: string };
  assert.equal(secondBody.session_id, undefined, "/new 后不应带 session_id");

  // /use 2 切回第一个会话（列表新的在前）
  await channel.receive("/use 2");
  assert.match(channel.lastSent(), /已切回会话/);
  const third = channel.receive("第三问");
  await completeRun(server, [textDone("答 3"), runDone()]);
  await third;
  const thirdBody = server.requests.at(-1)?.body as { session_id?: string };
  assert.equal(thirdBody.session_id, sessionId);
});

test("/status 显示绑定与会话状态；/stop 中断当前 Run", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/status");
  assert.match(channel.lastSent(), /default_project/);
  assert.match(channel.lastSent(), /default_agent/);
  assert.match(channel.lastSent(), /尚未开始/);

  await channel.receive("/stop");
  assert.match(channel.lastSent(), /没有正在执行/);

  const running = channel.receive("长任务");
  await waitFor(() => server.runs.length > 0);
  await channel.receive("/stop");
  assert.match(channel.lastSent(), /已中断/);
  await running;
  assert.match(channel.lastSent(), /未正常完成（aborted）|已中断/);
});

test("/skill 一次性注入，用后即清；on 粘滞；off 关闭", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/skill lark-im");
  assert.match(channel.lastSent(), /下一条消息将使用 skill/);
  const first = channel.receive("把纪要发出来");
  await completeRun(server, [textDone("好"), runDone()]);
  await first;
  assert.equal(inputOf(server, 0), formatSkillInput("lark-im", "把纪要发出来"));

  // 一次性已清：下一条不再注入（仍续接同一会话）
  const second = channel.receive("普通消息");
  await completeRun(server, [textDone("好"), runDone()]);
  await second;
  assert.equal(inputOf(server, 1), "普通消息");

  // 粘滞
  await channel.receive("/skill lark-doc on");
  const third = channel.receive("第一条");
  await completeRun(server, [textDone("好"), runDone()]);
  await third;
  assert.equal(inputOf(server, 2), formatSkillInput("lark-doc", "第一条"));
  await channel.receive("/skill off");
  const fourth = channel.receive("第二条");
  await completeRun(server, [textDone("好"), runDone()]);
  await fourth;
  assert.equal(inputOf(server, 3), "第二条");
});

test("/help 含全部命令与风险提示；未知命令与非法参数有明确回复", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/help");
  const help = channel.lastSent();
  for (const command of ["/new", "/sessions", "/use", "/project", "/agent", "/model", "/thinking", "/workspace", "/skill", "/status", "/stop"]) {
    assert.ok(help.includes(command), `help 缺少 ${command}`);
  }
  assert.match(help, /风险提示/);

  await channel.receive("/nope");
  assert.match(channel.lastSent(), /未知命令/);
  await channel.receive("/use abc");
  assert.match(channel.lastSent(), /用法/);
  await channel.receive("/thinking ultra");
  assert.match(channel.lastSent(), /用法/);
});

// ---- router 纯函数 ----

test("router：全命令集解析", () => {
  assert.deepEqual(parseCommand("/help"), { kind: "help" });
  assert.deepEqual(parseCommand("/new"), { kind: "new" });
  assert.deepEqual(parseCommand("/sessions"), { kind: "sessions" });
  assert.deepEqual(parseCommand("/use 2"), { kind: "use", index: 2 });
  assert.deepEqual(parseCommand("/project"), { kind: "project" });
  assert.deepEqual(parseCommand("/project demo"), { kind: "project.select", name: "demo" });
  assert.deepEqual(parseCommand("/agent"), { kind: "agent" });
  assert.deepEqual(parseCommand("/agent coder"), { kind: "agent.select", name: "coder" });
  assert.deepEqual(parseCommand("/model"), { kind: "model" });
  assert.deepEqual(parseCommand("/model step-3"), { kind: "model.select", name: "step-3" });
  assert.deepEqual(parseCommand("/thinking HIGH"), { kind: "thinking", level: "high" });
  assert.deepEqual(parseCommand("/workspace /tmp/x"), { kind: "workspace", path: "/tmp/x" });
  assert.deepEqual(parseCommand("/skill a"), { kind: "skill", name: "a", mode: "once" });
  assert.deepEqual(parseCommand("/skill a on"), { kind: "skill", name: "a", mode: "on" });
  assert.deepEqual(parseCommand("/skill off"), { kind: "skill", name: null, mode: "off" });
  assert.deepEqual(parseCommand("/status"), { kind: "status" });
  assert.deepEqual(parseCommand("/stop"), { kind: "stop" });
  assert.deepEqual(parseCommand("普通消息"), { kind: "run", text: "普通消息" });
  assert.equal(parseCommand("/use x").kind, "invalid");
  assert.equal(parseCommand("/bogus").kind, "unknown");
});

test("router：helpText 常驻风险提示", () => {
  assert.match(helpText(), /全权限驱动/);
});
