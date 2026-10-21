import type { ChannelAdapter, IncomingMessage } from "../../src/channels/types.js";

export interface SentMessage {
  chatId: string;
  markdown: string;
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
  /** 让 send 抛出（模拟飞书编辑/发送频率限制）。 */
  failSendWith: Error | null = null;

  async start(handler: (message: IncomingMessage) => void | Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }

  async send(chatId: string, markdown: string): Promise<string> {
    if (this.failSendWith !== null) throw this.failSendWith;
    this.sent.push({ chatId, markdown });
    return `om_fake_${this.nextId++}`;
  }

  async edit(messageId: string, markdown: string): Promise<void> {
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
