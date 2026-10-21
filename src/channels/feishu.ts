// Feishu 适配器：基于 lark-cli 子进程的 Channel 适配器实现。
// 入：`event consume im.message.receive_v1 --as bot` 的 NDJSON 事件流；
// 出：`im +messages-send` / `im +messages-edit`（bot only）。

import type { ChannelAdapter, IncomingMessage } from "./types.js";
import { runCommand, readLines, spawnManaged, type ManagedChild, type SpawnFn } from "../proc.js";
import type { Logger } from "../logger.js";
import { redact } from "../logger.js";

export interface FeishuChannelOptions {
  /** lark-cli 可执行文件。 */
  bin: string;
  logger: Logger;
  /** 注入用：长驻子进程的启动方式。 */
  spawn?: SpawnFn;
  /** 注入用：机器人 open_id 的获取方式（默认走 lark-cli bot/v3/info）。 */
  resolveBotOpenId?: () => Promise<string>;
  /** 注入用：一次性命令的执行方式。 */
  run?: typeof runCommand;
}

/** lark-cli 的输出信封。 */
interface LarkEnvelope {
  ok?: boolean;
  data?: { message_id?: string } & Record<string, unknown>;
  error?: { message?: string } & Record<string, unknown>;
}

const MENTION_PLACEHOLDER = /@_user_\d+/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 剥掉文本里的 @：占位符（`@_user_1`）与已渲染成显示名的 @（`@名字` / 行首的名字）。
 * lark-cli 的 content 是「预渲染可读文本」，两种形状都要防。
 */
export function stripMentions(text: string, mentionNames: readonly string[] = []): string {
  let out = text.replace(MENTION_PLACEHOLDER, " ");
  for (const name of [...mentionNames].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length)) {
    const escaped = escapeRegExp(name);
    out = out.replace(new RegExp(`@${escaped}`, "g"), " ");
    out = out.replace(new RegExp(`^\\s*${escaped}(?=\\s|$)`, "u"), " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** content 可能是预渲染文本，也可能是 `{"text":"..."}` 原文；两者都取到可读文本。 */
function readContent(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === "string") return parsed.text;
    } catch {
      // 不是 JSON：按纯文本用
    }
  }
  return raw;
}

/**
 * 把一条 `im.message.receive_v1` 事件解码成统一消息；不该响应的返回 null：
 * 非消息事件、机器人自己发的、非文本/富文本类型、群聊里没被 @、剥离后空文本。
 */
export function decodeMessageEvent(raw: unknown, botOpenId: string): IncomingMessage | null {
  const event = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const payload = (typeof event.event === "object" && event.event !== null ? event.event : event) as Record<
    string,
    unknown
  >;
  if (payload.type !== undefined && payload.type !== "im.message.receive_v1") return null;

  const chatId = str(payload.chat_id);
  const messageId = str(payload.message_id) || str(payload.id);
  const senderId = str(payload.sender_id);
  const chatType = payload.chat_type === "group" ? "group" : payload.chat_type === "p2p" ? "p2p" : null;
  if (chatId === "" || messageId === "" || senderId === "" || chatType === null) return null;
  if (payload.sender_type === "bot") return null;

  const messageType = str(payload.message_type);
  if (messageType !== "" && messageType !== "text" && messageType !== "post") return null;

  const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
  if (chatType === "group") {
    const mentioned = mentions.some(
      (m) => typeof m === "object" && m !== null && (m as { id?: unknown }).id === botOpenId,
    );
    if (!mentioned) return null;
  }
  const mentionNames = mentions
    .map((m) => (typeof m === "object" && m !== null ? str((m as { name?: unknown }).name) : ""))
    .filter((name) => name !== "");

  const text = stripMentions(readContent(payload.content), mentionNames);
  if (text === "") return null;
  return { chatId, chatType, messageId, senderId, text };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function defaultBotOpenId(bin: string): Promise<string> {
  const result = await runCommand(bin, ["api", "GET", "/open-apis/bot/v3/info", "--as", "bot"]);
  const envelope = parseEnvelope(result.stdout);
  if (result.status !== 0 || envelope?.ok !== true) {
    throw new Error(
      `获取机器人身份失败（lark-cli exit=${result.status}）：${envelope?.error?.message ?? result.stderr.trim()}`,
    );
  }
  const openId = (envelope.data as { open_id?: unknown } | undefined)?.open_id;
  if (typeof openId !== "string" || openId === "") {
    throw new Error("lark-cli 未返回机器人 open_id，无法判断群聊 @ 闸门");
  }
  return openId;
}

function parseEnvelope(stdout: string): LarkEnvelope | null {
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as LarkEnvelope;
  } catch {
    return null;
  }
}

