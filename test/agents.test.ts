// AgentSupply 测试：专属 Agent 懒建、key 只驻内存、登记文件只记归属、重启后重铸。

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentSupply, dedicatedAgentId, isDedicatedAgent } from "../src/penguin/agents.js";
import { OwnerError, type OwnerSession } from "../src/penguin/owner.js";
import { createLogger } from "../src/logger.js";
import { FakeAmspServer, runDone, textDone } from "./helpers/fake-amsp.js";

const silent = createLogger("error", () => {});

interface OwnerCall {
  method: string;
  path: string;
  body: unknown;
}

/** 假 owner：只实现 AgentSupply 用到的那几个方法。 */
class FakeOwnerSession {
  readonly calls: OwnerCall[] = [];
  /** 让 createAgent 抛出（模拟 409 已存在 / 其他错误）。 */
  failCreateWith: Error | null = null;
  private keySeq = 0;

  async createAgent(projectId: string, agentId: string, name: string): Promise<void> {
    if (this.failCreateWith !== null) throw this.failCreateWith;
    this.calls.push({ method: "POST /agents", path: `${projectId}/${agentId}`, body: { name } });
  }

  async putAgentApi(projectId: string, agentId: string, patch: unknown): Promise<unknown> {
    this.calls.push({ method: "PUT /api", path: `${projectId}/${agentId}`, body: patch });
    return { api: patch, serverEnabled: true };
  }

  async createKey(projectId: string, agentId: string, name: string) {
    this.keySeq += 1;
    this.calls.push({ method: "POST /keys", path: `${projectId}/${agentId}`, body: { name } });
    return { keyId: `key_${this.keySeq}`, secret: `penguin_secret_${this.keySeq}` };
  }

  /** 只取某类调用。 */
  of(method: string): OwnerCall[] {
    return this.calls.filter((c) => c.method === method);
  }
}

async function makeSupply(stateDir?: string, fetchImpl?: typeof fetch) {
  const dir = stateDir ?? (await mkdtemp(join(tmpdir(), "pr-agents-")));
  const owner = new FakeOwnerSession();
  const supply = new AgentSupply({
    owner: owner as unknown as OwnerSession,
    baseUrl: "http://localhost/api/amsp/v1",
    stateDir: dir,
    logger: silent,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return { supply, owner, dir };
}

test("dedicatedAgentId：同一聊天恒定、按 chatId 派生、带 feishu_ 前缀", () => {
  const a = dedicatedAgentId("oc_chat_1");
  assert.equal(a, dedicatedAgentId("oc_chat_1"));
  assert.match(a, /^feishu_[0-9a-f]{12}$/);
  assert.notEqual(a, dedicatedAgentId("oc_chat_2"));
  assert.equal(isDedicatedAgent(a), true);
  assert.equal(isDedicatedAgent("default_agent"), false);
});

test("ensureDedicatedAgent：懒建专属 Agent、开 API（allow-all）、铸 key 并登记归属", async () => {
  const { supply, owner, dir } = await makeSupply();
  const ref = await supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");

  assert.equal(ref.projectId, "default_project");
  assert.equal(ref.agentId, dedicatedAgentId("oc_chat_1"));

  assert.deepEqual(owner.of("POST /agents"), [
    {
      method: "POST /agents",
      path: `default_project/${dedicatedAgentId("oc_chat_1")}`,
      body: { name: "Feishu oc_chat_1" },
    },
  ]);
  assert.deepEqual(owner.of("PUT /api"), [
    {
      method: "PUT /api",
      path: `default_project/${dedicatedAgentId("oc_chat_1")}`,
      body: { enabled: true, approvalMode: "allow-all" },
    },
  ]);
  assert.equal(owner.of("POST /keys").length, 1);

  // 落盘只记 keyId 与归属，绝不出现 secret
  const raw = JSON.parse(await readFile(join(dir, "agents.json"), "utf8")) as {
    agents: Record<string, { chatId: string; keyId: string; createdAt: string }>;
  };
  const record = raw.agents[`default_project/${dedicatedAgentId("oc_chat_1")}`];
  assert.equal(record?.chatId, "oc_chat_1");
  assert.equal(record?.keyId, "key_1");
  assert.ok(typeof record?.createdAt === "string");
  assert.ok(!(await readFile(join(dir, "agents.json"), "utf8")).includes("penguin_secret_1"));
});

test("ensureDedicatedAgent：已绑定专属 Agent 时直接沿用，不重复创建", async () => {
  const { supply, owner } = await makeSupply();
  const dedicated = dedicatedAgentId("oc_chat_1");
  const ref = await supply.ensureDedicatedAgent("default_project", dedicated, "oc_chat_1");
  assert.deepEqual(ref, { projectId: "default_project", agentId: dedicated });
  assert.deepEqual(owner.calls, [], "不该建 Agent 也不该铸 key");
});

test("ensureDedicatedAgent：重启后（登记已在）不重复建 Agent，但重新铸 key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-agents-"));
  const first = await makeSupply(dir);
  await first.supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");
  const agentId = dedicatedAgentId("oc_chat_1");

  // 新进程：登记文件里有该 Agent，因此跳过创建；key 不在内存，重铸一个
  const second = await makeSupply(dir);
  const ref = await second.supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");
  assert.equal(ref.agentId, agentId);
  assert.deepEqual(second.owner.of("POST /agents"), []);
  assert.equal(second.owner.of("POST /keys").length, 1);

  const raw = JSON.parse(await readFile(join(dir, "agents.json"), "utf8")) as {
    agents: Record<string, { chatId: string; keyId: string }>;
  };
  // 归属信息保留，keyId 更新为新的
  assert.equal(raw.agents[`default_project/${agentId}`]?.chatId, "oc_chat_1");
  assert.equal(raw.agents[`default_project/${agentId}`]?.keyId, "key_1");
});

