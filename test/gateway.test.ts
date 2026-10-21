import assert from "node:assert/strict";
import { test } from "node:test";

import { Gateway, BUSY_HINT } from "../src/gateway.js";
import { LaneQueue } from "../src/lanes.js";
import { createLogger } from "../src/logger.js";
import { AmspClient, SessionBusyError, TooManyRunsError } from "../src/penguin/amsp.js";
import { loadConfig } from "../src/config.js";
import { FakeAmspServer, runDone, textDelta, textDone } from "./helpers/fake-amsp.js";
import { FakeChannel } from "./helpers/fake-channel.js";
import { parseInput } from "../src/router.js";
import { formatFinalText, formatRunFailure } from "../src/render.js";

const silent = createLogger("error", () => {});

function makeGateway(server: FakeAmspServer, channel = new FakeChannel()) {
  const config = loadConfig({
    AMSP_BASE_URL: "http://localhost/api/amsp/v1",
    DEFAULT_PROJECT_ID: "default_project",
    DEFAULT_AGENT_ID: "default_agent",
  });
  const gateway = new Gateway({
    config,
    channel,
    lanes: new LaneQueue(),
    logger: silent,
    bindingFor: () => ({ projectId: "default_project", agentId: "default_agent", sessionId: null }),
    clientFor: async ({ projectId, agentId }) =>
      new AmspClient({
        baseUrl: server.baseUrl,
        agent: `${projectId}/${agentId}`,
        apiKey: "penguin_test",
        fetch: server.fetch,
      }),
  });
  return { gateway, channel };
}

/** 等下一个 run 出现，推完事件后收尾。 */
async function completeRun(server: FakeAmspServer, events: Parameters<FakeAmspServer["push"]>[1][]) {
  await waitFor(() => server.runs.length > 0);
  const run = server.lastRun();
  for (const event of events) server.push(run, event);
  server.close(run);
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

test("最小闭环：飞书一句话 → AMSP run → 同聊天收到一条最终回复", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = makeGateway(server, channel);
  await gateway.start();

  const received = channel.receive("现在几点");
  await completeRun(server, [textDelta("现在是"), textDelta("20:00"), textDone("现在是20:00"), runDone()]);
  await received;

  assert.equal(server.requests.length, 1);
  assert.deepEqual(server.requests[0]?.body, { input: "现在几点" });
  assert.equal(channel.sent.length, 1);
  assert.match(channel.lastSent(), /现在是20:00/);
  assert.match(channel.lastSent(), /用量 42 tokens/);
  assert.equal(channel.edited.length, 0, "T4 不做流式，不应编辑消息");
});

test("最小闭环：Run 进行中同聊天再来消息 → 只提示不排队，不并发第二个 Run", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = makeGateway(server, channel);
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

test("最小闭环：409 会话忙 → 用户看到进行中提示", async () => {
  const server = new FakeAmspServer();
  server.nextError = { status: 409, body: { error: { code: "task_in_progress", message: "This Session already has a Task in progress." } } };
  const channel = new FakeChannel();
  const { gateway } = makeGateway(server, channel);
  await gateway.start();
  await channel.receive("hello");
  assert.match(channel.lastSent(), /Task in progress/);
});

test("最小闭环：429 并发超限 → 用户看到明确提示", async () => {
  const server = new FakeAmspServer();
  server.nextError = { status: 429, body: { error: { code: "too_many_runs", message: "too many" } } };
  const channel = new FakeChannel();
  const { gateway } = makeGateway(server, channel);
  await gateway.start();
  await channel.receive("hello");
  assert.match(channel.lastSent(), /too many/);
});

test("最小闭环：未知命令给出提示，不触发 Run", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = makeGateway(server, channel);
  await gateway.start();
  await channel.receive("/nope 你好");
  assert.match(channel.lastSent(), /未知命令/);
  assert.equal(server.requests.length, 0);
});

test("最小闭环：流断裂 → 用户看到执行失败而不是静默", async () => {
  const server = new FakeAmspServer();
  const channel = new FakeChannel();
  const { gateway } = makeGateway(server, channel);
  await gateway.start();

  const received = channel.receive("长任务");
  await waitFor(() => server.runs.length > 0);
  server.breakStream(server.lastRun());
  await received;
  assert.match(channel.lastSent(), /执行失败/);
});

test("router：纯函数解析 run / 未知命令", () => {
  assert.deepEqual(parseInput("现在几点"), { kind: "run", text: "现在几点" });
  assert.deepEqual(parseInput("  /new  "), { kind: "unknown-command", command: "new" });
  assert.deepEqual(parseInput("/model gpt-5"), { kind: "unknown-command", command: "model" });
  assert.deepEqual(parseInput("1/2 不是命令"), { kind: "run", text: "1/2 不是命令" });
});

test("render：最终文本含正文与用量；失败文案可读", () => {
  const ok = formatFinalText({
    sessionId: "s1",
    status: "completed",
    text: "答案",
    usage: { cache_read: 0, cache_write: 0, output: 1, total: 42 },
    sessionUsage: null,
    requests: 2,
  });
  assert.match(ok, /答案/);
  assert.match(ok, /用量 42 tokens/);

  const aborted = formatFinalText({
    sessionId: "s1",
    status: "aborted",
    text: "半句",
    error: { code: "user_abort", message: "stopped" },
    usage: { cache_read: 0, cache_write: 0, output: 0, total: 0 },
    sessionUsage: null,
    requests: 1,
  });
  assert.match(aborted, /未正常完成（aborted）/);
  assert.match(aborted, /stopped/);

  assert.match(formatRunFailure(new SessionBusyError("busy")), /执行失败：busy/);
  assert.match(formatRunFailure(new TooManyRunsError("full")), /执行失败：full/);
});
