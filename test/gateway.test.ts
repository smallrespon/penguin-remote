import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Gateway, type TierController } from "../src/gateway.js";
import { Lanes } from "../src/lanes.js";
import { createLogger } from "../src/logger.js";
import { Registry } from "../src/registry.js";
import { RunLog } from "../src/runlog.js";
import { loadConfig } from "../src/config.js";
import { formatSkillInput, helpText, parseCommand } from "../src/router.js";
import { escapeRegExp } from "../src/text.js";
import { FakeSessionServer, frame, sessionClient, waitForTask, type FrameScript } from "./helpers/fake-sessions.js";
import { flatText } from "./helpers/flat-text.js";
import { BUSY_HINT, PLACEHOLDER_TEXT } from "../src/render.js";
import { FakeChannel } from "./helpers/fake-channel.js";
import { MAX_INLINE_IMAGE_BYTES } from "../src/images.js";

const silent = createLogger("error", () => {});

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    OWNER_API_BASE_URL: "http://localhost/api",
    DEFAULT_PROJECT_ID: "default_project",
    DEFAULT_AGENT_ID: "default_agent",
    ...overrides,
  });
}

async function makeGateway(
  server: FakeSessionServer,
  channel = new FakeChannel(),
  stateDir?: string,
  tiers?: TierController,
  configOverrides: Record<string, string> = {},
) {
  const dir = stateDir ?? (await mkdtemp(join(tmpdir(), "pr-state-")));
  const registry = await Registry.load(dir, {
    projectId: "default_project",
    agentId: "default_agent",
  });
  const runLog = await RunLog.load(dir);
  const gateway = new Gateway({
    config: makeConfig(configOverrides),
    channel,
    lanes: new Lanes(),
    logger: silent,
    registry,
    runLog,
    sessions: sessionClient(server),
    ...(tiers ? { tiers } : {}),
  });
  return { gateway, channel, registry, runLog, stateDir: dir };
}

/** 一轮正常 Run 的帧脚本：running → 正文 → 用量 → idle → DONE。 */
function happyScript(text = "好"): FrameScript {
  return [
    frame.taskState("idle"),
    frame.taskState("running"),
    frame.omni({ type: "text", role: "assistant", text, stop_reason: "completed" }),
    frame.event({ type: "token_usage", request: { total: 42 }, session: { total: 42 } }),
    frame.event({ type: "request_end", status: "completed" }),
    frame.taskState("idle"),
    frame.done(),
  ];
}

/** 跑到 running 就挂住（忙状态测试用）。 */
function hangingScript(): FrameScript {
  return [frame.taskState("idle"), frame.taskState("running"), { hang: true }];
}

/** 等 Bridge 把任务投递出去（此刻订阅已就绪），返回会话 id。 */
async function startedSession(server: FakeSessionServer): Promise<string> {
  return waitForTask(server);
}

/** 建会话请求列表。 */
function createRequests(server: FakeSessionServer) {
  return server.requests.filter((r) => r.method === "POST" && r.path.endsWith("/sessions"));
}

/** 取第 n 次 tasks 投递的正文。 */
function inputOf(server: FakeSessionServer, index: number): string {
  const body = server.taskPosts()[index]?.body as { input?: Array<{ type: string; text: string }> } | undefined;
  return body?.input?.[0]?.text ?? "";
}

/** 最近一次 tasks 投递的路径。 */
function lastTaskPath(server: FakeSessionServer): string {
  return server.taskPosts().at(-1)?.path ?? "";
}

/** 假服务器不解析帧：测试手动把会话状态拨回 idle（模拟任务跑完）。 */
function markIdle(server: FakeSessionServer, sessionId: string): void {
  const session = server.sessions.get(sessionId);
  if (session !== undefined) session.status = "idle";
}

// ---- T4 回归：最小闭环 ----

