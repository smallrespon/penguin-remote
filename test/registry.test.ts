// Registry 测试：绑定存取、落盘 roundtrip、会话历史（置顶/去重/限量/归属过滤）、
// v1.0 → v1.1 迁移（feishu_* 专属 Agent 绑定迁回默认 Agent，ADR-0005）。

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HISTORY_LIMIT, Registry } from "../src/registry.js";

const DEFAULTS = { projectId: "default_project", agentId: "default_agent" };

async function loadIn(dir: string): Promise<Registry> {
  return Registry.load(dir, DEFAULTS);
}

function readBindings(dir: string): Promise<Record<string, unknown>> {
  return readFile(join(dir, "bindings.json"), "utf8").then((text) => JSON.parse(text).bindings);
}

test("load：缺文件时从全新开始，bindingFor 给默认档位绑定", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);

  assert.equal(registry.get("oc_1"), undefined);
  const binding = registry.bindingFor("oc_1");
  assert.equal(binding.projectId, "default_project");
  assert.equal(binding.agentId, "default_agent");
  assert.equal(binding.sessionId, null);
  assert.equal(binding.skill, null);
  assert.equal(binding.skillSticky, null);
  assert.deepEqual(binding.history, []);
});

test("load：文件损坏时按全新开始，不炸", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.update("oc_1", (b) => {
    b.sessionId = "s1";
  });

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "bindings.json"), "{ 坏 json", "utf8");
  const reloaded = await loadIn(dir);
  assert.equal(reloaded.get("oc_1"), undefined);
});

test("update：改动原子落盘，重新加载读得回来", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.update("oc_1", (b) => {
    b.sessionId = "session-1";
    b.skillSticky = "kelip-paper-reading";
  });

  const reloaded = await loadIn(dir);
  const binding = reloaded.get("oc_1");
  assert.equal(binding?.sessionId, "session-1");
  assert.equal(binding?.skillSticky, "kelip-paper-reading");
});

test("档位字段：model / thinkingLevel / workspace 按聊天存，互不污染", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.update("oc_a", (b) => {
    b.model = { provider: "stepfun", modelId: "step-5-preview" };
    b.thinkingLevel = "high";
    b.workspace = "/tmp/a";
  });
  await registry.update("oc_b", (b) => {
    b.workspace = "/tmp/b";
  });

  const reloaded = await loadIn(dir);
  const a = reloaded.bindingFor("oc_a");
  assert.deepEqual(a.model, { provider: "stepfun", modelId: "step-5-preview" });
  assert.equal(a.thinkingLevel, "high");
  assert.equal(a.workspace, "/tmp/a");
  // oc_b 只设了 workspace，其余缺省 = 跟随默认
  const b = reloaded.bindingFor("oc_b");
  assert.equal(b.model, undefined);
  assert.equal(b.thinkingLevel, undefined);
  assert.equal(b.workspace, "/tmp/b");
});

test("noteSession：置顶、去重、保留归属与模型、超量截断", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.noteSession("oc_1", {
    sessionId: "s1",
    title: "第一次",
    projectId: "default_project",
    agentId: "default_agent",
    model: "step-3",
  });
  // 同一会话再次记录：不带归属与模型，应保留原来的
  await registry.noteSession("oc_1", { sessionId: "s1", title: "第一次（改标题）" });

  let history = registry.bindingFor("oc_1").history;
  assert.equal(history.length, 1);
  assert.equal(history[0]?.title, "第一次（改标题）");
  assert.equal(history[0]?.projectId, "default_project");
  assert.equal(history[0]?.model, "step-3");
  assert.equal(registry.bindingFor("oc_1").sessionId, "s1");

  // 灌满 HISTORY_LIMIT + 1 条：最新的在前，总量封顶
  for (let i = 2; i <= HISTORY_LIMIT + 1; i++) {
    await registry.noteSession("oc_1", { sessionId: `s${i}`, title: `第 ${i} 次` });
  }
  history = registry.bindingFor("oc_1").history;
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0]?.sessionId, `s${HISTORY_LIMIT + 1}`);
  assert.ok(!history.some((item) => item.sessionId === "s1"), "最旧的被挤出");
});

test("sessionsFor：按 (project, agent) 过滤；无归属字段的老登记按默认算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.noteSession("oc_1", {
    sessionId: "s1",
    title: "默认 Agent 的",
    projectId: "default_project",
    agentId: "default_agent",
  });
  await registry.noteSession("oc_1", { sessionId: "s2", title: "别的 Agent 的", projectId: "default_project", agentId: "coder" });
  await registry.noteSession("oc_1", { sessionId: "s3", title: "别的项目的", projectId: "demo", agentId: "default_agent" });
  // 手工塞一条没有归属字段的老登记（v1.0 之前的格式）
  await registry.update("oc_1", (b) => {
    b.history.push({ sessionId: "s0", title: "老登记", at: "2026-10-01T00:00:00.000Z" });
  });

  const binding = registry.bindingFor("oc_1");
  const ids = registry.sessionsFor(binding).map((item) => item.sessionId);
  assert.deepEqual(ids, ["s1", "s0"]);
});

test("迁移：feishu_* 绑定迁回默认 Agent 并清掉会话引用，且落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.update("oc_legacy", (b) => {
    b.agentId = "feishu_e4474947a5bf";
    b.sessionId = "session-legacy";
  });
  await registry.update("oc_keep", (b) => {
    b.sessionId = "session-live";
  });

  // 重新加载触发迁移
  const reloaded = await loadIn(dir);
  const legacy = reloaded.get("oc_legacy");
  assert.equal(legacy?.agentId, "default_agent");
  assert.equal(legacy?.sessionId, null);
  // 历史记录原样保留（按归属自然过滤，不在这里动手脚）
  const keep = reloaded.get("oc_keep");
  assert.equal(keep?.agentId, "default_agent");
  assert.equal(keep?.sessionId, "session-live");

  // 迁移已落盘：文件里不再是 feishu_*
  const bindings = await readBindings(dir);
  assert.equal((bindings.oc_legacy as { agentId: string }).agentId, "default_agent");
  assert.equal((bindings.oc_legacy as { sessionId: null }).sessionId, null);
  assert.equal((bindings.oc_keep as { sessionId: string }).sessionId, "session-live");
});

test("迁移：没有 feishu_* 绑定时不写文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-registry-"));
  const registry = await loadIn(dir);
  await registry.update("oc_1", (b) => {
    b.sessionId = "s1";
  });
  const before = await readFile(join(dir, "bindings.json"), "utf8");

  await loadIn(dir);
  const after = await readFile(join(dir, "bindings.json"), "utf8");
  assert.equal(after, before, "无需迁移时不该重写文件");
});
