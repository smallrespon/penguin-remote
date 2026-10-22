// 控制平面：把 Channel、Lane、Registry、会话 API 客户端接起来，处理每条入站消息。
// 命令分发见 router.ts（纯解析）；这里只做状态变更与回复。

import type { ChannelAdapter, IncomingMessage } from "./channels/types.js";
import type { BridgeConfig } from "./config.js";
import { imageDataUrlOrNote, stripImagePlaceholders } from "./images.js";
import type { Lanes } from "./lanes.js";
import { redact } from "./logger.js";
import type { Logger } from "./logger.js";
import type { SessionClient } from "./penguin/sessions.js";
import { executeRun } from "./penguin/runner.js";
import type { Registry } from "./registry.js";
import type { RunLog } from "./runlog.js";
import { BUSY_HINT } from "./render.js";
import { formatSkillInput, helpText, parseCommand, type Command } from "./router.js";

/** 档位切换（owner 动态模式）入口；T7 注入实现，缺省时命令不可用。 */
export interface TierController {
  listProjects(chatId: string): Promise<string>;
  selectProject(chatId: string, name: string): Promise<string>;
  listAgents(chatId: string): Promise<string>;
  selectAgent(chatId: string, name: string): Promise<string>;
  listModels(chatId: string): Promise<string>;
  selectModel(chatId: string, name: string): Promise<string>;
  selectThinking(chatId: string, level: string): Promise<string>;
  selectWorkspace(chatId: string, path: string): Promise<string>;
  /** /status 里的档位回显。 */
  describeTiers(chatId: string): Promise<string>;
}

export interface GatewayDeps {
  config: BridgeConfig;
  channel: ChannelAdapter;
  lanes: Lanes;
  logger: Logger;
  registry: Registry;
  runLog: RunLog;
  /** 会话 API 客户端（owner 令牌当 cookie；所有聊天共用，按会话 id 隔离）。 */
  sessions: SessionClient;
  /** owner 动态模式控制器；未注入时档位命令不可用。 */
  tiers?: TierController;
}

interface ActiveRun {
  abort: () => Promise<void>;
}

/** 会话列表统一条目形态：实时（服务端）与本地历史（Registry）都归一到它再渲染。 */
interface SessionListEntry {
  sessionId: string;
  /** 服务端标题（可能含换行）或本地历史标题；null / 空 = 无标题。 */
  title: string | null;
  /** 展示用时间：实时列表取 lastActiveAt，本地历史取 at；null = 服务端没给。 */
  at: string | null;
  model: string | null;
}

/** 列表查询失败时的兜底注明（ADR-0008：结果不丢，老行为降级为兜底）。 */
const LIVE_LIST_FALLBACK_NOTE = "⚠️ 实时列表查询失败，显示本地历史";

/** 标题拍平（服务端标题可能含换行）后截断到 40 字；空标题给占位。 */
const TITLE_MAX_CHARS = 40;

/** 标题拍平 + 截断；空标题（null 或只有空白）用 emptyLabel 占位。 */
function flattenTitle(title: string | null, emptyLabel: string): string {
  if (title === null) return emptyLabel;
  const flat = title.replace(/\s+/g, " ").trim();
  return flat === "" ? emptyLabel : flat.slice(0, TITLE_MAX_CHARS);
}

/** 本地历史标题：先移除图片占位符再拍平截断；纯图片消息（文本为空）回落占位标题。 */
function runTitle(text: string): string {
  return flattenTitle(stripImagePlaceholders(text), "（图片消息）");
}

/** 兜底降级时给回复加一行注明；实时成功时原文返回。 */
function withFallbackNote(live: boolean, body: string): string {
  return live ? body : `${LIVE_LIST_FALLBACK_NOTE}\n${body}`;
}