test("最小闭环：飞书一句话 → 会话 API → 同聊天收到一条最终回复", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("现在是20:00");
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  const received = channel.receive("现在几点");
  await received;

  // 走 chat 同款路径建会话：普通会话（source=user），不带任何 AMSP 痕迹
  const creates = createRequests(server);
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.path, "/projects/default_project/agents/default_agent/sessions");
  assert.deepEqual(creates[0]?.body, { client: "cli", approvalMode: "allow-all" });
  // 投递走 tasks，input 是分段文本
  const task = server.taskPosts()[0];
  assert.deepEqual(task?.body, { input: [{ type: "text", text: "现在几点" }] });

  // T6：先发占位消息，最终内容通过更新落到同一条消息上（ADR-0006：承载为交互卡片）
  assert.equal(channel.sent.length, 1);
  assert.equal(flatText(channel.sent[0]?.message ?? { kind: "text", text: "" }), PLACEHOLDER_TEXT);
  const finalEdit = channel.edited.at(-1)?.message ?? { kind: "text", text: "" };
  assert.match(flatText(finalEdit), /现在是20:00/);
  assert.match(flatText(finalEdit), /用量 42 tokens/);
});

test("最小闭环：Run 进行中同聊天再来消息 → 只提示不排队", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = hangingScript();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  const first = channel.receive("第一个任务");
  const sessionId = await startedSession(server);
  await channel.receive("第二个任务");
  assert.equal(channel.sent.length, 2, "占位消息 + 忙提示");
  assert.equal(channel.lastSent(), BUSY_HINT);
  assert.equal(
    server.taskPosts().length,
    1,
    "不应发起第二个 Run",
  );

  // 收尾：补发正文与 idle
  server.pushLive(sessionId, frame.omni({ type: "text", role: "assistant", text: "完成", stop_reason: "completed" }));
  server.pushLive(sessionId, frame.taskState("idle"));
  server.pushLive(sessionId, frame.done());
  await first;
  assert.equal(
    server.taskPosts().length,
    1,
  );
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

test("Registry：会话按 (project, agent) 隔离；老登记按默认档位算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-state-"));
  const registry = await Registry.load(dir, { projectId: "p", agentId: "a" });
  await registry.noteSession("oc_1", {
    sessionId: "s_a",
    title: "默认 Agent 的会话",
    projectId: "p",
    agentId: "a",
  });
  await registry.noteSession("oc_1", {
    sessionId: "s_b",
    title: "别的 Agent 的会话",
    projectId: "p",
    agentId: "coder",
  });

  const onA = registry.bindingFor("oc_1");
  assert.deepEqual(
    registry.sessionsFor(onA).map((s) => s.sessionId),
    ["s_a"],
  );
  // 切到 coder：只看得到 coder 的会话
  await registry.update("oc_1", (b) => {
    b.agentId = "coder";
    b.sessionId = null;
  });
  assert.deepEqual(
    registry.sessionsFor(registry.bindingFor("oc_1")).map((s) => s.sessionId),
    ["s_b"],
  );

  // 老登记（没有归属字段，来自只支持默认档位的版本）仍算默认档位，升级不丢历史
  const legacyDir = await mkdtemp(join(tmpdir(), "pr-state-"));
  const legacy = await Registry.load(legacyDir, { projectId: "p", agentId: "a" });
  await legacy.update("oc_1", (b) => {
    b.history = [{ sessionId: "s_old", title: "老会话", at: "2026-01-01T00:00:00.000Z" }];
  });
  assert.deepEqual(
    legacy.sessionsFor(legacy.bindingFor("oc_1")).map((s) => s.sessionId),
    ["s_old"],
  );
  await legacy.update("oc_1", (b) => {
    b.agentId = "coder";
  });
  assert.deepEqual(legacy.sessionsFor(legacy.bindingFor("oc_1")), []);
});

test("/new 后下一条消息开新会话；/sessions 与 /use 续聊", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("答 1");
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  // 第一轮：新会话
  const first = channel.receive("第一问");
  await first;
  const sessionId = server.lastTaskSession() ?? "";

  // /sessions 列出
  await channel.receive("/sessions");
  assert.match(channel.lastSent(), new RegExp(escapeRegExp(sessionId)));

  // /new 清绑定
  await channel.receive("/new");
  assert.match(channel.lastSent(), /已新开会话/);

  // 第二轮：新建另一个会话
  server.defaultScript = happyScript("答 2");
  const second = channel.receive("第二问");
  await second;
  const secondSession = server.lastTaskSession() ?? "";
  assert.notEqual(secondSession, sessionId, "/new 后应新建会话");
  assert.equal(createRequests(server).length, 2);

  // /use 2 切回第一个会话（列表新的在前）
  await channel.receive("/use 2");
  assert.match(channel.lastSent(), /已切回会话/);
  server.defaultScript = happyScript("答 3");
  const third = channel.receive("第三问");
  await third;
  assert.equal(lastTaskPath(server), `/sessions/${sessionId}/tasks`, "续接打到旧会话上");
  assert.equal(createRequests(server).length, 2, "续接不建新会话");
});

