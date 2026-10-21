// 控制平面：把 Channel、Lane、Registry、AMSP 客户端接起来，处理每条入站消息。
// 命令分发见 router.ts（纯解析）；这里只做状态变更与回复。

import type { ChannelAdapter, IncomingMessage } from "./channels/types.js";
import type { BridgeConfig } from "./config.js";
import type { Lanes } from "./lanes.js";
import type { Logger } from "./logger.js";
import type { AgentRef, AmspClient } from "./penguin/amsp.js";
import { executeRun } from "./penguin/runner.js";
import type { Registry } from "./registry.js";
import type { RunLog } from "./runlog.js";
import { formatSkillInput, helpText, parseCommand, type Command } from "./router.js";

export const BUSY_HINT = "⏳ 这个聊天正在执行中，`/stop` 可中断，请稍候再发。";

/** 档位切换（owner 动态模式）入口；T7 注入实现，缺省时命令不可用。 */
export interface TierController {
  listProjects(): Promise<string>;
  selectProject(name: string): Promise<string>;
  listAgents(): Promise<string>;
  selectAgent(name: string): Promise<string>;
  listModels(): Promise<string>;
  selectModel(name: string): Promise<string>;
  selectThinking(level: string): Promise<string>;
  selectWorkspace(path: string): Promise<string>;
  /** /status 里的档位回显。 */
  describeTiers(): Promise<string>;
}

export interface GatewayDeps {
  config: BridgeConfig;
  channel: ChannelAdapter;
  lanes: Lanes;
  logger: Logger;
  registry: Registry;
  runLog: RunLog;
  /** 取某个 Agent 的 AMSP 客户端（内部持有对应 key）。 */
  clientFor: (agent: AgentRef) => Promise<AmspClient>;
  /** owner 动态模式控制器；未注入时档位命令不可用。 */
  tiers?: TierController;
}

