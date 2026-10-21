// 档位命令（ADR-0005 会话 API 版）：
// /project /agent /model /thinking /workspace 的列出与切换。
// 档位（model / thinkingLevel / workspace）写进各聊天自己的 binding，
// 建新会话时下发（见 penguin/runner.ts）——不建 Agent，也不动任何 Agent 的设置，
// 因此一个聊天的档位不会影响其他聊天或默认 Agent 本身。

import type { Registry } from "./registry.js";
import type { Logger } from "./logger.js";
import type { OwnerSession, ModelInfo } from "./penguin/owner.js";
import type { TierController } from "./gateway.js";

/** /model 列表一次展示多少个（全量有几百个）。 */
const MODEL_PREVIEW = 30;

export class TierCommands implements TierController {
  private readonly deps: {
    owner: OwnerSession;
    registry: Registry;
    logger: Logger;
    /** 切 Project 时 Agent 归位到哪个（配置里的默认 Agent）。 */
    defaultAgentId: string;
  };

  constructor(deps: {
    owner: OwnerSession;
    registry: Registry;
    logger: Logger;
    defaultAgentId: string;
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
    // 换 Project = 换 Agent = 换对话：Agent 归位到默认，否则旧 agentId 在新项目里不存在。
    // 模型目录是项目级的：model / thinking 随项目重置；workspace 与项目无关，保留。
    await this.deps.registry.update(chatId, (b) => {
      b.projectId = name;
      b.agentId = this.deps.defaultAgentId;
      b.sessionId = null;
      delete b.model;
      delete b.thinkingLevel;
    });
    return (
      `✅ 已切换 Project \`${name}\`（Agent 归位为 \`${this.deps.defaultAgentId}\`，` +
      "模型/思考档位已重置，会话已重置）；用 `/agent` 选该项目的 Agent。"
    );
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
    // 会话按 Agent 隔离：换了 Agent，旧会话续不了，只能干净开始。
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
    const current =
      binding.model === undefined
        ? ""
        : `\n\n当前：\`${binding.model.provider}/${binding.model.modelId}\``;
    return (
      `**可用模型（共 ${models.length} 个，前 ${Math.min(MODEL_PREVIEW, models.length)} 个）**\n${lines.join("\n")}\n\n` +
      `用 \`/model <provider/modelId 或 modelId>\` 切换。${current}`
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
    // 只写本聊天的 binding：建新会话时下发，不碰任何 Agent 的设置。
    // 已存在的会话保持它创建时的档位（「下一新会话生效」是字面语义）。
    await this.deps.registry.update(chatId, (b) => {
      b.model = { provider: model.provider, modelId: model.modelId };
    });
    return `✅ 已切换模型 \`${model.provider}/${model.modelId}\`，下一新会话生效。`;
  }

  async selectThinking(chatId: string, level: string): Promise<string> {
    await this.deps.registry.update(chatId, (b) => {
      b.thinkingLevel = level;
    });
    return `✅ 思考档位已设为 \`${level}\`，下一新会话生效。`;
  }

  async selectWorkspace(chatId: string, path: string): Promise<string> {
    await this.deps.registry.update(chatId, (b) => {
      b.workspace = path;
    });
    return `✅ 工作区已设为 \`${path}\`，下一新会话生效。`;
  }

  /** /status 的档位回显：本聊天 binding 里的值，缺省 = 跟随 Agent / Project 默认。 */
  async describeTiers(chatId: string): Promise<string> {
    const binding = this.deps.registry.bindingFor(chatId);
    const model = binding.model === undefined ? "跟随默认" : `\`${binding.model.provider}/${binding.model.modelId}\``;
    const thinking = binding.thinkingLevel ?? "跟随默认";
    const workspace = binding.workspace ?? "临时工作区";
    return `- 模型：${model}\n- 思考：${thinking}\n- 工作区：\`${workspace}\``;
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
