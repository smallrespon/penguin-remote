// OwnerSession 测试：令牌铸造/缓存/重铸、cookie 请求形状、owner 路由封装。

import assert from "node:assert/strict";
import { test } from "node:test";

import { OwnerError, OwnerSession, parseToken } from "../src/penguin/owner.js";
import { createLogger } from "../src/logger.js";
import type { RunResult } from "../src/proc.js";
import { FakeOwnerServer } from "./helpers/fake-owner-server.js";

const silent = createLogger("error", () => {});

/** 记录 `penguin auth token` 调用的假 shell。 */
function fakeRun(stdout: string, status = 0, stderr = "") {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[]): Promise<RunResult> => {
    calls.push(args);
    return { status, stdout, stderr };
  };
  return { run, calls };
}

function makeSession(
  fake: { run: typeof import("../src/proc.js").runCommand },
  owner: FakeOwnerServer,
  now: () => number = () => 0,
): OwnerSession {
  return new OwnerSession({
    bin: "penguin",
    baseUrl: "http://localhost/api",
    ttlSeconds: 3600,
    refreshMarginSeconds: 300,
    logger: silent,
    run: fake.run,
    fetch: owner.fetch,
    now,
  });
}

test("parseToken：取标记行下一行；无标记时退回最后一行非空输出", () => {
  assert.equal(parseToken("一些说明\n\n---penguin-auth-token---\nabc123\n"), "abc123");
  assert.equal(parseToken("  raw-token  \n"), "raw-token");
  assert.equal(parseToken("\n\n"), null);
});

test("owner 令牌：按 TTL 铸造一次，过期前重铸，全程只走 cookie", async () => {
  const fake = fakeRun("---penguin-auth-token---\ntok_1");
  const owner = new FakeOwnerServer({ "GET /api/projects": { projects: [{ projectId: "p1" }] } });
  let clock = 1_000_000;
  const session = makeSession(fake, owner, () => clock);

  assert.deepEqual(await session.listProjects(), [{ projectId: "p1" }]);
  assert.deepEqual(fake.calls[0], ["auth", "token", "--mark", "--ttl-seconds", "3600"]);
  assert.equal(owner.requests[0]?.cookie, "penguin_session=tok_1");

  // 未过期：复用同一令牌，不重复铸造
  clock += 1000;
  await session.listProjects();
  assert.equal(fake.calls.length, 1);

  // 越过 ttl - margin（3300s）后重铸
  clock += 3301 * 1000;
  await session.listProjects();
  assert.equal(fake.calls.length, 2);
  assert.equal(owner.requests.at(-1)?.cookie, "penguin_session=tok_1");
});

test("owner 令牌：铸造失败抛 OwnerError", async () => {
  const fake = fakeRun("", 1, "not logged in");
  const owner = new FakeOwnerServer();
  await assert.rejects(
    () => makeSession(fake, owner).listProjects(),
    (error: unknown) => {
      assert.ok(error instanceof OwnerError);
      assert.match(error.message, /not logged in/);
      return true;
    },
  );
});

test("owner 令牌：401 时重铸一次再试，仍失败则抛错", async () => {
  const fake = fakeRun("---penguin-auth-token---\ntok_1");
  const owner = new FakeOwnerServer({ "GET /api/projects": { projects: [] } });

  // 第一次 401，第二次成功
  owner.failNextWith(401);
  const session = makeSession(fake, owner);
  assert.deepEqual(await session.listProjects(), []);
  assert.equal(fake.calls.length, 2, "401 后应重铸");
  assert.equal(owner.requests.length, 2);

  // 一直 401：两次请求后抛出（不无限重试）
  const failing = new FakeOwnerServer({ "GET /api/projects": { projects: [] } });
  failing.failAllWith(401);
  const second = makeSession(fakeRun("---penguin-auth-token---\ntok_2"), failing);
  await assert.rejects(() => second.listProjects(), (error: unknown) => error instanceof OwnerError);
  assert.equal(failing.requests.length, 2);
});

