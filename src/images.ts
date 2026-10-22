// 图片字节 → data URL 的纯函数（ADR-0009）：按魔数嗅探 mime、拼 base64 data URL、判 20MB 上限。
// 无 IO、无副作用；Channel 层下载到字节后由这里决定「投递还是跳过」。

/** 服务端 inline 图片上限（ADR-0009）：超过的图片跳过，不让整个任务失败。 */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** 图片处置结论：ok 带 data URL，skip 带给用户说明的理由。 */
export type ImageDecision = { kind: "ok"; dataUrl: string } | { kind: "skip"; note: string };

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
  if (mime === null) return { kind: "skip", note: "有图片格式无法识别，未发送" };
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return { kind: "skip", note: `有图片超过 ${MAX_INLINE_IMAGE_BYTES / 1024 / 1024}MB 上限，未发送` };
  }
  return { kind: "ok", dataUrl: toDataUrl(bytes, mime) };
}
