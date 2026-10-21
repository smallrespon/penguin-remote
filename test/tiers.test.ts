// TierCommands 测试：/project /agent /model /thinking /workspace 的列出与切换，
// 以及首次改档位时懒建专属 Agent、把绑定切过去并重置会话。

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TierCommands, matchModels } from "../src/tiers.js";
import { Registry } from "../src/registry.js";
import { AgentSupply } from "../src/penguin/agents.js";
import type { OwnerSession } from "../src/penguin/owner.js";
import { createLogger } from "../src/logger.js";

const silent = createLogger("error", () => {});

const PROJECTS = [
  { projectId: "default_project", name: "默认项目" },
  { projectId: "demo", name: "演示" },
];

const AGENTS: Record<string, Array<{ agentId: string; name?: string; apiEnabled?: boolean }>> = {
  default_project: [
    { agentId: "default_agent", name: "默认 Agent", apiEnabled: true },
    { agentId: "coder", name: "写代码的" },
  ],
  demo: [{ agentId: "demo_agent", apiEnabled: false }],
};

const MODELS = [
  { provider: "stepfun", modelId: "step-3", displayName: "Step 3", isDefault: true },
  { provider: "stepfun", modelId: "step-3-mini", displayName: "Step 3 mini" },
  { provider: "openai", modelId: "gpt-5", displayName: "GPT-5" },
  { provider: "other", modelId: "step-3", displayName: "Step 3 (other)" },
];

/** 假 owner：脚本化的项目/Agent/模型清单与 API 设置。 */
class FakeOwner {
  api: Record<string, unknown> = {
    model: null,
    thinkingLevel: null,
    workspace: null,
  };
  readonly puts: Array<{ path: string; patch: Record<string, unknown> }> = [];
  readonly created: Array<{ projectId: string; agentId: string; name: string }> = [];
  /** 让 getAgentApi 失败（模拟 server 侧读取失败）。 */
  failGet = false;
  /** 覆盖模型清单（测试列表截断用）。 */
  models: typeof MODELS | null = null;
  /** 覆盖 Project 默认模型。 */
  defaultModel: { provider: string; modelId: string } | null = null;

  async listProjects(): Promise<typeof PROJECTS> {
    return PROJECTS;
  }

  async listAgents(projectId: string): Promise<(typeof AGENTS)["default_project"]> {
    return AGENTS[projectId] ?? [];
  }

  async listModels(): Promise<{ models: typeof MODELS; defaultModel: { provider: string; modelId: string } | null }> {
    return { models: this.models ?? MODELS, defaultModel: this.defaultModel };
  }

  async getAgentApi(projectId: string, agentId: string) {
    if (this.failGet) throw new Error("boom");
    return { api: this.api, serverEnabled: true };
  }

  async putAgentApi(projectId: string, agentId: string, patch: Record<string, unknown>) {
    this.puts.push({ path: `${projectId}/${agentId}`, patch });
    Object.assign(this.api, patch);
    return { api: this.api, serverEnabled: true };
  }

  async createAgent(projectId: string, agentId: string, name: string): Promise<void> {
    this.created.push({ projectId, agentId, name });
  }

  async createKey(projectId: string, agentId: string) {
    return { keyId: "key_1", secret: "penguin_fake_secret" };
  }
}

async function makeTiers() {
  const dir = await mkdtemp(join(tmpdir(), "pr-tiers-"));
  const registry = await Registry.load(dir, {
    projectId: "default_project",
    agentId: "default_agent",
  });
  const owner = new FakeOwner();
  const supply = new AgentSupply({
    owner: owner as unknown as OwnerSession,
    baseUrl: "http://localhost/api/amsp/v1",
    stateDir: dir,
    logger: silent,
  });
  const tiers = new TierCommands({
    owner: owner as unknown as OwnerSession,
    supply,
    registry,
    logger: silent,
  });
  return { tiers, registry, owner };
}

// ---- 列出 ----

test("/project 列出项目并标注当前；/agent 列出 Agent 并标注 API 未开启", async () => {
  const { tiers } = await makeTiers();
  const projects = await tiers.listProjects("oc_1");
  assert.match(projects, /→ `default_project`/);
  assert.match(projects, /`demo` — 演示/);

  const agents = await tiers.listAgents("oc_1");
  assert.match(agents, /→ `default_agent`/);
  assert.match(agents, /`coder` — 写代码的/);
  assert.doesNotMatch(agents, /API 未开启.*coder/);

  await tiers.selectProject("oc_1", "demo");
  const demoAgents = await tiers.listAgents("oc_1");
  assert.match(demoAgents, /`demo_agent`（API 未开启）/);
});

test("/model 列表：isDefault 或 Project 默认模型标 →；超过 30 个只展示前 30 个", async () => {
  const { tiers, registry } = await makeTiers();
  // MODELS[0] 带 isDefault
  let text = await tiers.listModels("oc_1");
  assert.match(text, /→ `stepfun\/step-3`/);
  assert.doesNotMatch(text, /→ `openai\/gpt-5`/);

  // isDefault 全 false 时，defaultModel 顶上
  const { tiers: t2, owner: o2 } = await makeTiers();
  o2.models = MODELS.map((m) => ({ ...m, isDefault: false }));
  o2.defaultModel = { provider: "openai", modelId: "gpt-5" };
  text = await t2.listModels("oc_1");
  assert.match(text, /→ `openai\/gpt-5`/);
  assert.doesNotMatch(text, /→ `stepfun\/step-3`/);

  const { tiers: t3, owner: o3 } = await makeTiers();
  o3.models = Array.from({ length: 45 }, (_, i) => ({
    provider: "p",
    modelId: `m${i}`,
    displayName: `模型 ${i}`,
    isDefault: false,
  }));
  text = await t3.listModels("oc_1");
  assert.match(text, /共 45 个，前 30 个/);
  assert.ok(text.includes("`p/m0`"));
  assert.ok(text.includes("`p/m29`"));
  assert.ok(!text.includes("`p/m30`"), "第 31 个不应出现");

  const bad = await tiers.selectProject("oc_1", "nope");
  assert.match(bad, /没有 Project/);
  assert.equal(registry.bindingFor("oc_1").projectId, "default_project");
});