test("owner 路由：projects / agents / models / api 读写 / 建 Agent / 铸 key", async () => {
  const fake = fakeRun("---penguin-auth-token---\ntok");
  const owner = new FakeOwnerServer({
    "GET /api/projects": { projects: [{ projectId: "p1", name: "默认" }] },
    "GET /api/projects/p1/agents": { agents: [{ agentId: "a1", apiEnabled: true }] },
    "GET /api/projects/p1/models": {
      models: [{ provider: "stepfun", modelId: "step-3" }],
      defaultModel: { provider: "stepfun", modelId: "step-3" },
    },
    "GET /api/projects/p1/agents/a1/api": { api: { enabled: true }, serverEnabled: true },
    "PUT /api/projects/p1/agents/a1/api": { api: { enabled: true }, serverEnabled: true },
    "POST /api/projects/p1/agents": {},
    "POST /api/projects/p1/agents/a1/api/keys": { key: { keyId: "k1" }, secret: "penguin_secret" },
  });
  const session = makeSession(fake, owner);

  assert.deepEqual(await session.listProjects(), [{ projectId: "p1", name: "默认" }]);
  assert.deepEqual(await session.listAgents("p1"), [{ agentId: "a1", apiEnabled: true }]);
  assert.deepEqual(await session.listModels("p1"), {
    models: [{ provider: "stepfun", modelId: "step-3" }],
    defaultModel: { provider: "stepfun", modelId: "step-3" },
  });
  assert.equal((await session.getAgentApi("p1", "a1")).api.enabled, true);

  await session.putAgentApi("p1", "a1", { model: { provider: "stepfun", modelId: "step-3" } });
  const put = owner.requests.find((r) => r.method === "PUT");
  assert.deepEqual(put?.path, "/api/projects/p1/agents/a1/api");
  assert.deepEqual(put?.body, { model: { provider: "stepfun", modelId: "step-3" } });

  await session.createAgent("p1", "feishu_abc", "Feishu oc_x");
  const created = owner.requests.find((r) => r.method === "POST" && r.path === "/api/projects/p1/agents");
  assert.deepEqual(created?.body, { agentId: "feishu_abc", name: "Feishu oc_x" });

  const key = await session.createKey("p1", "a1", "penguin-remote-bridge");
  assert.deepEqual(key, { keyId: "k1", secret: "penguin_secret" });

  // 路径片段被转义：不会被注入
  await session.listAgents("p 1/x");
  assert.equal(
    owner.requests.at(-1)?.path,
    "/api/projects/p%201%2Fx/agents",
    "projectId 应被 encodeURIComponent",
  );
});

test("owner 路由：非 2xx 抛出 OwnerError 且带状态码", async () => {
  const owner = new FakeOwnerServer();
  owner.failNextWith(500);
  await assert.rejects(
    () => makeSession(fakeRun("---penguin-auth-token---\ntok"), owner).listProjects(),
    (error: unknown) => {
      assert.ok(error instanceof OwnerError);
      assert.match(error.message, /HTTP 500/);
      return true;
    },
  );
});

test("fetchAuthed：供会话 API 复用——带 cookie 与 JSON 头，透传 method/body", async () => {
  const fake = fakeRun("---penguin-auth-token---\ntok_1");
  const owner = new FakeOwnerServer({
    "POST /api/sessions/s1/tasks": { sessionId: "s1", queued: true },
  });
  const session = makeSession(fake, owner);

  const response = await session.fetchAuthed("/sessions/s1/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: [{ type: "text", text: "在吗" }] }),
  });
  assert.equal(response.status, 200);
  const request = owner.requests.at(-1);
  assert.equal(request?.path, "/api/sessions/s1/tasks");
  assert.equal(request?.cookie, "penguin_session=tok_1");
  assert.deepEqual(request?.body, { input: [{ type: "text", text: "在吗" }] });
  // 调用方自带的 Content-Type 不被覆盖
  assert.equal(fake.calls.length, 1, "令牌复用，不重复铸造");
});

test("fetchAuthed：401 时重铸一次再试（会话 API 的令牌过期自愈）", async () => {
  const fake = fakeRun("---penguin-auth-token---\ntok_1");
  const owner = new FakeOwnerServer({ "GET /api/sessions/s1": { session: { sessionId: "s1" } } });
  owner.failNextWith(401);
  const session = makeSession(fake, owner);

  const response = await session.fetchAuthed("/sessions/s1");
  assert.equal(response.status, 200);
  assert.equal(fake.calls.length, 2, "401 后应重铸");
  assert.equal(owner.requests.length, 2);
  assert.equal(owner.requests.at(-1)?.cookie, "penguin_session=tok_1");
});
