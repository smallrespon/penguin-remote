// AgentSupply 测试：专属 Agent 懒建、key 只驻内存、登记文件只记归属、重启后重铸。

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentSupply, dedicatedAgentId, isDedicatedAgent } from "../src/penguin/agents.js";
import type { AgentRef } from "../src/penguin/amsp.js";
import { createLogger } from "../src/logger.js";
import { FakeAmspServer, runDone, textDone } from "./helpers/fake-amsp.js";
import { FakeOwnerSession, OwnerError } from "./helpers/fake-owner.js";
import { waitFor } from "./helpers/wait.js";

const silent = createLogger("error", () => {});
const BASE_URL = "http://localhost/api/amsp/v1";
const DEFAULT_REF: AgentRef = { projectId: "default_project", agentId: "default_agent" };

async function makeSupply(
  options: {
    stateDir?: string;
    owner?: FakeOwnerSession;
    fetchImpl?: typeof fetch;
    /** 只对 staticAgent 生效的兜底 key（对应 env AMSP_API_KEY）。 */
    staticKey?: string;
    staticAgent?: AgentRef;
  } = {},
) {
  const dir = options.stateDir ?? (await mkdtemp(join(tmpdir(), "pr-agents-")));
  const owner = options.owner ?? new FakeOwnerSession();
  const supply = new AgentSupply({
    owner: owner.asOwnerSession,
    baseUrl: BASE_URL,
    stateDir: dir,
    logger: silent,
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
    ...(options.staticKey !== undefined ? { staticKey: options.staticKey } : {}),
    ...(options.staticAgent !== undefined ? { staticAgent: options.staticAgent } : {}),
  });
  return { supply, owner, dir };
}

/** 读登记文件。 */
async function readAgentsFile(dir: string): Promise<{
  agents: Record<string, { chatId?: string; keyId: string; createdAt: string }>;
}> {
  return JSON.parse(await readFile(join(dir, "agents.json"), "utf8"));
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
  const agentId = dedicatedAgentId("oc_chat_1");

  assert.deepEqual(ref, { projectId: "default_project", agentId });
  assert.deepEqual(owner.of("POST /agents"), [
    { method: "POST /agents", path: `default_project/${agentId}`, body: { name: "Feishu oc_chat_1" } },
  ]);
  assert.deepEqual(owner.of("PUT /api"), [
    {
      method: "PUT /api",
      path: `default_project/${agentId}`,
      body: { enabled: true, approvalMode: "allow-all" },
    },
  ]);
  assert.equal(owner.of("POST /keys").length, 1);

  // 落盘只记 keyId 与归属，绝不出现 secret
  const raw = await readFile(join(dir, "agents.json"), "utf8");
  const record = (await readAgentsFile(dir)).agents[`default_project/${agentId}`];
  assert.equal(record?.chatId, "oc_chat_1");
  assert.equal(record?.keyId, "key_1");
  assert.ok(typeof record?.createdAt === "string");
  assert.ok(!raw.includes("penguin_secret_1"), "secret 不应落盘");
});

test("ensureDedicatedAgent：已绑定专属 Agent 时直接沿用，不重复创建", async () => {
  const { supply, owner } = await makeSupply();
  const dedicated = dedicatedAgentId("oc_chat_1");
  const ref = await supply.ensureDedicatedAgent("default_project", dedicated, "oc_chat_1");
  assert.deepEqual(ref, { projectId: "default_project", agentId: dedicated });
  assert.deepEqual(owner.calls, [], "不该建 Agent 也不该铸 key");
});

