// Channel 适配器接口：Bridge 与外部 IM 之间的唯一接触面。
// v1 唯一实现是 Feishu 适配器（channels/feishu.ts）；未来加其他平台不动内核。

import type { RunCard } from "../card.js";

export type ChatType = "p2p" | "group";

/** 一条解码后的入站消息。 */
export interface IncomingMessage {
  chatId: string;
  chatType: ChatType;
  messageId: string;
  senderId: string;
  /** 已剥离 @ 占位符与图片占位符、可读的文本；纯图片消息为空串。 */
  text: string;
  /** 消息里的图片 key 列表（`![Image](img_key)` 提取而来）；无图片为 []。 */
  images: string[];
}

/** 一条出站消息：纯文本，或一张交互卡片（Card 2.0）。 */
export type OutboundMessage = { kind: "text"; text: string } | { kind: "card"; card: RunCard };

/** Channel 适配器统一接口：收消息（onMessage）、发消息（send）、改消息（edit）。 */
export interface ChannelAdapter {
  /** 开始消费事件流；每条合规消息回调一次 handler。 */
  start(handler: (message: IncomingMessage) => void | Promise<void>): Promise<void>;
  /** 停止消费并清理子进程。 */
  stop(): Promise<void>;
  /** 发一条消息（文本或交互卡片），返回消息 id。 */
  send(chatId: string, message: OutboundMessage): Promise<string>;
  /** 改一条机器人自己发出的消息（文本或交互卡片）。 */
  edit(messageId: string, message: OutboundMessage): Promise<void>;
  /** 下载一条入站消息里的图片二进制（按 messageId + 图片 key）。 */
  downloadImage(messageId: string, fileKey: string): Promise<Buffer>;
}
