import assert from "node:assert/strict";
import { test } from "node:test";

import { imageDataUrlOrNote, MAX_INLINE_IMAGE_BYTES, sniffMimeType, toDataUrl } from "../src/images.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const GIF87A = Buffer.from("GIF87a 你好", "latin1");
const GIF89A = Buffer.from("GIF89a 你好", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0x10, 0x00, 0x00]), Buffer.from("WEBPVP8 ")]);

test("sniffMimeType：四种魔数各归其位", () => {
  assert.equal(sniffMimeType(JPEG), "image/jpeg");
  assert.equal(sniffMimeType(PNG), "image/png");
  assert.equal(sniffMimeType(GIF87A), "image/gif");
  assert.equal(sniffMimeType(GIF89A), "image/gif");
  assert.equal(sniffMimeType(WEBP), "image/webp");
});

test("sniffMimeType：未知格式与过短输入返回 null", () => {
  assert.equal(sniffMimeType(Buffer.from([0x00, 0x01, 0x02, 0x03])), null);
  assert.equal(sniffMimeType(Buffer.from("hello world")), null);
  assert.equal(sniffMimeType(Buffer.alloc(0)), null);
  // 只差一个字节的 RIFF 头不算 WebP
  assert.equal(sniffMimeType(Buffer.from("RIFF")), null);
  // RIFF 容器但第 9-12 字节不是 WEBP
  assert.equal(sniffMimeType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI ")])), null);
});

test("toDataUrl：拼 data:<mime>;base64,...", () => {
  assert.equal(toDataUrl(Buffer.from("hi"), "image/png"), "data:image/png;base64,aGk=");
  assert.equal(toDataUrl(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"), "data:image/jpeg;base64,/9j/");
});

test("imageDataUrlOrNote：正常图片拼成 data URL", () => {
  const decision = imageDataUrlOrNote(PNG);
  assert.equal(decision.kind, "ok");
  if (decision.kind !== "ok") throw new Error("预期放行");
  assert.ok(decision.dataUrl.startsWith("data:image/png;base64,"));
  assert.equal(decision.dataUrl, toDataUrl(PNG, "image/png"));
});

test("imageDataUrlOrNote：嗅探不出 mime 的跳过并注明", () => {
  assert.deepEqual(imageDataUrlOrNote(Buffer.from([0x00, 0x01, 0x02, 0x03])), {
    kind: "skip",
    note: "有图片格式无法识别，未发送",
  });
});

test("imageDataUrlOrNote：20MB 边界——刚好等于上限放行，超 1 字节拒绝", () => {
  assert.equal(MAX_INLINE_IMAGE_BYTES, 20 * 1024 * 1024);

  const atLimit = Buffer.concat([JPEG, Buffer.alloc(MAX_INLINE_IMAGE_BYTES - JPEG.length)]);
  assert.equal(atLimit.byteLength, MAX_INLINE_IMAGE_BYTES);
  const allowed = imageDataUrlOrNote(atLimit);
  assert.equal(allowed.kind, "ok");
  if (allowed.kind !== "ok") throw new Error("刚好等于上限应放行");
  assert.ok(allowed.dataUrl.startsWith("data:image/jpeg;base64,"));

  const overLimit = Buffer.concat([JPEG, Buffer.alloc(MAX_INLINE_IMAGE_BYTES - JPEG.length + 1)]);
  assert.equal(overLimit.byteLength, MAX_INLINE_IMAGE_BYTES + 1);
  assert.deepEqual(imageDataUrlOrNote(overLimit), { kind: "skip", note: "有图片超过 20MB 上限，未发送" });
});
