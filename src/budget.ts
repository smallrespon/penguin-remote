// 预算装配的共享内核：超预算时优先从最中间整块丢分区，头尾均分、保尾优先。
// 文本（render.ts 的 fitBudget）与卡片（card.ts 的 fitBudget）两侧逐字同构，
// 差别只在「怎么算放得下」（拼接测长 vs JSON.stringify 测长）与「丢弃处长什么样」，
// 所以循环在这里只写一遍：fits 由调用方给，dropMarker 给出丢弃处的占位块。
// 连头尾两个分区都放不下时返回 null，由调用方走各自的段内截断（capBlock / capElements）。

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
