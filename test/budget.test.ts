// budget.ts（fitMiddleDropping）单测：文本与卡片两侧共用的「丢中间分区」内核。
// 三个调用方关心的性质：整份放得下就原样返回、超预算丢中间且保尾优先、
// 连头尾两个分区都放不下时返回 null（由调用方走段内截断）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { fitMiddleDropping } from "../src/budget.js";

/** 5 个 10 字符的分区；拼接测长（与 render.ts 的口径一致，这里从简）。 */
const BLOCKS = ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc", "dddddddddd", "eeeeeeeeee"];

/** 丢弃处占位块：长度与省略数无关（固定 8 字符），方便手算预算。 */
const marker = (dropped: number): string => `[drop ${dropped}]`;

const fits = (max: number) => (candidate: string[]): boolean => candidate.join("").length <= max;

test("budget：整份放得下时原样返回，不做任何丢弃", () => {
  assert.deepEqual(fitMiddleDropping(BLOCKS, fits(50), marker), BLOCKS);
});

test("budget：超预算时从最中间整块丢弃，头尾均分（头部取 ceil）并标注省略数", () => {
  // 50 > 45：保留 4 个要 48 字符仍超；保留 3 个（头 2 尾 1）38 字符放得下
  const kept = fitMiddleDropping(BLOCKS, fits(45), marker);
  assert.deepEqual(kept, ["aaaaaaaaaa", "bbbbbbbbbb", "[drop 2]", "eeeeeeeeee"]);
});

test("budget：预算再紧也保尾优先——只保得住头尾时最后一个分区仍在", () => {
  // 保留 3 个要 38 > 28；保留 2 个（头 1 尾 1）恰好 28
  const kept = fitMiddleDropping(BLOCKS, fits(28), marker);
  assert.deepEqual(kept, ["aaaaaaaaaa", "[drop 3]", "eeeeeeeeee"]);
});

test("budget：连头尾两个分区都放不下时返回 null（调用方自行段内截断）", () => {
  // 保留 2 个要 28 > 27：没有候选放得下
  assert.equal(fitMiddleDropping(BLOCKS, fits(27), marker), null);
});
