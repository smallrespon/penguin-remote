// 测试助手：把出站消息（文本 / 交互卡片）转成可做正则断言的文本形态。
// textOf 只取纯文本（卡片给空串），flatText 把整张卡片摊平；两者配合覆盖两类载体的断言。

import type { OutboundMessage } from "../../src/channels/types.js";
import type { CardElement } from "../../src/card.js";

/** 取出站消息的纯文本：文本消息取 text；卡片没有可断言文本，返回空串。 */
export function textOf(message: OutboundMessage): string {
  return message.kind === "text" ? message.text : "";
}

/** 测试助手：把一条出站消息摊平成可做正则断言的文本。
 * 文本消息原样返回；交互卡片（Card 2.0）取 header 标题与 body 全部元素内容——
 * markdown 取 content，hr 给一个 "---" 占位，折叠面板递归展开（标题 + 面板内各元素，
 * 嵌套面板同理：分组面板里套着每步的小面板，不递归就会漏掉步标题、甚至读出 undefined）。
 * 卡片本身的结构断言不走这里，直接用 card.body.elements（见 card-shape.ts）。
 */
export function flatText(message: OutboundMessage): string {
  if (message.kind === "text") return message.text;
  // 文件消息（ADR-0012）没有卡片结构也没有正文，摊不出可断言的文本
  if (message.kind === "file") return "";
  const chunks: string[] = [message.card.header.title.content];
  for (const element of message.card.body.elements) chunks.push(...flatElement(element));
  return chunks.join("\n\n");
}

/** 摊平一个元素：折叠面板递归展开（标题 + 子元素），markdown 取 content，hr 给 "---" 占位。 */
function flatElement(element: CardElement): string[] {
  if (element.tag === "markdown") return [element.content];
  if (element.tag === "hr") return ["---"];
  return [element.header.title.content, ...element.elements.flatMap(flatElement)];
}