test("换 Agent 后 /sessions 与 /use 只看当前 Agent 的会话", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("答 1");
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  const first = channel.receive("第一问");
  await first;
  const sessionId = server.lastTaskSession() ?? "";

  // /agent coder（TierCommands 的行为：改绑定并重置会话）
  await registry.update("oc_chat", (b) => {
    b.agentId = "coder";
    b.sessionId = null;
  });

  await channel.receive("/sessions");
  assert.match(channel.lastSent(), /没有未归档的会话/);

  // 别人的会话即使用 /use 1 也切不过去
  await channel.receive("/use 1");
  assert.match(channel.lastSent(), /没有第 1 个会话/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, null);

  // 换回默认 Agent：历史回来，可以续聊
  await registry.update("oc_chat", (b) => {
    b.agentId = "default_agent";
  });
  await channel.receive("/sessions");
  assert.match(channel.lastSent(), new RegExp(escapeRegExp(sessionId)));
  await channel.receive("/use 1");
  assert.match(channel.lastSent(), /已切回会话/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, sessionId);
});

// ---- T10：会话列表实时化（ADR-0008）----

test("/sessions 实时列出服务端未归档会话：→ 标当前会话、标题拍平并截断", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  // 远程（Web / CLI）新建的会话：Bridge 本地 Registry 历史里没有，只能来自服务端列表
  server.addSession({
    sessionId: "session-remote-1",
    title: "远程会话\n第二行标题",
    modelId: "step-3",
    lastActiveAt: "2026-10-22T10:00:00.000Z",
  });
  server.addSession({ sessionId: "session-remote-2", title: null, lastActiveAt: "2026-10-22T09:00:00.000Z" });
  server.addSession({
    sessionId: "session-remote-3",
    title: "超长标题".repeat(20),
    lastActiveAt: "2026-10-22T08:00:00.000Z",
  });
  // 已归档：默认列表不出现
  server.addSession({ sessionId: "session-archived", archived: true, lastActiveAt: "2026-10-22T11:00:00.000Z" });

  await registry.update("oc_chat", (b) => {
    b.sessionId = "session-remote-1";
  });

  await channel.receive("/sessions");
  const text = channel.lastSent();
  assert.match(text, /\*\*未归档会话\*\*（共 3 个）/);
  assert.ok(!text.includes("显示最近"), "不超过 50 条时不加截断注明");
  assert.ok(
    text.includes("→ 1. 远程会话 第二行标题 — 2026-10-22 10:00 — `step-3` — `session-remote-1`"),
    `当前会话行首应带 →、换行拍平、时间取 lastActiveAt：${text}`,
  );
  assert.ok(text.includes("2. （无标题） — 2026-10-22 09:00 — `session-remote-2`"), "空标题给占位");
  const longTitle = "超长标题".repeat(20);
  assert.ok(text.includes(`3. ${longTitle.slice(0, 40)}`), "长标题截断到 40 字");
  assert.ok(!text.includes(longTitle), "截断后不应出现完整标题");
  assert.ok(!text.includes("session-archived"), "已归档会话不列");
  assert.match(text, /用 `\/use <序号>` 切回去续聊。/);
});

test("/use 跳到只存在于服务端实时列表的远程会话；越界提示不变", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  server.addSession({ sessionId: "session-remote-1", title: "远程会话", lastActiveAt: "2026-10-22T10:00:00.000Z" });

  await channel.receive("/use 1");
  assert.match(channel.lastSent(), /已切回会话 `session-remote-1`/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, "session-remote-1", "切换只改本聊天绑定");

  // 越界：保持现有文案，且不动绑定
  await channel.receive("/use 2");
  assert.match(channel.lastSent(), /⚠️ 没有第 2 个会话，`\/sessions` 查看列表。/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, "session-remote-1");
});

