// TierCommands 测试（ADR-0005）：/project /agent /model /thinking /workspace 的列出与切换。
// 档位只写各聊天自己的 binding，不建 Agent、不发任何 owner 写请求。

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TierCommands, matchModels } from "../src/tiers.js";
import { Registry } from "../src/registry.js";
import { createLogger } from "../src/logger.js";
import { FakeOwnerSession } from "./helpers/fake-owner.js";

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

/** 假 owner：在共用假 owner 之上脚本化项目/Agent/模型清单。 */
class FakeOwner extends FakeOwnerSession {
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
}

async function makeTiers() {
  const dir = await mkdtemp(join(tmpdir(), "pr-tiers-"));
  const registry = await Registry.load(dir, {
    projectId: "default_project",
    agentId: "default_agent",
  });
  const owner = new FakeOwner();
  const tiers = new TierCommands({
    owner: owner.asOwnerSession,
    registry,
    logger: silent,
    defaultAgentId: "default_agent",
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

test("/model 列表：isDefault 或 Project 默认模型标 →；超过 30 个只展示前 30 个；带上当前档位", async () => {
  const { tiers, registry } = await makeTiers();
  // MODELS[0] 带 isDefault
  let text = await tiers.listModels("oc_1");
  assert.match(text, /→ `stepfun\/step-3`/);
  assert.doesNotMatch(text, /→ `openai\/gpt-5`/);
  assert.doesNotMatch(text, /当前：/, "没设过模型时不显示当前档位");

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

  // 设过模型后，列表带上当前档位
  await tiers.selectModel("oc_1", "gpt-5");
  text = await tiers.listModels("oc_1");
  assert.match(text, /当前：`openai\/gpt-5`/);
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
  // 换 Project 时 Agent 归位到默认：否则旧 agentId 在新项目里不存在
  assert.equal(binding.agentId, "default_agent");

  await tiers.selectAgent("oc_1", "demo_agent");
  binding = registry.bindingFor("oc_1");
  assert.equal(binding.agentId, "demo_agent");
  assert.equal(binding.sessionId, null);

  // 再换回默认项目：Agent 再次归位，不会带着 demo_agent 过去
  await tiers.selectProject("oc_1", "default_project");
  binding = registry.bindingFor("oc_1");
  assert.equal(binding.agentId, "default_agent");
  assert.equal(binding.sessionId, null);
});

test("/project 切换重置 model/thinking、保留 workspace", async () => {
  const { tiers, registry } = await makeTiers();
  await tiers.selectModel("oc_1", "gpt-5");
  await tiers.selectThinking("oc_1", "high");
  await tiers.selectWorkspace("oc_1", "/tmp/demo");

  await tiers.selectProject("oc_1", "demo");
  const binding = registry.bindingFor("oc_1");
  assert.equal(binding.model, undefined, "模型目录是项目级的，切项目要重置");
  assert.equal(binding.thinkingLevel, undefined);
  assert.equal(binding.workspace, "/tmp/demo", "workspace 与项目无关，保留");
});

test("/model 唯一匹配：只写本聊天 binding，不建 Agent、不发 owner 写请求", async () => {
  const { tiers, registry, owner } = await makeTiers();
  await registry.noteSession("oc_1", { sessionId: "s1", title: "旧对话" });

  const reply = await tiers.selectModel("oc_1", "gpt-5");
  assert.match(reply, /已切换模型 `openai\/gpt-5`/);
  assert.match(reply, /下一新会话生效/);

  assert.deepEqual(owner.of("POST /agents"), [], "不建任何 Agent");
  assert.deepEqual(owner.of("PUT /api"), [], "不动任何 Agent 的设置");
  assert.deepEqual(owner.of("POST /keys"), [], "不铸 key");

  const binding = registry.bindingFor("oc_1");
  assert.deepEqual(binding.model, { provider: "openai", modelId: "gpt-5" });
  // 「下一新会话生效」是字面语义：当前会话原样续着
  assert.equal(binding.sessionId, "s1");
  assert.equal(binding.agentId, "default_agent");
  assert.equal(binding.projectId, "default_project");
});

test("/model 多个匹配或没有匹配：不改任何档位", async () => {
  const { tiers, registry, owner } = await makeTiers();

  const ambiguous = await tiers.selectModel("oc_1", "step-3");
  assert.match(ambiguous, /匹配到多个模型/);
  assert.match(ambiguous, /`stepfun\/step-3`/);
  assert.match(ambiguous, /`other\/step-3`/);
  assert.equal(registry.bindingFor("oc_1").model, undefined);

  const missing = await tiers.selectModel("oc_1", "llama-9");
  assert.match(missing, /没有匹配/);
  assert.equal(registry.bindingFor("oc_1").model, undefined);
  assert.deepEqual(owner.of("PUT /api"), []);
});

test("/thinking 与 /workspace：写本聊天 binding，重启后仍在", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-tiers-"));
  const registry = await Registry.load(dir, {
    projectId: "default_project",
    agentId: "default_agent",
  });
  const owner = new FakeOwner();
  const tiers = new TierCommands({
    owner: owner.asOwnerSession,
    registry,
    logger: silent,
    defaultAgentId: "default_agent",
  });

  assert.match(await tiers.selectThinking("oc_1", "high"), /思考档位已设为 `high`/);
  assert.match(await tiers.selectWorkspace("oc_1", "/tmp/demo"), /工作区已设为/);

  assert.deepEqual(owner.of("PUT /api"), [], "档位不进 Agent 设置");
  const reloaded = await Registry.load(dir, {
    projectId: "default_project",
    agentId: "default_agent",
  });
  const binding = reloaded.bindingFor("oc_1");
  assert.equal(binding.thinkingLevel, "high");
  assert.equal(binding.workspace, "/tmp/demo");
});

test("/status 档位回显：来自本聊天 binding，缺省时显示「跟随默认」", async () => {
  const { tiers } = await makeTiers();
  let text = await tiers.describeTiers("oc_1");
  assert.match(text, /模型：跟随默认/);
  assert.match(text, /思考：跟随默认/);
  assert.match(text, /工作区：`临时工作区`/);

  await tiers.selectModel("oc_1", "stepfun/step-3-mini");
  await tiers.selectThinking("oc_1", "medium");
  await tiers.selectWorkspace("oc_1", "/tmp/x");
  text = await tiers.describeTiers("oc_1");
  assert.match(text, /`stepfun\/step-3-mini`/);
  assert.match(text, /medium/);
  assert.match(text, /`\/tmp\/x`/);
  // 另一个聊天不受影响
  assert.match(await tiers.describeTiers("oc_2"), /模型：跟随默认/);
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