test("ensureDedicatedAgent：重启后（登记已在）不重复建 Agent，但重新铸 key 并保留 createdAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-agents-"));
  const first = await makeSupply({ stateDir: dir });
  await first.supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");
  const agentId = dedicatedAgentId("oc_chat_1");
  const createdAt = (await readAgentsFile(dir)).agents[`default_project/${agentId}`]?.createdAt;

  // 新进程：登记文件里有该 Agent，因此跳过创建；key 不在内存，重铸一个
  const second = await makeSupply({ stateDir: dir });
  const ref = await second.supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");
  assert.equal(ref.agentId, agentId);
  assert.deepEqual(second.owner.of("POST /agents"), []);
  assert.equal(second.owner.of("POST /keys").length, 1);

  const record = (await readAgentsFile(dir)).agents[`default_project/${agentId}`];
  // 归属信息保留，keyId 更新为新的，创建时间不被重铸覆盖
  assert.equal(record?.chatId, "oc_chat_1");
  assert.equal(record?.keyId, "key_1");
  assert.equal(record?.createdAt, createdAt, "createdAt 应保留原始创建时间");
});

test("ensureDedicatedAgent：服务端已存在该 Agent（409）时直接沿用，不报错", async () => {
  const { supply, owner } = await makeSupply({
    owner: (() => {
      const owner = new FakeOwnerSession();
      // 登记文件丢了但服务端 Agent 还在
      owner.failCreateWith = new OwnerError("HTTP 409 agent_exists", 409);
      return owner;
    })(),
  });

  const ref = await supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1");
  assert.equal(ref.agentId, dedicatedAgentId("oc_chat_1"));
  assert.equal(owner.of("POST /keys").length, 1, "仍要继续铸 key");
  assert.equal(owner.of("PUT /api").length, 1, "仍要开 API");
});

test("ensureDedicatedAgent：createAgent 其他错误照旧抛出", async () => {
  const owner = new FakeOwnerSession();
  owner.failCreateWith = new OwnerError("HTTP 500 boom", 500);
  const { supply } = await makeSupply({ owner });
  await assert.rejects(
    () => supply.ensureDedicatedAgent("default_project", "default_agent", "oc_chat_1"),
    /HTTP 500/,
  );
});

test("keyFor：key 只铸一次并只驻内存；并发调用只铸一把", async () => {
  const { supply, owner } = await makeSupply();

  const first = await supply.keyFor(DEFAULT_REF);
  const second = await supply.keyFor(DEFAULT_REF);
  assert.equal(first, second);
  assert.equal(owner.of("POST /keys").length, 1, "同 Agent 的 key 只铸一次");

  // 并发（两个档位命令同时打到同一个 Agent）也只铸一把
  const [a, b] = await Promise.all([
    supply.keyFor({ projectId: "default_project", agentId: "coder" }),
    supply.keyFor({ projectId: "default_project", agentId: "coder" }),
  ]);
  assert.equal(a, b);
  assert.equal(owner.of("POST /keys").filter((c) => c.path.endsWith("/coder")).length, 1);
});

test("静态 key（env AMSP_API_KEY）只对默认 Agent 生效，其他 Agent 仍自铸", async () => {
  const { supply, owner } = await makeSupply({
    staticKey: "penguin_env_key",
    staticAgent: DEFAULT_REF,
  });

  // 默认 Agent：直接用静态 key，不铸 key
  assert.equal(await supply.keyFor(DEFAULT_REF), "penguin_env_key");
  assert.deepEqual(owner.calls, []);

  // 专属 Agent：静态 key 不属于它，必须自铸，否则 runs 路由会 401
  const coder: AgentRef = { projectId: "default_project", agentId: "coder" };
  assert.equal(await supply.keyFor(coder), "penguin_secret_1");
  assert.equal(owner.of("POST /keys").length, 1);
});

test("clientFor：用各自 Agent 的 key 建客户端，请求打到对应 Agent 的 runs 路由", async () => {
  const server = new FakeAmspServer();
  const { supply, owner } = await makeSupply({ fetchImpl: server.fetch });
  const client = await supply.clientFor({ projectId: "default_project", agentId: "coder" });
  assert.equal(owner.of("POST /keys").length, 1);

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
