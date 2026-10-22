// Feishu 适配器：基于 lark-cli 子进程的 Channel 适配器实现。
// 入：`event consume im.message.receive_v1 --as bot` 的 NDJSON 事件流；
// 出：`im +messages-send` / `im +messages-edit`（文本），
//     `im +messages-send --msg-type interactive` / `im messages patch`（交互卡片）。

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { ChannelAdapter, IncomingMessage, OutboundMessage } from "./types.js";
import { runCommand, readLines, spawnManaged, type ManagedChild, type SpawnFn } from "../proc.js";
import { extractImageKeys } from "../images.js";
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
  data?: { message_id?: string; file_key?: string; saved_path?: string } & Record<string, unknown>;
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
 * 非消息事件、机器人自己发的、非文本/富文本/图片类型、群聊里没被 @、剥离后既无文本也无图片。
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
  // 纯图片消息（image）同样只带图片占位符；文件/音频/视频/表情等仍不响应。
  if (messageType !== "" && messageType !== "text" && messageType !== "post" && messageType !== "image") return null;

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

  const { keys, text: withoutImages } = extractImageKeys(readContent(payload.content));
  const text = stripMentions(withoutImages, mentionNames);
  // 纯图片消息：文本为空但有图片，仍是合法消息。
  if (text === "" && keys.length === 0) return null;
  return { chatId, chatType, messageId, senderId, text, images: keys };
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

/** 从信封里取 message_id；缺失说明 lark-cli 行为不符合预期，直接抛错。 */
function messageIdOf(result: { data?: { message_id?: string } }): string {
  const messageId = result.data?.message_id;
  if (typeof messageId !== "string") throw new Error("lark-cli 未返回 message_id");
  return messageId;
}

/** 从信封里取 file_key；缺失说明上传没成功，直接抛错。 */
function fileKeyOf(result: { data?: { file_key?: string } }): string {
  const fileKey = result.data?.file_key;
  if (typeof fileKey !== "string" || fileKey === "") {
    throw new Error("lark-cli 未返回 file_key，无法发送文件消息");
  }
  return fileKey;
}

export class FeishuChannel implements ChannelAdapter {
  /** 子进程退出后重启的初始退避；每次连续退出翻倍，封顶 MAX_BACKOFF_MS。 */
  private static readonly INITIAL_BACKOFF_MS = 1000;
  private static readonly MAX_BACKOFF_MS = 30_000;
  /** 存活超过这么久就算「稳了」，下次重启退避回到初始值。 */
  private static readonly STABLE_MS = 10_000;

  private readonly bin: string;
  private readonly logger: Logger;
  private readonly spawn: SpawnFn;
  private readonly resolveBotOpenId: () => Promise<string>;
  private readonly run: typeof runCommand;

