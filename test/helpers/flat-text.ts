// 测试助手：把一条出站消息摊平成可做正则断言的文本。
// 文本消息原样返回；交互卡片（Card 2.0，ADR-0006）取 header 标题与 body 全部元素内容——
// markdown 取 content，折叠面板取其标题与面板内各元素 content，hr 给一个 "---" 占位。
// 卡片本身的结构断言不走这里，直接用 card.body.elements。

import type { OutboundMessage } from "../../src/channels/types.js";

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
