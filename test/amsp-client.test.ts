import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AmspClient,
  DEFAULT_RETRY_AFTER_MS,
  RunStreamError,
  SessionBusyError,
  TooManyRunsError,
  parseRetryAfter,
} from "../src/penguin/amsp.js";
import {
  FakeAmspServer,
  runDone,
  textDelta,
  toolCallDone,
  toolResultDone,
  type FakeRun,
} from "./helpers/fake-amsp.js";

import { waitFor } from "./helpers/wait.js";

function makeClient(server: FakeAmspServer): AmspClient {
  return new AmspClient({
    baseUrl: server.baseUrl,
    agent: { projectId: "default_project", agentId: "default_agent" },
    apiKey: "penguin_test_key",
    fetch: server.fetch,
  });
}

/** 跑一个「推事件 → 收尾」的完整 run，返回 outcome 与收集到的事件。 */
async function drive(
  server: FakeAmspServer,
  script: (run: FakeRun) => void,
  options: { sessionId?: string } = {},
) {
  const events: string[] = [];
  const runsBefore = server.runs.length;
  const run = makeClient(server).streamRun({
    input: "现在几点",
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    onEvent: (event) => events.push(event.type),
  });
  const outcomePromise = run.result();
  await waitFor(() => server.runs.length > runsBefore);
  const fakeRun = server.lastRun();
  script(fakeRun);
  const outcome = await outcomePromise;
  return { outcome, events, run };
}

test("AMSP 客户端：完整事件序列 run.started … run.done，并回调每个事件", async () => {
  const server = new FakeAmspServer();
  const { outcome, events } = await drive(server, (run) => {
    server.push(run, textDelta("现在"));
    server.push(run, textDelta("八点"));
    server.push(run, toolCallDone("call_1", "exec_command", '{"command":"date"}'));
    server.push(run, toolResultDone("call_1", "Mon Oct 21 20:00:00 CST 2026"));
    server.push(run, runDone());
    server.close(run);
  });

  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0]?.method, "POST");
  assert.match(server.requests[0]?.path ?? "", /\/agents\/default_project\/default_agent\/runs$/);
  assert.deepEqual(server.requests[0]?.body, { input: "现在几点" });

  assert.deepEqual(events, [
    "run.started",
    "text.delta",
    "text.delta",
    "tool_call.done",
    "tool_result.done",
    "run.done",
  ]);
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.requests, 1);
  assert.equal(outcome.usage.total, 42);
  assert.equal(outcome.sessionId, server.lastRun().sessionId);
});

test("AMSP 客户端：不带 session_id 时从 run.started 拿到新会话；带 session_id 时正确续接", async () => {
  const server = new FakeAmspServer();
  await drive(server, (run) => {
    server.push(run, runDone());
    server.close(run);
  });
  const newSessionId = server.runs[0]?.sessionId ?? "";
  assert.match(newSessionId, /^session-test-/);

  const { outcome } = await drive(
    server,
    (run) => {
      server.push(run, runDone());
      server.close(run);
    },
    { sessionId: newSessionId },
  );
  assert.equal(outcome.sessionId, newSessionId);
  assert.deepEqual(server.requests[1]?.body, { input: "现在几点", session_id: newSessionId });
});

test("AMSP 客户端：409 映射为 SessionBusyError；429 按 Retry-After 退避", async () => {
  const busy = new FakeAmspServer();
  busy.nextError = { status: 409, body: { error: { code: "task_in_progress", message: "This Session already has a Task in progress." } } };
  await assert.rejects(
    () => makeClient(busy).streamRun({ input: "hi" }).result(),
    (error: unknown) => {
      assert.ok(error instanceof SessionBusyError);
      assert.match(error.message, /Task in progress/);
      return true;
    },
  );

  // 服务器回的 Retry-After 被采纳
  const limited = new FakeAmspServer();
  limited.nextError = {
    status: 429,
    body: { error: { code: "too_many_runs", message: "too many" } },
    retryAfterSeconds: 3,
  };
  await assert.rejects(
    () => makeClient(limited).streamRun({ input: "hi" }).result(),
    (error: unknown) => {
      assert.ok(error instanceof TooManyRunsError);
      assert.equal(error.retryAfterMs, 3000);
      return true;
    },
  );

  // 没有（或非法的）Retry-After 时退回文档规定的 2s
  const noHeader = new FakeAmspServer();
  noHeader.nextError = { status: 429, body: { error: { code: "too_many_runs", message: "too many" } } };
  await assert.rejects(
    () => makeClient(noHeader).streamRun({ input: "hi" }).result(),
    (error: unknown) => {
      assert.ok(error instanceof TooManyRunsError);
      assert.equal(error.retryAfterMs, DEFAULT_RETRY_AFTER_MS);
      return true;
    },
  );
});

test("parseRetryAfter：秒转毫秒，非法值退回默认", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("1.5"), 1500);
  assert.equal(parseRetryAfter(null), DEFAULT_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter(""), DEFAULT_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter("soon"), DEFAULT_RETRY_AFTER_MS);
  assert.equal(parseRetryAfter("-5"), DEFAULT_RETRY_AFTER_MS);
});

test("AMSP 客户端：abort 后 Run 停止，事件流以中断态的 run.done 收尾", async () => {
  const server = new FakeAmspServer();
  const events: string[] = [];
  const run = makeClient(server).streamRun({ input: "长任务", onEvent: (e) => events.push(e.type) });
  const outcomePromise = run.result();
  await waitFor(() => server.runs.length > 0);

  await run.abort();
  const outcome = await outcomePromise;

  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.error?.code, "user_abort");
  assert.deepEqual(events, ["run.started", "run.done"]);
  assert.equal(server.requests.at(-1)?.path, `/sessions/${outcome.sessionId}/abort`);
});

test("AMSP 客户端：流断裂（无 run.done）映射为 RunStreamError", async () => {
  const server = new FakeAmspServer();
  const run = makeClient(server).streamRun({ input: "hi" });
  const outcomePromise = run.result();
  await waitFor(() => server.runs.length > 0);
  server.push(server.lastRun(), textDelta("半句话"));
  server.breakStream(server.lastRun());

  await assert.rejects(
    () => outcomePromise,
    (error: unknown) => {
      assert.ok(error instanceof RunStreamError, `unexpected ${String(error)}`);
      return true;
    },
  );
});

test("AMSP 客户端：session 查询与 abortSession", async () => {
  const server = new FakeAmspServer();
  const client = makeClient(server);
  const info = await client.session("session-x");
  assert.equal(info.id, "session-x");
  assert.equal(info.status, "idle");
  assert.equal(await client.abortSession("session-x"), true);
});

test("AMSP 客户端：approval.requested 走 onApproval 应答 allow", async () => {
  const server = new FakeAmspServer();
  const run = makeClient(server).streamRun({
    input: "hi",
    onApproval: () => "allow",
  });
  const outcomePromise = run.result();
  await waitFor(() => server.runs.length > 0);
  const fakeRun = server.lastRun();
  server.push(fakeRun, {
    type: "approval.requested",
    at: new Date().toISOString(),
    tool_call: { tool_call_id: "call_9", name: "exec_command", arguments: '{"command":"ls"}' },
  });
  server.push(fakeRun, runDone());
  server.close(fakeRun);
  const outcome = await outcomePromise;

  assert.equal(outcome.status, "completed");
  assert.deepEqual(server.approvalCalls, [
    { sessionId: fakeRun.sessionId, toolCallId: "call_9", decision: "allow" },
  ]);
});
