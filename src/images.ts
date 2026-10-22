// 图片相关纯函数（ADR-0009）：预渲染文本里的图片占位符解析 + 图片字节 → data URL
// （魔数嗅探 mime、拼 base64、判 20MB 上限）。无 IO、无副作用；占位符语法是
// GLOSSARY 的领域概念，正则以此处为单一出处（channels/feishu.ts 与 gateway.ts 都导入）。

/** 服务端 inline 图片上限（ADR-0009）：超过的图片跳过，不让整个任务失败。 */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** 图片处置结论：ok 带 data URL，skip 带给用户说明的理由。 */
export type ImageDecision = { kind: "ok"; dataUrl: string } | { kind: "skip"; note: string };

/**
 * lark-cli 预渲染文本里的图片占位符：`![Image](img_v3_xxx)`（前导 `!` 可有可无）。
 * 事件流与各读命令共用同一内容格式化器，图片一律渲染成这个形状（见 GLOSSARY「图片占位符」）。
 */
export const IMAGE_PLACEHOLDER = /!?\[Image\]\(([^)\s]+)\)/g;

/**
 * 从预渲染文本提取图片 key（`![Image](img_xxx)`），并把占位符替换为空格后返回新文本。
 * 先提取再剥离 @：key 取自原文，mention 的剥离逻辑与顺序都不变。
 */
export function extractImageKeys(text: string): { keys: string[]; text: string } {
  const keys: string[] = [];
  const stripped = text.replace(IMAGE_PLACEHOLDER, (_match: string, key: string) => {
    keys.push(key);
    return " ";
  });
  return { keys, text: stripped };
}

/** 移除文本中的图片占位符（标题清洗用；key 已在解码时提取过，这里只清文本）。 */
export function stripImagePlaceholders(text: string): string {
  return text.replace(IMAGE_PLACEHOLDER, " ");
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** 判断 offset 起的若干字节是否等于给定 ASCII 串。 */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** 按文件头魔数猜 mime；认不出返回 null（调用方按「跳过并注明」处理）。 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  // JPEG：SOI 标记 + 紧随的段头（FF D8 FF）。
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // PNG：8 字节签名。
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  // WebP：RIFF 容器，字节 8-11 是 "WEBP"。
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  return null;
}

/** 拼 `data:<mime>;base64,<base64>`；不复制字节（直接按 view 读）。 */
export function toDataUrl(bytes: Uint8Array, mime: string): string {
  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return `data:${mime};base64,${base64}`;
}

/**
 * 一段图片字节的处置结论：嗅探失败或超 20MB 上限 → skip（附给用户的说明），否则 ok（data URL）。
 */
export function imageDataUrlOrNote(bytes: Uint8Array): ImageDecision {
  const mime = sniffMimeType(bytes);
  if (mime === null) return { kind: "skip", note: "（有图片格式无法识别，未发送）" };
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return { kind: "skip", note: `（有图片超过 ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024}MB 上限，未发送）` };
  }
  return { kind: "ok", dataUrl: toDataUrl(bytes, mime) };
}
