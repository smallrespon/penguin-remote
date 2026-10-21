import type { ChannelAdapter, IncomingMessage } from "../../src/channels/types.js";

export interface SentMessage {
  chatId: string;
  markdown: string;
  /** send 返回的 message_id（后续 edit 打在它上面）。 */
  messageId: string;
}

export interface EditedMessage {
  messageId: string;
  markdown: string;
}

/** 测试用 Channel：记录 send/edit，可向 Bridge 灌入站消息。 */
export class FakeChannel implements ChannelAdapter {
  readonly sent: SentMessage[] = [];
  readonly edited: EditedMessage[] = [];
  private handler: ((message: IncomingMessage) => void | Promise<void>) | null = null;
  private nextId = 1;
  /** 让 send 抛出（模拟飞书发送失败）。 */
  failSendWith: Error | null = null;
  /** 让 edit 抛出（模拟飞书编辑频率限制）。 */
  failEditWith: Error | null = null;
  /** 单条消息允许的编辑次数上限（模拟飞书 230072）；null = 不限。 */
  editLimitPerMessage: number | null = null;
  private readonly editCounts = new Map<string, number>();

  async start(handler: (message: IncomingMessage) => void | Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async send(chatId: string, markdown: string): Promise<string> {
    if (this.failSendWith !== null) throw this.failSendWith;
    const messageId = `om_fake_${this.nextId++}`;
    this.sent.push({ chatId, markdown, messageId });
    return messageId;
  }

  async edit(messageId: string, markdown: string): Promise<void> {
    if (this.failEditWith !== null) throw this.failEditWith;
    const count = (this.editCounts.get(messageId) ?? 0) + 1;
    this.editCounts.set(messageId, count);
    if (this.editLimitPerMessage !== null && count > this.editLimitPerMessage) {
      throw new Error(`The message has reached the number of times it can be edited. (${messageId})`);
    }
    this.edited.push({ messageId, markdown });
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
    return this.sent.at(-1)?.markdown ?? "";
  }
}