test("/sessions 超过 50 条：头部注明总数、只显示最近 50 个，/use 只跳得动列表内的（ADR-0011）", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  // 60 个未归档会话：s60 最新、s1 最旧（lastActiveAt 每分钟一档）
  for (let i = 1; i <= 60; i += 1) {
    const at = new Date(Date.parse("2026-10-22T09:00:00.000Z") + i * 60_000).toISOString();
    server.addSession({ sessionId: `s${i}`, title: `会话 ${i}`, lastActiveAt: at });
  }

  await channel.receive("/sessions");
  const text = channel.lastSent();
  assert.match(text, /\*\*未归档会话\*\*（共 60 个）/, "头部注明截断前的真实总数");
  assert.ok(
    text.includes("（显示最近 50 个，更早的会话未列出、暂不可 `/use` 跳转）"),
    `超过 50 条时如实注明截断：${text}`,
  );
  assert.ok(text.includes("1. 会话 60"), "最新的一条排第 1");
  assert.ok(text.includes("50. 会话 11"), "第 50 条只到倒数第 50 新的会话");
  assert.ok(!text.includes("`s10`"), "更早的会话不列出");
  assert.equal(
    text.split("\n").filter((line) => /^\d+\. /.test(line)).length,
    50,
    "只渲染 50 行",
  );
  assert.match(text, /用 `\/use <序号>` 切回去续聊。/);

  // /use 打的是同一份（截断后的）列表：第 50 个跳得动，第 51 个不可跳
  await channel.receive("/use 50");
  assert.match(channel.lastSent(), /已切回会话 `s11`/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, "s11");

  await channel.receive("/use 51");
  assert.match(channel.lastSent(), /⚠️ 没有第 51 个会话/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, "s11", "越界不动绑定");
});

test("实时列表查询失败：/sessions 与 /use 退回本地历史并首行注明", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("答 1");
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  const first = channel.receive("第一问");
  await first;
  const sessionId = server.lastTaskSession() ?? "";
  assert.notEqual(sessionId, "");

  // 实时查询挂掉：退回 Registry 本地历史
  server.nextListStatus = 500;
  await channel.receive("/sessions");
  const text = channel.lastSent();
  assert.ok(text.startsWith("⚠️ 实时列表查询失败，显示本地历史"), `首行应注明兜底：${text}`);
  assert.ok(text.includes(sessionId), "仍列出本地历史会话");
  assert.ok(text.includes("**本地历史会话**"), "兜底路径用本地历史口径，不冒充未归档全量");

  server.nextListStatus = 500;
  await channel.receive("/use 1");
  assert.ok(channel.lastSent().startsWith("⚠️ 实时列表查询失败，显示本地历史"), "换会话也要注明列表来源降级");
  assert.match(channel.lastSent(), /已切回会话/);
  assert.equal(registry.bindingFor("oc_chat").sessionId, sessionId);
});

test("/sessions 无会话：实时为空提示「没有未归档的会话」，本地兜底为空提示「还没有历史会话」", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/sessions");
  assert.match(channel.lastSent(), /没有未归档的会话/);

  await channel.receive("/use 1");
  assert.match(channel.lastSent(), /没有第 1 个会话/);

  // 兜底路径（本地历史也为空）：沿用旧文案
  server.nextListStatus = 500;
  await channel.receive("/sessions");
  assert.match(channel.lastSent(), /还没有历史会话/);
});

test("/status 显示绑定与会话状态；/stop 中断当前 Run", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = hangingScript();
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
  const sessionId = await startedSession(server);
  await channel.receive("/stop");
  assert.match(channel.lastSent(), /已中断/);
  await running;
  // 定稿落在占位消息上，写明未正常完成
  const final = flatText(channel.edited.at(-1)?.message ?? { kind: "text", text: "" });
  assert.match(final, /未正常完成（aborted）/);
  assert.ok(server.requests.some((r) => r.path.endsWith("/abort")), "断流/中断要显式 abort");

  // 中断后会话状态可查
  markIdle(server, sessionId);
  await channel.receive("/status");
  assert.match(channel.lastSent(), /会话状态.*idle/s);
});