/** 一条会话行：序号. 标题 — 最近活跃时间 — `model` — `sessionId`；当前会话行首加 →。 */
function sessionLine(entry: SessionListEntry, index: number, currentSessionId: string | null): string {
  const at = entry.at === null ? "未知时间" : entry.at.slice(0, 16).replace("T", " ");
  const model = entry.model === null ? "" : ` — \`${entry.model}\``;
  const marker = entry.sessionId === currentSessionId ? "→ " : "";
  return `${marker}${index + 1}. ${flattenTitle(entry.title, "（无标题）")} — ${at}${model} — \`${entry.sessionId}\``;
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
    await this.deps.channel.send(chatId, { kind: "text", text: markdown });
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    if (!this.allowed(message)) {
      this.logger.debug(`忽略 allowlist 之外的消息：chat=${message.chatId} sender=${message.senderId}`);
      return;
    }
    const parsed = parseCommand(message.text);
    try {
      await this.dispatch(message, parsed);
    } catch (error: unknown) {
      const text = redact(error instanceof Error ? error.message : String(error));
      this.logger.error(`处理消息失败：${text}`);
      await this.safeReply(message.chatId, `出错了：${text}`);
    }
  }

  /** 访问控制：allowlist 为空 = 开放；否则 chatId 或 senderId 命中才放行。 */
  private allowed(message: IncomingMessage): boolean {
    const list = this.deps.config.allowlist;
    if (list.length === 0) return true;
    return list.includes(message.chatId) || list.includes(message.senderId);
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
        await this.withTiers(message.chatId, (t) => t.listProjects(message.chatId));
        return;
      case "project.select":
        await this.withTiers(message.chatId, (t) => t.selectProject(message.chatId, parsed.name));
        return;
      case "agent":
        await this.withTiers(message.chatId, (t) => t.listAgents(message.chatId));
        return;
      case "agent.select":
        await this.withTiers(message.chatId, (t) => t.selectAgent(message.chatId, parsed.name));
        return;
      case "model":
        await this.withTiers(message.chatId, (t) => t.listModels(message.chatId));
        return;
      case "model.select":
        await this.withTiers(message.chatId, (t) => t.selectModel(message.chatId, parsed.name));
        return;
      case "thinking":
        await this.withTiers(message.chatId, (t) => t.selectThinking(message.chatId, parsed.level));
        return;
      case "workspace":
        await this.withTiers(message.chatId, (t) => t.selectWorkspace(message.chatId, parsed.path));
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
    // chatId 由调用方闭包捕获，这里只做统一的存在性检查。
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

    const attempt = await this.deps.lanes.run(chatId, async () => {
      // 图片入站（ADR-0009）：串行下载转 data URL；下载抛错直接冒泡，由 handleMessage
      // 的统一错误路径脱敏回复（此时还没发占位卡、没投任务）；超限 / 嗅探失败的图
      // 跳过，注明（去重）拼进输入文本——纯图片且全跳过时，注明就是全部输入。
      const dataUrls: string[] = [];
      const notes: string[] = [];
      for (const key of message.images) {
        const bytes = await this.deps.channel.downloadImage(message.messageId, key);
        const decision = imageDataUrlOrNote(bytes);
        if (decision.kind === "ok") dataUrls.push(decision.dataUrl);
        else notes.push(decision.note);
      }
      const inputText = [text, ...new Set(notes)].filter(Boolean).join("\n");
      const input = skill === null ? inputText : formatSkillInput(skill, inputText);
      try {
        return await executeRun(
          { channel: this.deps.channel, logger: this.logger },
          {
            chatId,
            input,
            ...(dataUrls.length > 0 ? { images: dataUrls } : {}),
            agent: { projectId: binding.projectId, agentId: binding.agentId },
            sessionId: binding.sessionId,
            // 档位只在下发新建会话时生效；续接的会话保持它创建时的设置。
            settings: {
              ...(binding.model !== undefined ? { model: binding.model } : {}),
              ...(binding.thinkingLevel !== undefined ? { thinkingLevel: binding.thinkingLevel } : {}),
              ...(binding.workspace !== undefined ? { workspace: binding.workspace } : {}),
            },
            client: this.deps.sessions,
            preview: {
              throttleMs: this.deps.config.previewThrottleMs,
              throttleChars: this.deps.config.previewThrottleChars,
              maxChars: this.deps.config.previewMaxChars,
            },
            onStart: (handle) => {
              this.activeRuns.set(chatId, { abort: handle.abort });
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
        title: runTitle(text),
        ...(report.modelId !== null ? { model: report.modelId } : {}),
        projectId: binding.projectId,
        agentId: binding.agentId,
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

  /**
   * /sessions 与 /use 共用的列表来源（ADR-0008）：实时查服务端当前 (project, agent) 下的
   * 未归档会话；查询失败（网络错误 / 非 2xx）时退回 Registry 本地历史，调用方负责注明。
   */
  private async sessionListFor(chatId: string): Promise<{ entries: SessionListEntry[]; live: boolean }> {
    const binding = this.deps.registry.bindingFor(chatId);
    try {
      const items = await this.deps.sessions.listSessions(binding.projectId, binding.agentId);
      return {
        entries: items.map((item) => ({
          sessionId: item.sessionId,
          title: item.title,
          at: item.lastActiveAt,
          model: item.modelId,
        })),
        live: true,
      };
    } catch (error: unknown) {
      const text = redact(error instanceof Error ? error.message : String(error));
      this.logger.warn(`实时会话列表查询失败，改用本地历史：${text}`);
      return {
        entries: this.deps.registry.sessionsFor(binding).map((item) => ({
          sessionId: item.sessionId,
          title: item.title,
          at: item.at,
          model: item.model ?? null,
        })),
        live: false,
      };
    }
  }

  private async handleSessions(chatId: string): Promise<void> {
    const binding = this.deps.registry.bindingFor(chatId);
    const { entries, live } = await this.sessionListFor(chatId);
    if (entries.length === 0) {
      // 实时为空 = 没有未归档会话（可能都已归档）；本地为空才是「没有历史会话」。
      const empty =
        live
          ? "当前 Project/Agent 下没有未归档的会话，发一条消息就开始新的对话。"
          : "这个聊天在当前 Project/Agent 下还没有历史会话，发一条消息就开始新的对话。";
      await this.reply(chatId, empty);
      return;
    }
    const lines = entries.map((entry, index) => sessionLine(entry, index, binding.sessionId));
    const current = binding.sessionId === null ? "无（下一条消息新建）" : `\`${binding.sessionId}\``;
    const body = `**最近会话**（当前：${current}）\n${lines.join("\n")}\n\n用 \`/use <序号>\` 切回去续聊。`;
    await this.reply(chatId, withFallbackNote(live, body));
  }

  private async handleUse(chatId: string, index: number): Promise<void> {
    const { entries, live } = await this.sessionListFor(chatId);
    const entry = entries[index - 1];
    if (entry === undefined) {
      await this.reply(chatId, `⚠️ 没有第 ${index} 个会话，\`/sessions\` 查看列表。`);
      return;
    }
    // 只改本聊天的会话绑定；会话的创建 / 归档 / 删除仍归服务端与其他客户端。
    await this.deps.registry.update(chatId, (b) => {
      b.sessionId = entry.sessionId;
    });
    const done = `✅ 已切回会话 \`${entry.sessionId}\`，下一条消息继续该对话。`;
    await this.reply(chatId, withFallbackNote(live, done));
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
      lines.push(await this.deps.tiers.describeTiers(chatId));
    }
    if (binding.sessionId !== null) {
      try {
        const info = await this.deps.sessions.sessionInfo(binding.sessionId);
        lines.push(`**会话状态**：${info.status}，模型 \`${info.modelId ?? "未知"}\``);
      } catch (error: unknown) {
        lines.push(`**会话状态**：查询失败（${redact(error instanceof Error ? error.message : String(error))}）`);
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
