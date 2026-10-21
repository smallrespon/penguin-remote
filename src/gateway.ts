// 控制平面：把 Channel、Lane、AMSP 客户端接起来，处理每条入站消息。
// T4：私聊/群聊来一条普通文本 → 一次 Run → 回一条最终消息；进行中的聊天直接提示。

import type { ChannelAdapter, IncomingMessage } from "./channels/types.js";
import type { BridgeConfig } from "./config.js";
import type { LaneQueue } from "./lanes.js";
import type { Logger } from "./logger.js";
import type { AmspClient } from "./penguin/amsp.js";
import { executeRun } from "./penguin/runner.js";
import { parseInput } from "./router.js";

export const BUSY_HINT = "⏳ 这个聊天正在执行中，`/stop` 可中断，请稍候再发。";

export interface GatewayBinding {
  projectId: string;
  agentId: string;
  sessionId: string | null;
}

export interface GatewayDeps {
  config: BridgeConfig;
  channel: ChannelAdapter;
  lanes: LaneQueue;
  logger: Logger;
  /** 取某个 Agent 的 AMSP 客户端（内部持有对应 key）。 */
  clientFor: (agent: { projectId: string; agentId: string }) => Promise<AmspClient>;
  /** 某个聊天当前生效的绑定。 */
  bindingFor: (chatId: string) => GatewayBinding;
}

export class Gateway {
  private readonly deps: GatewayDeps;
  private readonly logger: Logger;

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
    const parsed = parseInput(message.text);
    if (parsed.kind !== "run") {
      await this.reply(message.chatId, `未知命令 \`/${parsed.command}\`，\`/help\` 查看全部命令。`);
      return;
    }

    if (this.deps.lanes.isBusy(message.chatId)) {
      await this.reply(message.chatId, BUSY_HINT);
      return;
    }

    const binding = this.deps.bindingFor(message.chatId);
    const attempt = await this.deps.lanes.run(message.chatId, async () => {
      const client = await this.deps.clientFor({
        projectId: binding.projectId,
        agentId: binding.agentId,
      });
      return executeRun(
        { channel: this.deps.channel, logger: this.logger },
        {
          chatId: message.chatId,
          input: parsed.text,
          ...(binding.sessionId !== null ? { sessionId: binding.sessionId } : {}),
          client,
        },
      );
    });
    if (!attempt.started) {
      await this.reply(message.chatId, BUSY_HINT);
    }
  }
}