test("/skill 一次性注入，用后即清；on 粘滞；off 关闭", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/skill lark-im");
  assert.match(channel.lastSent(), /下一条消息将使用 skill/);
  const first = channel.receive("把纪要发出来");
  await first;
  assert.equal(inputOf(server, 0), formatSkillInput("lark-im", "把纪要发出来"));

  // 一次性已清：下一条不再注入（仍续接同一会话）
  const second = channel.receive("普通消息");
  await second;
  assert.equal(inputOf(server, 1), "普通消息");

  // 粘滞
  await channel.receive("/skill lark-doc on");
  const third = channel.receive("第一条");
  await third;
  assert.equal(inputOf(server, 2), formatSkillInput("lark-doc", "第一条"));
  await channel.receive("/skill off");
  const fourth = channel.receive("第二条");
  await fourth;
  assert.equal(inputOf(server, 3), "第二条");
});

test("/help 含全部命令与风险提示；未知命令与非法参数有明确回复", async () => {
  const server = new FakeSessionServer();
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

test("Run 进行中再来消息：不排队、也不消耗这个聊天的一次性 skill", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = hangingScript();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  // 先让一个任务在跑
  const first = channel.receive("任务一");
  const sessionId = await startedSession(server);

  // 忙时设一次性 skill，再插一条普通消息：只提示，skill 不被消耗
  await channel.receive("/skill lark-im");
  await channel.receive("插嘴");
  assert.equal(channel.lastSent(), BUSY_HINT);

  server.pushLive(sessionId, frame.omni({ type: "text", role: "assistant", text: "好", stop_reason: "completed" }));
  server.pushLive(sessionId, frame.taskState("idle"));
  server.pushLive(sessionId, frame.done());
  await first;

  // 第二个任务续接同一会话：脚本换成能正常收尾的
  server.defaultScript = happyScript();
  const second = channel.receive("继续用 skill");
  await second;
  assert.equal(inputOf(server, 1), formatSkillInput("lark-im", "继续用 skill"));
});

test("/status 显示上次 Run 用量；/sessions 列出模型列", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("答 1");
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  // 本聊天设了模型档位：建会话时下发，sessionInfo 回得来
  await registry.update("oc_chat", (b) => {
    b.model = { provider: "stepfun", modelId: "step-3" };
  });

  const first = channel.receive("第一个任务");
  await first;

  await channel.receive("/status");
  assert.match(channel.lastSent(), /上次 Run/);
  assert.match(channel.lastSent(), /42 tokens/);
  assert.match(channel.lastSent(), /step-3/);

  await channel.receive("/sessions");
  assert.match(channel.lastSent(), /step-3/);
});

// ---- 档位下发（ADR-0005）----

test("档位下发：binding 里的 model/thinking/workspace 随新建会话下发，续接不带", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("答 1");
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  await registry.update("oc_chat", (b) => {
    b.model = { provider: "stepfun", modelId: "step-3" };
    b.thinkingLevel = "high";
    b.workspace = "/tmp/demo";
  });

  const first = channel.receive("第一问");
  const sessionId = await startedSession(server);
  await first;

  // 建会话带齐档位（model 以 provider+modelId 成对下发）；thinkingLevel 建后 PATCH
  const create = createRequests(server)[0];
  assert.deepEqual(create?.body, {
    client: "cli",
    approvalMode: "allow-all",
    workspace: "/tmp/demo",
    modelId: "step-3",
    provider: "stepfun",
  });
  const patch = server.requests.find((r) => r.method === "PATCH");
  assert.equal(patch?.path, `/sessions/${sessionId}`);
  assert.deepEqual(patch?.body, { thinkingLevel: "high" });

  // 续接同一会话：不再建会话、不再 PATCH，档位原样
  const second = channel.receive("第二问");
  await second;
  assert.equal(createRequests(server).length, 1, "续接不建新会话");
  assert.equal(server.requests.filter((r) => r.method === "PATCH").length, 1, "续接不改档位");
  assert.equal(lastTaskPath(server), `/sessions/${sessionId}/tasks`);
});

// ---- T7：档位命令分发 ----