interface ActiveRun {
  abort: () => Promise<void>;
}

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly logger: Logger;
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(deps: GatewayDeps) {
    this.deps = deps;
    this.logger = deps.logger;
  }

  async start(): Promise<void> {
    await this.deps.channel.start((message) => this.handleMessage(message));
  }

  async stop(): Promise<void> {
    await this.deps.channel.stop();
  }

  /** 供命令处理器复用：回复一个聊天。 */
  async reply(chatId: string, markdown: string): Promise<void> {
    await this.deps.channel.send(chatId, markdown);
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    const parsed = parseCommand(message.text);
    try {
      await this.dispatch(message, parsed);
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      this.logger.error(`处理消息失败：${text}`);
      await this.safeReply(message.chatId, `出错了：${text}`);
    }
  }

  private async dispatch(message: IncomingMessage, parsed: Command): Promise<void> {
    switch (parsed.kind) {
      case "run":
        await this.handleRun(message, parsed.text);
        return;
      case "help":
        await this.reply(message.chatId, helpText());
        return;
      case "new":
        await this.deps.registry.update(message.chatId, (binding) => {
          binding.sessionId = null;
          binding.skill = null;
        });
        await this.reply(message.chatId, "✅ 已新开会话，下一条消息开始新的上下文。");
        return;
      case "sessions":
        await this.handleSessions(message.chatId);
        return;
      case "use":
        await this.handleUse(message.chatId, parsed.index);
        return;
      case "skill":
        await this.handleSkill(message.chatId, parsed.name, parsed.mode);
        return;
      case "status":
        await this.handleStatus(message.chatId);
        return;
      case "stop":
        await this.handleStop(message.chatId);
        return;
      case "project":
        await this.withTiers(message.chatId, (tiers) => tiers.listProjects());
        return;
      case "project.select":
        await this.withTiers(message.chatId, (tiers) => tiers.selectProject(parsed.name));
        return;
      case "agent":
        await this.withTiers(message.chatId, (tiers) => tiers.listAgents());
        return;
      case "agent.select":
        await this.withTiers(message.chatId, (tiers) => tiers.selectAgent(parsed.name));
        return;
      case "model":
        await this.withTiers(message.chatId, (tiers) => tiers.listModels());
        return;
      case "model.select":
        await this.withTiers(message.chatId, (tiers) => tiers.selectModel(parsed.name));
        return;
      case "thinking":
        await this.withTiers(message.chatId, (tiers) => tiers.selectThinking(parsed.level));
        return;
      case "workspace":
        await this.withTiers(message.chatId, (tiers) => tiers.selectWorkspace(parsed.path));
        return;
      case "invalid":
        await this.reply(message.chatId, `⚠️ ${parsed.reason}`);
        return;
      case "unknown":
        await this.reply(message.chatId, `未知命令 \`/${parsed.command}\`，\`/help\` 查看全部命令。`);
        return;
    }
  }

  /** 档位命令统一入口：控制器缺失时给出明确提示。 */
  private async withTiers(chatId: string, call: (tiers: TierController) => Promise<string>): Promise<void> {
    const tiers = this.deps.tiers;
    if (tiers === undefined) {
      await this.reply(chatId, "⚠️ 档位切换未启用（owner 会话未配置）。");
      return;
    }
    await this.reply(chatId, await call(tiers));
  }

  // ---- Run ----

  private async handleRun(message: IncomingMessage, text: string): Promise<void> {
    const chatId = message.chatId;

    // 忙就直接提示：不排队，也不消耗这个聊天的一次性 skill。
    if (this.deps.lanes.isBusy(chatId)) {
      await this.reply(chatId, BUSY_HINT);
      return;
    }

    const binding = this.deps.registry.bindingFor(chatId);

    // skill：一次性优先，否则粘滞；注入后清掉一次性。
    const skill = binding.skill ?? binding.skillSticky;
    if (binding.skill !== null) {
      await this.deps.registry.update(chatId, (b) => {
        b.skill = null;
      });
    }
    const input = skill === null ? text : formatSkillInput(skill, text);

    const attempt = await this.deps.lanes.run(chatId, async () => {
      const client = await this.deps.clientFor({
        projectId: binding.projectId,
        agentId: binding.agentId,
      });
      try {
        return await executeRun(
          { channel: this.deps.channel, logger: this.logger },
          {
            chatId,
            input,
            ...(binding.sessionId !== null ? { sessionId: binding.sessionId } : {}),
            client,
            preview: {
              throttleMs: this.deps.config.previewThrottleMs,
              throttleChars: this.deps.config.previewThrottleChars,
              maxChars: this.deps.config.previewMaxChars,
            },
            onStart: (run) => {
              this.activeRuns.set(chatId, { abort: run.abort });
            },
          },
        );
      } finally {
        this.activeRuns.delete(chatId);
      }
    });

    if (!attempt.started) {
      await this.reply(chatId, BUSY_HINT);
      return;
    }

    const report = attempt.value;
    if (report.sessionId !== null && report.sessionId !== binding.sessionId) {
      await this.deps.registry.noteSession(chatId, {
        sessionId: report.sessionId,
        title: text.slice(0, 40),
        ...(report.modelId !== null ? { model: report.modelId } : {}),
      });
    }
    await this.deps.runLog.append(report);
  }

  private async safeReply(chatId: string, markdown: string): Promise<void> {
    try {
      await this.reply(chatId, markdown);
    } catch (error: unknown) {
      this.logger.error(`回复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- 控制命令 ----

  private async handleSessions(chatId: string): Promise<void> {
    const binding = this.deps.registry.bindingFor(chatId);
    if (binding.history.length === 0) {
      await this.reply(chatId, "这个聊天还没有历史会话，发一条消息就开始新的对话。");
      return;
    }
    const lines = binding.history.map(
      (item, index) =>
        `${index + 1}. ${item.title || "（无标题）"} — ${item.at.slice(0, 16).replace("T", " ")}` +
        `${item.model !== undefined ? ` — \`${item.model}\`` : ""} — \`${item.sessionId}\``,
    );
    const current = binding.sessionId === null ? "无（下一条消息新建）" : `\`${binding.sessionId}\``;
    await this.reply(
      chatId,
      `**最近会话**（当前：${current}）\n${lines.join("\n")}\n\n用 \`/use <序号>\` 切回去续聊。`,
    );
  }

  private async handleUse(chatId: string, index: number): Promise<void> {
    const binding = this.deps.registry.bindingFor(chatId);
    const record = binding.history[index - 1];
    if (record === undefined) {
      await this.reply(chatId, `⚠️ 没有第 ${index} 个会话，\`/sessions\` 查看列表。`);
      return;
    }
    await this.deps.registry.update(chatId, (b) => {
      b.sessionId = record.sessionId;
    });
    await this.reply(chatId, `✅ 已切回会话 \`${record.sessionId}\`，下一条消息继续该对话。`);
  }

  private async handleSkill(chatId: string, name: string | null, mode: "once" | "on" | "off"): Promise<void> {
    if (mode === "off") {
      await this.deps.registry.update(chatId, (b) => {
        b.skill = null;
        b.skillSticky = null;
      });
      await this.reply(chatId, "✅ 已关闭 Skill 注入。");
      return;
    }
    if (name === null) return;
    if (mode === "on") {
      await this.deps.registry.update(chatId, (b) => {
        b.skillSticky = name;
      });
      await this.reply(chatId, `✅ 已粘滞启用 skill「${name}」，后续消息都会带上它，\`/skill off\` 关闭。`);
      return;
    }
    await this.deps.registry.update(chatId, (b) => {
      b.skill = name;
    });
    await this.reply(chatId, `✅ 下一条消息将使用 skill「${name}」执行。`);
  }

  private async handleStatus(chatId: string): Promise<void> {
    const binding = this.deps.registry.bindingFor(chatId);
    const lines = [
      "**当前绑定**",
      `- Project：\`${binding.projectId}\``,
      `- Agent：\`${binding.agentId}\``,
      `- 会话：${binding.sessionId === null ? "新会话（下一条消息新建）" : `\`${binding.sessionId}\``}`,
      `- Skill：${binding.skillSticky !== null ? `粘滞「${binding.skillSticky}」` : binding.skill !== null ? `一次性「${binding.skill}」` : "无"}`,
    ];
    if (this.deps.tiers) {
      lines.push(await this.deps.tiers.describeTiers());
    }
    if (binding.sessionId !== null) {
      try {
        const client = await this.deps.clientFor({
          projectId: binding.projectId,
          agentId: binding.agentId,
        });
        const info = await client.session(binding.sessionId);
        lines.push(`**会话状态**：${info.status}，模型 \`${info.model_id}\``);
      } catch (error: unknown) {
        lines.push(`**会话状态**：查询失败（${error instanceof Error ? error.message : String(error)}）`);
      }
    } else {
      lines.push("**会话状态**：尚未开始");
    }

    const last = await this.deps.runLog.lastFor(chatId);
    if (last !== null) {
      lines.push(
        `**上次 Run**：${last.status}` +
          `${last.usageTotal !== null ? `，${last.usageTotal} tokens` : ""}` +
          `，${(last.durationMs / 1000).toFixed(1)}s` +
          `${last.modelId !== null ? `，\`${last.modelId}\`` : ""}`,
      );
    }

    if (this.deps.lanes.isBusy(chatId)) lines.push("", BUSY_HINT);
    await this.reply(chatId, lines.join("\n"));
  }

  private async handleStop(chatId: string): Promise<void> {
    const active = this.activeRuns.get(chatId);
    if (active === undefined) {
      await this.reply(chatId, "当前没有正在执行的任务。");
      return;
    }
    await active.abort();
    await this.reply(chatId, "🛑 已中断当前执行。");
  }
}