// ---- 切换 ----

test("/project 与 /agent 切换后重置会话（换对话）", async () => {
  const { tiers, registry } = await makeTiers();
  await registry.noteSession("oc_1", { sessionId: "s1", title: "旧对话" });

  const reply = await tiers.selectProject("oc_1", "demo");
  assert.match(reply, /已切换 Project/);
  let binding = registry.bindingFor("oc_1");
  assert.equal(binding.projectId, "demo");
  assert.equal(binding.sessionId, null);

  await tiers.selectAgent("oc_1", "demo_agent");
  binding = registry.bindingFor("oc_1");
  assert.equal(binding.agentId, "demo_agent");
  assert.equal(binding.sessionId, null);
});

test("/model 唯一匹配：改 API 设置并把绑定切到懒建的专属 Agent", async () => {
  const { tiers, registry, owner } = await makeTiers();
  await registry.noteSession("oc_1", { sessionId: "s1", title: "旧对话" });

  const reply = await tiers.selectModel("oc_1", "gpt-5");
  assert.match(reply, /已切换模型 `openai\/gpt-5`/);

  assert.equal(owner.created.length, 1, "首次改档位应懒建一个专属 Agent");
  assert.match(owner.created[0]?.agentId ?? "", /^feishu_[0-9a-f]{12}$/);

  const put = owner.puts.at(-1);
  assert.equal(put?.path, `default_project/${owner.created[0]?.agentId}`, "档位改在专属 Agent 上");
  assert.deepEqual(put?.patch, { model: { provider: "openai", modelId: "gpt-5" } });

  const binding = registry.bindingFor("oc_1");
  assert.equal(binding.agentId, owner.created[0]?.agentId);
  assert.equal(binding.sessionId, null, "换 Agent = 换对话");
  assert.equal(binding.projectId, "default_project");
});

test("/model 多个匹配或没有匹配：不改任何设置", async () => {
  const { tiers, registry, owner } = await makeTiers();

  const ambiguous = await tiers.selectModel("oc_1", "step-3");
  assert.match(ambiguous, /匹配到多个模型/);
  assert.match(ambiguous, /`stepfun\/step-3`/);
  assert.match(ambiguous, /`other\/step-3`/);
  assert.deepEqual(owner.puts, []);
  assert.deepEqual(owner.created, []);
  assert.equal(registry.bindingFor("oc_1").agentId, "default_agent");

  const missing = await tiers.selectModel("oc_1", "llama-9");
  assert.match(missing, /没有匹配/);
  assert.deepEqual(owner.puts, []);
});

test("/thinking 与 /workspace：改专属 Agent 的 API 设置", async () => {
  const { tiers, registry, owner } = await makeTiers();

  assert.match(await tiers.selectThinking("oc_1", "high"), /思考档位已设为 `high`/);
  assert.deepEqual(owner.puts.at(-1)?.patch, { thinkingLevel: "high" });

  assert.match(await tiers.selectWorkspace("oc_1", "/tmp/demo"), /工作区已设为/);
  assert.deepEqual(owner.puts.at(-1)?.patch, { workspace: "/tmp/demo" });

  const binding = registry.bindingFor("oc_1");
  assert.match(binding.agentId, /^feishu_/);
  // 只懒建一次：开 API + 两次档位切换，共三次 PUT，都落在同一个专属 Agent 上
  assert.equal(owner.created.length, 1);
  assert.equal(owner.puts.length, 3);
  assert.deepEqual(owner.puts[0]?.patch, { enabled: true, approvalMode: "allow-all" });
  assert.deepEqual(owner.puts[1]?.patch, { thinkingLevel: "high" });
  assert.deepEqual(owner.puts[2]?.patch, { workspace: "/tmp/demo" });
  assert.equal(owner.puts[0]?.path, owner.puts[2]?.path);
});

test("/status 档位回显：读得到时列模型/思考/工作区，读不到时明确说失败", async () => {
  const { tiers, owner } = await makeTiers();
  owner.api = {
    model: { provider: "stepfun", modelId: "step-3" },
    thinkingLevel: "medium",
    workspace: "/tmp/x",
  };
  const text = await tiers.describeTiers("oc_1");
  assert.match(text, /`stepfun\/step-3`/);
  assert.match(text, /medium/);
  assert.match(text, /`\/tmp\/x`/);

  owner.failGet = true;
  assert.match(await tiers.describeTiers("oc_1"), /读取失败/);
});

// ---- 纯函数 ----

test("matchModels：全名 / 裸 modelId / displayName，大小写不敏感", () => {
  assert.deepEqual(matchModels(MODELS, "stepfun/step-3"), [MODELS[0]]);
  assert.deepEqual(matchModels(MODELS, "STEP-3"), [MODELS[0], MODELS[3]], "裸 modelId 可撞多个 provider");
  assert.deepEqual(matchModels(MODELS, "step-3-mini"), [MODELS[1]]);
  assert.deepEqual(matchModels(MODELS, "GPT-5"), [MODELS[2]]);
  assert.deepEqual(matchModels(MODELS, "step 3 mini"), [MODELS[1]]);
  assert.deepEqual(matchModels(MODELS, "claude"), []);
  assert.deepEqual(matchModels(MODELS, "   "), []);
});