  private handler: ((message: IncomingMessage) => void | Promise<void>) | null = null;
  private botOpenId: string | null = null;
  private consume: ManagedChild | null = null;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private backoffMs = FeishuChannel.INITIAL_BACKOFF_MS;

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
    // 存活够久就算稳定：把退避重置，避免一次偶发崩溃后长时间慢重启。
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.backoffMs = FeishuChannel.INITIAL_BACKOFF_MS;
    }, FeishuChannel.STABLE_MS);
    void child.exited.then(({ code, signal }) => {
      if (this.stableTimer !== null) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      if (this.stopping) return;
      this.logger.warn(`事件流子进程退出（code=${code} signal=${signal}），稍后重启`);
      this.consume = null;
      this.scheduleRestart();
    });
  }

  /** 退避重启：连续崩溃时越等越久（封顶 30s），直到进程稳定运行。 */
  private scheduleRestart(): void {
    if (this.stopping) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, FeishuChannel.MAX_BACKOFF_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping || this.consume !== null) return;
      this.logger.info(`重启事件流子进程（距上次退出 ${delay}ms）`);
      this.spawnConsume();
    }, delay);
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

  async send(chatId: string, message: OutboundMessage): Promise<string> {
    if (message.kind === "file") {
      return await this.sendFile(chatId, message.path, message.name);
    }
    if (message.kind === "card") {
      const result = await this.runLark(
        ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "interactive", "--content", "-"],
        JSON.stringify(message.card),
        "发送卡片",
      );
      return messageIdOf(result);
    }
    const result = await this.runLark(
      ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--markdown", "-"],
      message.text,
      "发送文本",
    );
    return messageIdOf(result);
  }

  /**
   * 发一个文件（ADR-0012 的 HTML 页面）：飞书要求先上传拿 file_key，再按 file 类型发消息，
   * 所以是两条 lark-cli 命令。任一步失败都抛出——调用方（runner）记日志后继续，结果不丢。
   */
  private async sendFile(chatId: string, path: string, name?: string): Promise<string> {
    const uploaded = await this.runLark(
      ["im", "files", "create", "--as", "bot", "--data", "-", "--file", path],
      JSON.stringify({ file_type: "stream", file_name: name ?? basename(path) }),
      "上传文件",
    );
    const result = await this.runLark(
      ["im", "+messages-send", "--as", "bot", "--chat-id", chatId, "--msg-type", "file", "--content", "-"],
      JSON.stringify({ file_key: fileKeyOf(uploaded) }),
      "发送文件",
    );
    return messageIdOf(result);
  }

  async edit(messageId: string, message: OutboundMessage): Promise<void> {
    // 文件消息发出去就改不了：没有对应的 lark-cli 写操作，也不该悄悄假装成功。
    if (message.kind === "file") {
      throw new Error("文件消息不支持编辑");
    }
    if (message.kind === "card") {
      await this.runLark(
        ["im", "messages", "patch", "--as", "bot", "--message-id", messageId, "--data", "-"],
        // patch 的 content 要的是 JSON 序列化后的字符串，所以是双层转义。
        JSON.stringify({ content: JSON.stringify(message.card) }),
        "更新卡片",
      );
      return;
    }
    await this.runLark(
      ["im", "+messages-edit", "--as", "bot", "--message-id", messageId, "--markdown", "-"],
      message.text,
      "编辑文本",
    );
  }

  /** 跑一条 lark-cli 写操作：stdin 传内容，校验输出信封，失败带原因抛出。 */
  private async runLark(
    args: string[],
    input: string,
    what: string,
  ): Promise<{ data?: LarkEnvelope["data"] }> {
    const result = await this.run(this.bin, args, { input });
    const envelope = parseEnvelope(result.stdout);
    if (result.status !== 0 || envelope?.ok !== true) {
      throw new Error(
        `${what}消息失败（lark-cli exit=${result.status}）：${envelope?.error?.message ?? result.stderr.trim()}`,
      );
    }
    return { data: envelope.data };
  }

  /**
   * 下载一条入站消息里的图片：lark-cli 把二进制落到临时文件，读进内存后**立刻删除**（成功与失败都删）。
   * 临时文件落在 `os.tmpdir()`（lark-cli 的 --output 只接受允许目录内的路径）。
   * 删除按信封回报的 `saved_path` 走（lark-cli 可能补扩展名，与实际落盘路径未必等于 --output），
   * 同时兜底删一次请求路径，两个都删保证不残留。
   */
  async downloadImage(messageId: string, fileKey: string): Promise<Buffer> {
    const tmpPath = join(tmpdir(), `penguin-remote-image-${randomUUID()}`);
    let savedPath: string | null = null;
    try {
      const result = await this.run(this.bin, [
        "im",
        "+messages-resources-download",
        "--as",
        "bot",
        "--message-id",
        messageId,
        "--file-key",
        fileKey,
        "--type",
        "image",
        "--output",
        tmpPath,
      ]);
      const envelope = parseEnvelope(result.stdout);
      if (result.status !== 0 || envelope?.ok !== true) {
        throw new Error(
          `下载图片失败（lark-cli exit=${result.status}）：${redact(envelope?.error?.message ?? result.stderr.trim())}`,
        );
      }
      const reported = envelope.data?.saved_path;
      if (reported === undefined || reported === "") {
        throw new Error("lark-cli 未返回 saved_path，无法读取下载的图片");
      }
      savedPath = reported;
      return await readFile(savedPath);
    } finally {
      // 清理失败不影响结果：文件本来就是要丢的
      for (const path of new Set([tmpPath, savedPath])) {
        if (path === null) continue;
        try {
          await rm(path, { force: true });
        } catch {
          // 见上
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    const child = this.consume;
    this.consume = null;
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    this.handler = null;
  }
}
