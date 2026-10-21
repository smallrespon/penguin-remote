// 档位命令的 owner 动态模式实现（ADR-0002）：
// /project /agent /model /thinking /workspace 的列出与切换。
// 首次在某聊天改档位时懒建专属 Agent 并铸 key，隔离 Agent 级设置的全局副作用。

import type { Registry } from "./registry.js";
import type { Logger } from "./logger.js";
import type { AgentSupply } from "./penguin/agents.js";
import type { OwnerSession, ModelInfo } from "./penguin/owner.js";
import type { TierController } from "./gateway.js";

/** /model 列表一次展示多少个（全量有几百个）。 */
const MODEL_PREVIEW = 30;

export class TierCommands implements TierController {
  private readonly deps: {
    owner: OwnerSession;
    supply: AgentSupply;
    registry: Registry;
    logger: Logger;
  };

  constructor(deps: {
    owner: OwnerSession;
    supply: AgentSupply;
    registry: Registry;
    logger: Logger;
  }) {
    this.deps = deps;
  }

  async listProjects(chatId: string): Promise<string> {
    const projects = await this.deps.owner.listProjects();
    const binding = this.deps.registry.bindingFor(chatId);
    const lines = projects.map(
      (p) =>
        `${p.projectId === binding.projectId ? "→" : " "} \`${p.projectId}\`` +
        `${p.name !== undefined ? ` — ${p.name}` : ""}`,
    );
    return `**Projects**\n${lines.join("\n")}\n\n用 \`/project <名字>\` 切换（会换对话）。`;
  }

  async selectProject(chatId: string, name: string): Promise<string> {
    const projects = await this.deps.owner.listProjects();
    if (!projects.some((p) => p.projectId === name)) {
      return `⚠️ 没有 Project \`${name}\`，\`/project\` 查看列表。`;
    }
    await this.deps.registry.update(chatId, (b) => {
      b.projectId = name;
      b.sessionId = null;
    });
    return `✅ 已切换 Project \`${name}\`，会话已重置；用 \`/agent\` 选该项目的 Agent。`;
  }

  async listAgents(chatId: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const agents = await this.deps.owner.listAgents(binding.projectId);
    const lines = agents.map(
      (a) =>
        `${a.agentId === binding.agentId ? "→" : " "} \`${a.agentId}\`` +
        `${a.name !== undefined ? ` — ${a.name}` : ""}` +
        `${a.apiEnabled === false ? "（API 未开启）" : ""}`,
    );
    return `**Agents（${binding.projectId}）**\n${lines.join("\n")}\n\n用 \`/agent <名字>\` 切换（会换对话）。`;
  }

  async selectAgent(chatId: string, name: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const agents = await this.deps.owner.listAgents(binding.projectId);
    if (!agents.some((a) => a.agentId === name)) {
      return `⚠️ 没有 Agent \`${name}\`，\`/agent\` 查看列表。`;
    }
    await this.deps.registry.update(chatId, (b) => {
      b.agentId = name;
      b.sessionId = null;
    });
    return `✅ 已切换 Agent \`${name}\`，上下文按新 Agent 干净开始。`;
  }

  async listModels(chatId: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const catalog = await this.deps.owner.listModels(binding.projectId);
    const models = catalog.models;
    const isDefault = (m: ModelInfo): boolean =>
      m.isDefault === true ||
      (catalog.defaultModel !== null &&
        catalog.defaultModel.provider === m.provider &&
        catalog.defaultModel.modelId === m.modelId);
    const lines = models
      .slice(0, MODEL_PREVIEW)
      .map(
        (m) =>
          `${isDefault(m) ? "→" : " "} \`${m.provider}/${m.modelId}\`` +
          `${m.displayName !== undefined ? ` — ${m.displayName}` : ""}`,
      );
    return (
      `**可用模型（共 ${models.length} 个，前 ${Math.min(MODEL_PREVIEW, models.length)} 个）**\n${lines.join("\n")}\n\n` +
      "用 `/model <provider/modelId 或 modelId>` 切换。"
    );
  }

  async selectModel(chatId: string, name: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const { models } = await this.deps.owner.listModels(binding.projectId);
    const matches = matchModels(models, name);
    if (matches.length === 0) {
      return `⚠️ 没有匹配 \`${name}\` 的模型，\`/model\` 查看可用列表。`;
    }
    if (matches.length > 1) {
      const lines = matches
        .slice(0, 10)
        .map((m) => `\`${m.provider}/${m.modelId}\`${m.displayName !== undefined ? ` — ${m.displayName}` : ""}`);
      return `⚠️ \`${name}\` 匹配到多个模型，请写全：\n${lines.join("\n")}`;
    }
    const model = matches[0];
    if (model === undefined) return "⚠️ 没有匹配的模型。";
    const ref = await this.deps.supply.ensureDedicatedAgent(binding.projectId, binding.agentId, chatId);
    await this.deps.owner.putAgentApi(ref.projectId, ref.agentId, {
      model: { provider: model.provider, modelId: model.modelId },
    });
    await this.noteDedicated(chatId, binding.agentId, ref);
    return `✅ 已切换模型 \`${model.provider}/${model.modelId}\`，下一新会话生效。`;
  }

  async selectThinking(chatId: string, level: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const ref = await this.deps.supply.ensureDedicatedAgent(binding.projectId, binding.agentId, chatId);
    await this.deps.owner.putAgentApi(ref.projectId, ref.agentId, { thinkingLevel: level });
    await this.noteDedicated(chatId, binding.agentId, ref);
    return `✅ 思考档位已设为 \`${level}\`，下一新会话生效。`;
  }

  async selectWorkspace(chatId: string, path: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const ref = await this.deps.supply.ensureDedicatedAgent(binding.projectId, binding.agentId, chatId);
    await this.deps.owner.putAgentApi(ref.projectId, ref.agentId, { workspace: path });
    await this.noteDedicated(chatId, binding.agentId, ref);
    return `✅ 工作区已设为 \`${path}\`，下一新会话生效。`;
  }

  async describeTiers(chatId: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    try {
      const { api } = await this.deps.owner.getAgentApi(binding.projectId, binding.agentId);
      const model = api.model === null ? "跟随默认" : `\`${api.model.provider}/${api.model.modelId}\``;
      const thinking = api.thinkingLevel ?? "跟随默认";
      const workspace = api.workspace ?? "临时工作区";
      return `- 模型：${model}\n- 思考：${thinking}\n- 工作区：\`${workspace}\``;
    } catch (error: unknown) {
      this.deps.logger.warn(`读取档位失败：${error instanceof Error ? error.message : String(error)}`);
      return "- 档位：读取失败";
    }
  }

  /** 档位切换可能刚懒建了专属 Agent：把绑定切过去并重置会话。 */
  private async noteDedicated(
    chatId: string,
    previousAgentId: string,
    ref: { projectId: string; agentId: string },
  ): Promise<void> {
    if (ref.agentId === previousAgentId) return;
    await this.deps.registry.update(chatId, (b) => {
      b.agentId = ref.agentId;
      b.sessionId = null;
    });
  }
}

/** 模型名匹配：`provider/modelId`、裸 `modelId` 或 displayName，大小写不敏感。 */
export function matchModels(models: readonly ModelInfo[], name: string): ModelInfo[] {
  const needle = name.trim().toLowerCase();
  if (needle === "") return [];
  return models.filter((m) => {
    const full = `${m.provider}/${m.modelId}`.toLowerCase();
    return (
      full === needle ||
      m.modelId.toLowerCase() === needle ||
      (m.displayName ?? "").toLowerCase() === needle
    );
  });
}
