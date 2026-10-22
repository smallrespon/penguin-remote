// 测试助手：把出站消息（文本 / 交互卡片）转成可做正则断言的文本形态。
// textOf 只取纯文本（卡片给空串），flatText 把整张卡片摊平；两者配合覆盖两类载体的断言。

import type { OutboundMessage } from "../../src/channels/types.js";

/** 取出站消息的纯文本：文本消息取 text；卡片没有可断言文本，返回空串。 */
export function textOf(message: OutboundMessage): string {
  return message.kind === "text" ? message.text : "";
}

/** 测试助手：把一条出站消息摊平成可做正则断言的文本。
 * 文本消息原样返回；交互卡片（Card 2.0，ADR-0006）取 header 标题与 body 全部元素内容——
 * markdown 取 content，折叠面板取其标题与面板内各元素 content，hr 给一个 "---" 占位。
 * 卡片本身的结构断言不走这里，直接用 card.body.elements（见 card-shape.ts）。
 */
export function flatText(message: OutboundMessage): string {
  if (message.kind === "text") return message.text;
  const chunks: string[] = [message.card.header.title.content];
  for (const element of message.card.body.elements) {
    if (element.tag === "markdown") chunks.push(element.content);
    else if (element.tag === "hr") chunks.push("---");
    else chunks.push(element.header.title.content, ...element.elements.map((item) => item.content));
  }
  return chunks.join("\n\n");
}