test("档位命令：/project /agent /model /thinking /workspace 都带上 chatId 转发", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { calls, controller } = fakeTiers();
  const { gateway } = await makeGateway(server, channel, undefined, controller);
  await gateway.start();

  await channel.receive("/project");
  assert.deepEqual(calls.at(-1), "listProjects:oc_chat");
  assert.equal(channel.lastSent(), "PROJECTS");

  await channel.receive("/project demo");
  assert.deepEqual(calls.at(-1), "selectProject:oc_chat:demo");

  await channel.receive("/agent");
  assert.deepEqual(calls.at(-1), "listAgents:oc_chat");

  await channel.receive("/agent coder");
  assert.deepEqual(calls.at(-1), "selectAgent:oc_chat:coder");

  await channel.receive("/model");
  assert.deepEqual(calls.at(-1), "listModels:oc_chat");

  await channel.receive("/model step-3");
  assert.deepEqual(calls.at(-1), "selectModel:oc_chat:step-3");

  await channel.receive("/thinking high");
  assert.deepEqual(calls.at(-1), "selectThinking:oc_chat:high");

  await channel.receive("/workspace /tmp/x");
  assert.deepEqual(calls.at(-1), "selectWorkspace:oc_chat:/tmp/x");
});

test("档位命令：控制器缺失时明确提示，不静默失败", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/project");
  assert.match(channel.lastSent(), /档位切换未启用/);
  await channel.receive("/model step-3");
  assert.match(channel.lastSent(), /档位切换未启用/);
});

test("/status 注入档位回显（describeTiers）", async () => {
  const server = new FakeSessionServer();
  const channel = new FakeChannel();
  const { calls, controller } = fakeTiers();
  const { gateway } = await makeGateway(server, channel, undefined, controller);
  await gateway.start();

  await channel.receive("/status");
  assert.match(channel.lastSent(), /模型：`stepfun\/step-3`/);
  assert.deepEqual(calls, ["describeTiers:oc_chat"]);
});

/** 记录调用的假 TierController（档位命令由 owner 动态模式实现，这里只验分发）。 */
function fakeTiers() {
  const calls: string[] = [];
  const controller: TierController = {
    listProjects: async (chatId) => (calls.push(`listProjects:${chatId}`), "PROJECTS"),
    selectProject: async (chatId, name) => (calls.push(`selectProject:${chatId}:${name}`), "PICKED"),
    listAgents: async (chatId) => (calls.push(`listAgents:${chatId}`), "AGENTS"),
    selectAgent: async (chatId, name) => (calls.push(`selectAgent:${chatId}:${name}`), "PICKED"),
    listModels: async (chatId) => (calls.push(`listModels:${chatId}`), "MODELS"),
    selectModel: async (chatId, name) => (calls.push(`selectModel:${chatId}:${name}`), "PICKED"),
    selectThinking: async (chatId, level) => (calls.push(`selectThinking:${chatId}:${level}`), "PICKED"),
    selectWorkspace: async (chatId, path) => (calls.push(`selectWorkspace:${chatId}:${path}`), "PICKED"),
    describeTiers: async (chatId) => (calls.push(`describeTiers:${chatId}`), "- 模型：`stepfun/step-3`"),
  };
  return { calls, controller };
}

// ---- T9：访问控制 ----

test("allowlist：命中 chat_id 或 open_id 才响应，其余静默忽略", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("在");
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel, undefined, undefined, {
    ALLOWLIST: "oc_chat,ou_friend",
  });
  await gateway.start();

  // 命中的聊天：正常跑
  const ok = channel.receive("在吗");
  await ok;
  assert.equal(
    server.taskPosts().length,
    1,
  );
  assert.match(flatText(channel.edited.at(-1)?.message ?? { kind: "text", text: "" }), /在/);

  // 未命中的聊天：不回复、不发起 Run
  const before = channel.sent.length;
  await channel.receive("悄悄话", { chatId: "oc_stranger", senderId: "ou_stranger" });
  assert.equal(channel.sent.length, before, "不该有任何回复");
  assert.equal(
    server.taskPosts().length,
    1,
    "不该发起 Run",
  );

  // 命中 sender_id（私聊陌生人）也算数
  const allowed = channel.receive("我也在名单里", { chatId: "oc_stranger", senderId: "ou_friend" });
  await allowed;
  assert.equal(
    server.taskPosts().length,
    2,
  );
});

