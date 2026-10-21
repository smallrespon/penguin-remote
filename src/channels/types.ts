// Channel 适配器接口：Bridge 与外部 IM 之间的唯一接触面。
// v1 唯一实现是 Feishu 适配器（channels/feishu.ts）；未来加其他平台不动内核。

export type ChatType = "p2p" | "group";

/** 一条解码后的入站消息。 */
export interface IncomingMessage {
  chatId: string;
  chatType: ChatType;
  messageId: string;
  senderId: string;
  /** 已剥离 @ 占位符、可读的文本。 */
  text: string;
}

/** Channel 适配器统一接口：收消息（onMessage）、发消息（send）、改消息（edit）。 */
export interface ChannelAdapter {
  /** 开始消费事件流；每条合规消息回调一次 handler。 */
  start(handler: (message: IncomingMessage) => void | Promise<void>): Promise<void>;
  /** 停止消费并清理子进程。 */
  stop(): Promise<void>;
  /** 发一条 markdown 消息，返回消息 id。 */
  send(chatId: string, markdown: string): Promise<string>;
  /** 改一条机器人自己发出的消息。 */
  edit(messageId: string, markdown: string): Promise<void>;
}
