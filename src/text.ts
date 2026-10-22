/** 正则字面量转义：把外部来的字符串安全地织进 RegExp 而不改变其字面含义。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