test("allowlist 为空时开放访问（默认）", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();
  const received = channel.receive("任意来源");
  await received;
  assert.equal(
    server.taskPosts().length,
    1,
  );
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

// ---- T12：图片入站投递（ADR-0009）----

/** PNG 8 字节签名：sniffMimeType 认得出、体积极小。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** JPEG 魔数 + 补足字节：嗅探通过但超过服务端 20MB inline 上限。 */
function oversizedJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_INLINE_IMAGE_BYTES)]);
}

test("图片入站：handleRun 下载 → data URL，与文本一起投递 parts", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("图里是一只猫");
  const channel = new FakeChannel();
  channel.downloadImageResults = [PNG_SIGNATURE];
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("这张图是什么", { images: ["img_1"] });

  // 下载走 messageId + fileKey，拿到字节后转 data URL 跟在文本 part 之后
  assert.deepEqual(channel.imageDownloads, [{ messageId: "om_in_1", fileKey: "img_1" }]);
  assert.deepEqual(server.taskInputParts(), [
    { type: "text", text: "这张图是什么" },
    { type: "image_url", imageUrl: `data:image/png;base64,${PNG_SIGNATURE.toString("base64")}` },
  ]);
  assert.match(flatText(channel.edited.at(-1)?.message ?? { kind: "text", text: "" }), /图里是一只猫/);
});

test("纯图片消息：只投 image_url parts，不注入占位文本，标题为「（图片消息）」", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("看到一张图");
  const channel = new FakeChannel();
  channel.downloadImageResults = [PNG_SIGNATURE];
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("", { images: ["img_only"] });

  assert.deepEqual(server.taskInputParts(), [
    { type: "image_url", imageUrl: `data:image/png;base64,${PNG_SIGNATURE.toString("base64")}` },
  ]);
  assert.equal(registry.bindingFor("oc_chat").history[0]?.title, "（图片消息）");
});

test("图片下载失败：Run 按失败处理，回复脱敏错误，不投任务也不发占位卡", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript();
  const channel = new FakeChannel();
  channel.failDownload = true;
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("看图", { images: ["img_bad"] });

  assert.equal(server.taskPosts().length, 0, "下载失败不应投递任务");
  assert.equal(channel.sent.length, 1, "只有错误回复，没有占位卡");
  assert.match(channel.lastSent(), /^出错了：FakeChannel: downloadImage\(img_bad\) failed$/);
});

test("多张图片：ok 的转 data URL，超限的跳过并把注明拼进输入文本", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("好");
  const channel = new FakeChannel();
  channel.downloadImageResults = [PNG_SIGNATURE, oversizedJpeg()];
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("两张图", { images: ["img_ok", "img_huge"] });

  // 串行下载：按 message.images 顺序
  assert.deepEqual(channel.imageDownloads, [
    { messageId: "om_in_1", fileKey: "img_ok" },
    { messageId: "om_in_1", fileKey: "img_huge" },
  ]);
  assert.deepEqual(server.taskInputParts(), [
    { type: "text", text: "两张图\n（有图片超过 20MB 上限，未发送）" },
    { type: "image_url", imageUrl: `data:image/png;base64,${PNG_SIGNATURE.toString("base64")}` },
  ]);
});

test("skill 注入与图片共存：文本被 skill 包裹，图片 part 不受影响", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("好");
  const channel = new FakeChannel();
  channel.downloadImageResults = [PNG_SIGNATURE];
  const { gateway } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("/skill lark-im");
  await channel.receive("总结这张图", { images: ["img_1"] });

  assert.deepEqual(server.taskInputParts(), [
    { type: "text", text: formatSkillInput("lark-im", "总结这张图") },
    { type: "image_url", imageUrl: `data:image/png;base64,${PNG_SIGNATURE.toString("base64")}` },
  ]);
});

test("历史标题清洗：图片占位符不进标题（解码层通常已剥，这里是网关兜底）", async () => {
  const server = new FakeSessionServer();
  server.defaultScript = happyScript("好");
  const channel = new FakeChannel();
  const { gateway, registry } = await makeGateway(server, channel);
  await gateway.start();

  await channel.receive("看图 ![Image](img_x) 谢谢");

  assert.equal(registry.bindingFor("oc_chat").history[0]?.title, "看图 谢谢");
});