test("ensureDedicatedAgent：服务端已存在该 Agent（409）时直接沿用，不报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-agents-"));
  const owner = new FakeOwnerSession();
  // 登记文件丢了但服务端 Agent 还在：createAgent 回 409 agent_exists
  owner.failCreateWith = new OwnerError("HTTP 409 agent_exists", 409);
  const supply = new AgentSupply({
    owner: owner as unknown as OwnerSession,
    baseUrl: "http://localhost/api/amsp/v1",
    stateDir: dir,
    logger: silent,
  });

  const ref = await supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");
  assert.equal(ref.agentId, dedicatedAgentId("oc_chat_1"));
  assert.equal(owner.calls.filter((c) => c.method === "POST /keys").length, 1, "仍要继续铸 key");
  assert.equal(owner.calls.filter((c) => c.method === "PUT /api").length, 1, "仍要开 API");
});

test("ensureDedicatedAgent：createAgent 其他错误照旧抛出", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-agents-"));
  const owner = new FakeOwnerSession();
  owner.failCreateWith = new OwnerError("HTTP 500 boom", 500);
  const supply = new AgentSupply({
    owner: owner as unknown as OwnerSession,
    baseUrl: "http://localhost/api/amsp/v1",
    stateDir: dir,
    logger: silent,
  });
  await assert.rejects(
    () => supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1"),
    /HTTP 500/,
  );
});

test("keyFor / clientFor：key 只铸一次并只驻内存；clientFor 产出可用客户端", async () => {
  const server = new FakeAmspServer();
  const { supply, owner } = await makeSupply(undefined, server.fetch);
  const ref = { projectId: "default_project", agentId: "default_agent" };

  const first = await supply.keyFor(ref);
  const second = await supply.keyFor(ref);
  assert.equal(first, second);
  assert.equal(owner.of("POST /keys").length, 1, "同 Agent 的 key 只铸一次");

  // clientFor 用刚铸的 key 建客户端，请求打到对应 Agent 的 runs 路由
  const client = await supply.clientFor({ projectId: "default_project", agentId: "coder" });
  assert.equal(owner.of("POST /keys").length, 2, "coder 是另一个 Agent，另铸一把 key");
  const run = client.streamRun({ input: "hi" });
  const outcome = run.result();
  await waitFor(() => server.runs.length > 0);
  const fakeRun = server.lastRun();
  server.push(fakeRun, textDone("好"));
  server.push(fakeRun, runDone());
  server.close(fakeRun);
  assert.equal((await outcome).status, "completed");
  assert.match(server.requests[0]?.path ?? "", /\/agents\/default_project\/coder\/runs$/);
});

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
