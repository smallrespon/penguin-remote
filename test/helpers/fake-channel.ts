import type { ChannelAdapter, IncomingMessage, OutboundMessage } from "../../src/channels/types.js";

import { textOf } from "./flat-text.js";

export interface SentMessage {
  chatId: string;
  message: OutboundMessage;
  /** send 返回的 message_id（后续 edit 打在它上面）。 */
  messageId: string;
}

export interface EditedMessage {
  messageId: string;
  message: OutboundMessage;
}

/** 测试用 Channel：记录 send/edit，可向 Bridge 灌入站消息。 */
export class FakeChannel implements ChannelAdapter {
  readonly sent: SentMessage[] = [];
  readonly edited: EditedMessage[] = [];
  private handler: ((message: IncomingMessage) => void | Promise<void>) | null = null;
  private nextId = 1;
  /** 每个 messageId 发出时的载体 kind：edit 时校验（平台不允许文本消息被 patch 成卡片，反之亦然）。 */
  private readonly kinds = new Map<string, OutboundMessage["kind"]>();
  /** 让这些 kind 的 send 抛出（模拟飞书发送失败）。 */
  failSendKinds: Array<"text" | "card"> = [];
  /** 让这些 kind 的 edit 抛出（模拟飞书编辑频率限制）。 */
  failEditKinds: Array<"text" | "card"> = [];
  /** 单条消息允许的编辑次数上限（模拟飞书 230072）；null = 不限。 */
  editLimitPerMessage: number | null = null;
  private readonly editCounts = new Map<string, number>();

  async start(handler: (message: IncomingMessage) => void | Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async send(chatId: string, message: OutboundMessage): Promise<string> {
    if (this.failSendKinds.includes(message.kind)) {
      throw new Error(`FakeChannel: send(${message.kind}) failed`);
    }
    const messageId = `om_fake_${this.nextId++}`;
    this.kinds.set(messageId, message.kind);
    this.sent.push({ chatId, message, messageId });
    return messageId;
  }

  async edit(messageId: string, message: OutboundMessage): Promise<void> {
    // 模拟平台的载体约束：文本消息只能用 markdown 编辑，卡片消息只能 patch，
    // 载体不匹配一律失败——测试替身不校验的话，「文本 edit 打在卡片上」这类 bug 会漏过去。
    const kind = this.kinds.get(messageId);
    if (kind !== undefined && kind !== message.kind) {
      throw new Error(`cannot edit a ${kind} message with a ${message.kind} (${messageId})`);
    }
    if (this.failEditKinds.includes(message.kind)) {
      throw new Error(`FakeChannel: edit(${message.kind}) failed`);
    }
    const count = (this.editCounts.get(messageId) ?? 0) + 1;
    this.editCounts.set(messageId, count);
    if (this.editLimitPerMessage !== null && count > this.editLimitPerMessage) {
      throw new Error(`The message has reached the number of times it can be edited. (${messageId})`);
    }
    this.edited.push({ messageId, message });
  }

  /** 模拟收到一条飞书消息。 */
  async receive(text: string, overrides: Partial<IncomingMessage> = {}): Promise<void> {
    const message: IncomingMessage = {
      chatId: "oc_chat",
      chatType: "p2p",
      messageId: `om_in_${this.sent.length + this.edited.length + 1}`,
      senderId: "ou_user",
      text,
      ...overrides,
    };
    await this.handler?.(message);
  }

  lastSent(): string {
    const last = this.sent.at(-1);
    return last === undefined ? "" : textOf(last.message);
  }
}