export class FeishuChannel implements ChannelAdapter {
  private readonly bin: string;
  private readonly logger: Logger;
  private readonly spawn: SpawnFn;
  private readonly resolveBotOpenId: () => Promise<string>;
  private readonly run: typeof runCommand;

  private handler: ((message: IncomingMessage) => void | Promise<void>) | null = null;
  private botOpenId: string | null = null;
  private consume: ManagedChild | null = null;
  private stopping = false;

  constructor(options: FeishuChannelOptions) {
    this.bin = options.bin;
    this.logger = options.logger;
    this.spawn = options.spawn ?? spawnManaged;
    this.resolveBotOpenId = options.resolveBotOpenId ?? (() => defaultBotOpenId(options.bin));
    this.run = options.run ?? runCommand;
  }

  async start(handler: (message: IncomingMessage) => void | Promise<void>): Promise<void> {
    this.handler = handler;
    this.stopping = false;
    this.botOpenId = await this.resolveBotOpenId();
    this.logger.info(`飞书机器人身份就绪：${this.botOpenId}`);
    this.spawnConsume();
  }

  private spawnConsume(): void {
    const child = this.spawn(this.bin, ["event", "consume", "im.message.receive_v1", "--as", "bot"]);
    this.consume = child;
    if (child.stdout) {
      readLines(child.stdout, (line) => this.onLine(line));
    }
    if (child.stderr) {
      readLines(child.stderr, (line) => this.logger.debug(`lark-cli[stderr] ${redact(line)}`));
    }
    // 保持 stdin 不 EOF：lark-cli 的 consume 在 stdin EOF 时优雅退出。
    void child.exited.then(({ code, signal }) => {
      if (this.stopping) return;
      this.logger.warn(`事件流子进程退出（code=${code} signal=${signal}），等待守护重启`);
      this.consume = null;
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(":")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.logger.debug(`跳过无法解析的事件行：${redact(trimmed.slice(0, 200))}`);
      return;
    }
    const message = decodeMessageEvent(parsed, this.botOpenId ?? "");
    if (message === null) return;
    void this.deliver(message);
  }

  private async deliver(message: IncomingMessage): Promise<void> {
    try {
      await this.handler?.(message);
    } catch (error: unknown) {
      this.logger.error(`处理消息失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async send(chatId: string, markdown: string): Promise<string> {
    const result = await this.runLark(
      ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--markdown", "-"],
      markdown,
      "发送",
    );
    const messageId = result.data?.message_id;
    if (typeof messageId !== "string") throw new Error("lark-cli 未返回 message_id");
    return messageId;
  }

  async edit(messageId: string, markdown: string): Promise<void> {
    await this.runLark(
      ["im", "+messages-edit", "--as", "bot", "--message-id", messageId, "--markdown", "-"],
      markdown,
      "编辑",
    );
  }

  /** 跑一条 lark-cli 写操作：stdin 传内容，校验输出信封，失败带原因抛出。 */
  private async runLark(
    args: string[],
    input: string,
    what: string,
  ): Promise<{ data?: { message_id?: string } }> {
    const result = await this.run(this.bin, args, { input });
    const envelope = parseEnvelope(result.stdout);
    if (result.status !== 0 || envelope?.ok !== true) {
      throw new Error(
        `${what}消息失败（lark-cli exit=${result.status}）：${envelope?.error?.message ?? result.stderr.trim()}`,
      );
    }
    return { data: envelope.data };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.consume;
    this.consume = null;
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    this.handler = null;
  }
}
