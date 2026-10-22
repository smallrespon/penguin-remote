// 测试助手：交互卡片（Card 2.0，ADR-0006）的结构断言小工具。
// card.test.ts（卡片构建单测）与 runner.test.ts（链路集成测试）共用——
// 两边断言的是同一批卡片结构，写法必须一致，否则「测试绿了」不等于「结构对了」。
// 摊平文本（flatText）在 flat-text.ts，这里再导出方便一站式 import。

import type { OutboundMessage } from "../../src/channels/types.js";
import type { CollapsiblePanelElement, RunCard } from "../../src/card.js";

export { flatText } from "./flat-text.js";

/** 断言这条消息是卡片并取出卡身（窄化小工具，断言失败即测试失败）。 */
export function cardOf(message: OutboundMessage): RunCard {
  if (message.kind !== "card") {
    throw new Error(`期望一条卡片消息，实际是 ${message.kind}`);
  }
  return message.card;
}

/** 取出指定下标的 markdown 元素（正文 / 思考标签 / 页脚断言用）。 */
export function markdownAt(card: RunCard, index: number): string {
  const element = card.body.elements[index];
  if (element?.tag !== "markdown") {
    throw new Error(`第 ${index} 个元素不是 markdown：${JSON.stringify(element)}`);
  }
  return element.content;
}

/** 页脚：body 最后一个元素那行小字（hr 之后的用量 / 失败原因行；不是 markdown 时给空串）。 */
export function footerOf(card: RunCard): string {
  const last = card.body.elements.at(-1);
  return last !== undefined && last.tag === "markdown" ? last.content : "";
}

/** 卡片里的全部折叠面板（工具调用的载体），按出现顺序。 */
export function panelsOf(card: RunCard): CollapsiblePanelElement[] {
  return card.body.elements.filter(
    (element): element is CollapsiblePanelElement => element.tag === "collapsible_panel",
  );
}

/** 取出第 index 个折叠面板（默认第 0 个）。 */
export function panelAt(card: RunCard, index = 0): CollapsiblePanelElement {
  const panel = panelsOf(card)[index];
  if (panel === undefined) throw new Error(`第 ${index} 个折叠面板不存在，共 ${panelsOf(card).length} 个`);
  return panel;
}

/** body.elements 里是否已有 content 等于 text 的 markdown 元素。 */
export function hasText(card: RunCard, text: string): boolean {
  return card.body.elements.some((element) => element.tag === "markdown" && element.content === text);
}
