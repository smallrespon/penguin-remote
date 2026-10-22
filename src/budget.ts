// 预算装配的共享内核：超预算时从最中间整块丢分区，头尾均分（头部取 ceil）、保尾优先
// （至少保留头尾两个分区，最后一个分区永远不被整块丢弃）。
// 文本（render.ts 的 fitBudget）与卡片（card.ts 的 assemble）两侧同构，
// 差别只在「怎么算放得下」（拼接测长 vs JSON.stringify 测长）与「丢弃处长什么样」，
// 所以丢分区的循环在这里只写一遍：fits 由调用方给，dropMarker 给出丢弃处的占位块，
// 且占位块插在幸存头尾之间（不在队尾，否则「中间省略」的文案与位置矛盾）。
// 连头尾两个分区都放不下时返回 null，由调用方走各自的段内截断（capBlock / capSlots）。
// fitMiddleDropping 是所有分区同权的口径，文本路径在用；
// fitMiddleDroppingPreferred 多一个 isPreferred 谓词（ADR-0007：卡片超预算时思考面板
// 优先丢），没有 preferred 块时与前者逐字等价。

/**
 * 丢中间分区式的预算装配：保留的分区数从多到少试，头尾均分（头部取 ceil），
 * 第一个放得下的就是答案；整份放得下就原样返回。
 * 返回 null = 连头尾两个分区都放不下，调用方需自己做段内截断。
 */
export function fitMiddleDropping<T>(
  blocks: T[],
  fits: (candidate: T[]) => boolean,
  dropMarker: (dropped: number) => T,
): T[] | null {
  if (fits(blocks)) return blocks;
  for (let kept = blocks.length - 1; kept >= 2; kept -= 1) {
    const head = Math.ceil(kept / 2);
    const tail = kept - head;
    const candidate = [
      ...blocks.slice(0, head),
      dropMarker(blocks.length - kept),
      ...blocks.slice(blocks.length - tail),
    ];
    if (fits(candidate)) return candidate;
  }
  return null;
}

/**
 * 带优先级的丢分区（ADR-0007）：超预算时先丢 preferred 块，再丢其余；
 * 每一类内部都按「靠中间的优先」丢。保留的分区保持原有先后顺序，
 * 丢弃标注插在幸存头尾之间（与 fitMiddleDropping 同一形态）；
 * 没有 preferred 块时与 fitMiddleDropping 逐字等价。
 * 注意 preferred 优先于位置：首尾的思考面板也可能先于中间的正文被丢——
 * 这是「保答案丢思考」的刻意取舍（ADR-0007），保底是不丢最后两个分区。
 * 返回 null = 连头尾两个分区都放不下，调用方需自己做段内截断。
 */
export function fitMiddleDroppingPreferred<T>(
  blocks: T[],
  fits: (candidate: T[]) => boolean,
  dropMarker: (dropped: number) => T,
  isPreferred: (block: T) => boolean,
): T[] | null {
  if (fits(blocks)) return blocks;
  for (let dropped = 1; dropped <= blocks.length - 2; dropped += 1) {
    const dropSet = new Set(dropOrder(blocks, isPreferred).slice(0, dropped));
    const kept = blocks.filter((_, index) => !dropSet.has(index));
    const head = Math.ceil(kept.length / 2);
    const candidate = [...kept.slice(0, head), dropMarker(dropped), ...kept.slice(head)];
    if (fits(candidate)) return candidate;
  }
  return null;
}

/** 丢弃顺序：preferred 块优先；同一优先级里距最近边缘越远越先丢（同距时序号大的先丢）。 */
function dropOrder<T>(blocks: T[], isPreferred: (block: T) => boolean): number[] {
  const distanceToEdge = (index: number): number => Math.min(index, blocks.length - 1 - index);
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => {
      const preferredDiff = Number(isPreferred(b.block)) - Number(isPreferred(a.block));
      if (preferredDiff !== 0) return preferredDiff;
      return distanceToEdge(b.index) - distanceToEdge(a.index) || b.index - a.index;
    })
    .map((entry) => entry.index);
}
