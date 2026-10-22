import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { decodeMessageEvent, FeishuChannel, stripMentions } from "../src/channels/feishu.js";
import { placeholderCard } from "../src/card.js";
import { createLogger } from "../src/logger.js";
import type { RunResult } from "../src/proc.js";
import { FakeChild, makeFakeRun, makeFakeSpawn } from "./helpers/fake-child.js";
import { waitFor } from "./helpers/wait.js";

const BOT = "ou_bot";
const silentLogger = createLogger("error", () => {});

function p2pEvent(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "im.message.receive_v1",
    chat_id: "oc_chat",
    chat_type: "p2p",
    message_id: "om_msg",
    message_type: "text",
    sender_id: "ou_user",
    sender_type: "user",
    content: text,
    ...extra,
  };
}

test("decodeMessageEvent：私聊文本解码为统一消息", () => {
  const message = decodeMessageEvent(p2pEvent("现在几点"), BOT);
  assert.deepEqual(message, {
    chatId: "oc_chat",
    chatType: "p2p",
    messageId: "om_msg",
    senderId: "ou_user",
    text: "现在几点",
    images: [],
  });
});

test("decodeMessageEvent：群聊未被 @ 时不响应", () => {
  const event = p2pEvent("大家早上好", {
    chat_type: "group",
    mentions: [{ id: "ou_other", key: "@_user_1", name: "同事" }],
  });
  assert.equal(decodeMessageEvent(event, BOT), null);
});

test("decodeMessageEvent：群聊被 @ 时剥离占位符", () => {
  const event = p2pEvent("@_user_1 帮我看下这个", {
    chat_type: "group",
    mentions: [{ id: BOT, key: "@_user_1", name: "penguin" }],
  });
  const message = decodeMessageEvent(event, BOT);
  assert.equal(message?.text, "帮我看下这个");
  assert.equal(message?.chatType, "group");
});

test("decodeMessageEvent：机器人自己发的、文件/音视频类、空文本、坏结构都被忽略", () => {
  assert.equal(decodeMessageEvent(p2pEvent("hi", { sender_type: "bot" }), BOT), null);
  assert.equal(decodeMessageEvent(p2pEvent("[文件]", { message_type: "file" }), BOT), null);
  assert.equal(decodeMessageEvent(p2pEvent("[音频]", { message_type: "audio" }), BOT), null);
  assert.equal(decodeMessageEvent(p2pEvent("[视频]", { message_type: "video" }), BOT), null);
  assert.equal(decodeMessageEvent(p2pEvent("[表情]", { message_type: "sticker" }), BOT), null);
  assert.equal(decodeMessageEvent(p2pEvent("@_user_1"), BOT), null);
  assert.equal(decodeMessageEvent(null, BOT), null);
  assert.equal(decodeMessageEvent({ type: "im.chat.updated_v1" }, BOT), null);
});

test("stripMentions 压缩空白", () => {
  assert.equal(stripMentions("@_user_1  @_user_2   你好"), "你好");
});

test("stripMentions 同时处理占位符与已渲染的显示名", () => {
  assert.equal(stripMentions("penguin-remote 帮我看下", ["penguin-remote"]), "帮我看下");
  assert.equal(stripMentions("@penguin-remote 帮我看下", ["penguin-remote"]), "帮我看下");
  // 句中不带 @ 的同名文本不是 mention，保留
  assert.equal(stripMentions("请把 penguin-remote 的配置改一下", ["penguin-remote"]), "请把 penguin-remote 的配置改一下");
});

test("decodeMessageEvent：content 为 JSON 原文时取出 text；群聊显示名 @ 也剥离", () => {
  const jsonContent = decodeMessageEvent(p2pEvent(JSON.stringify({ text: "现在几点" })), BOT);
  assert.equal(jsonContent?.text, "现在几点");

  const rendered = decodeMessageEvent(
    p2pEvent("penguin-remote 帮我看下这个", {
      chat_type: "group",
      mentions: [{ id: BOT, key: "@_user_1", name: "penguin-remote" }],
    }),
    BOT,
  );
  assert.equal(rendered?.text, "帮我看下这个");
});

function makeChannel(
  spawn = makeFakeSpawn().spawn,
  run: (bin: string, args: string[], opts?: { input?: string }) => Promise<RunResult> = makeFakeRun([]).run,
): FeishuChannel {
  return new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn,
    resolveBotOpenId: async () => BOT,
    run,
  });
}

/** 记录型假 run：连 stdin 一起记，按 args 谓词匹配 canned 响应（断言卡片 payload 用）。 */
function makeRecordingRun(
  handlers: Array<{ match: (args: string[]) => boolean; result: RunResult | Error }>,
): {
  run: (bin: string, args: string[], opts?: { input?: string }) => Promise<RunResult>;
  calls: Array<{ args: string[]; input: string }>;
} {
  const calls: Array<{ args: string[]; input: string }> = [];
  const run = (bin: string, args: string[], opts?: { input?: string }) => {
    calls.push({ args, input: opts?.input ?? "" });
    const handler = handlers.find((h) => h.match(args));
    if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${args.join(" ")}`));
    if (handler.result instanceof Error) return Promise.reject(handler.result);
    return Promise.resolve(handler.result);
  };
  return { run, calls };
}

test("FeishuChannel.start 拉取机器人身份并启动事件流，事件流消息进 handler", async () => {
  const fake = makeFakeSpawn();
  const channel = makeChannel(fake.spawn);
  const received: string[] = [];
  await channel.start(async (message) => {
    received.push(`${message.chatType}:${message.text}`);
  });

  assert.deepEqual(fake.calls, [
    { bin: "lark-cli", args: ["event", "consume", "im.message.receive_v1", "--as", "bot"] },
  ]);

  const child = fake.children[0];
  assert.ok(child !== undefined);
  child.emitEvent(p2pEvent("第一句话"));
  child.emitEvent(p2pEvent("@_user_1 第二句话", { chat_type: "group" }));
  child.emitEvent({ type: "im.chat.updated_v1" });
  child.emitRaw("not json");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(received, ["p2p:第一句话"]);
  await channel.stop();
  assert.equal(child.killedWith, "SIGTERM");
});

test("FeishuChannel.send 返回 message_id，失败时抛出带原因的错误", async () => {
  const ok = makeFakeRun([
    {
      match: (args) => args[1] === "+messages-send",
      result: { status: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_reply" } }), stderr: "" },
    },
  ]);
  const channel = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => BOT,
    run: ok.run,
  });
  assert.equal(await channel.send("oc_chat", { kind: "text", text: "你好" }), "om_reply");
  assert.deepEqual(ok.calls[0]?.slice(0, 3), ["im", "+messages-send", "--as"]);

  const failing = makeFakeRun([
    {
      match: (args) => args[1] === "+messages-send",
      result: { status: 1, stdout: JSON.stringify({ ok: false, error: { message: "bot not in chat" } }), stderr: "" },
    },
  ]);
  const channel2 = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => BOT,
    run: failing.run,
  });
  await assert.rejects(() => channel2.send("oc_chat", { kind: "text", text: "你好" }), /bot not in chat/);
});

test("FeishuChannel.edit 按 messageId 改消息", async () => {
  const edit = makeFakeRun([
    {
      match: (args) => args[1] === "+messages-edit",
      result: { status: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" },
    },
  ]);
  const channel = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => BOT,
    run: edit.run,
  });
  await channel.edit("om_reply", { kind: "text", text: "更新后的内容" });
  assert.deepEqual(edit.calls[0], [
    "im",
    "+messages-edit",
    "--as",
    "bot",
    "--message-id",
    "om_reply",
    "--markdown",
    "-",
  ]);
});

test("FeishuChannel.send 卡片：走 interactive 消息，stdin 是卡片 JSON", async () => {
  const card = placeholderCard();
  const fake = makeRecordingRun([
    {
      match: (args) => args[1] === "+messages-send",
      result: { status: 0, stdout: JSON.stringify({ ok: true, data: { message_id: "om_card" } }), stderr: "" },
    },
  ]);
  const channel = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => BOT,
    run: fake.run,
  });

  assert.equal(await channel.send("oc_chat", { kind: "card", card }), "om_card");
  assert.deepEqual(fake.calls[0]?.args, [
    "im",
    "+messages-send",
    "--as",
    "bot",
    "--chat-id",
    "oc_chat",
    "--msg-type",
    "interactive",
    "--content",
    "-",
  ]);
  assert.equal(fake.calls[0]?.input, JSON.stringify(card));
});

test("FeishuChannel.edit 卡片：走 im messages patch，stdin 是双层转义的 content", async () => {
  const card = placeholderCard();
  const fake = makeRecordingRun([
    {
      match: (args) => args[1] === "messages",
      result: { status: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" },
    },
  ]);
  const channel = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => BOT,
    run: fake.run,
  });

  await channel.edit("om_card", { kind: "card", card });
  assert.deepEqual(fake.calls[0]?.args, [
    "im",
    "messages",
    "patch",
    "--as",
    "bot",
    "--message-id",
    "om_card",
    "--data",
    "-",
  ]);
  // patch 的 content 是 JSON 序列化后的字符串：外层对象再包一层。
  assert.equal(fake.calls[0]?.input, JSON.stringify({ content: JSON.stringify(card) }));
});

test("FeishuChannel 卡片发送/更新失败：错误能区分卡片路径并带原因", async () => {
  const card = placeholderCard();
  const failing = makeRecordingRun([
    {
      match: (args) => args[1] === "+messages-send",
      result: { status: 1, stdout: JSON.stringify({ ok: false, error: { message: "card too large" } }), stderr: "" },
    },
    {
      match: (args) => args[1] === "messages",
      result: { status: 1, stdout: JSON.stringify({ ok: false, error: { message: "message not found" } }), stderr: "" },
    },
  ]);
  const channel = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => BOT,
    run: failing.run,
  });

  await assert.rejects(
    () => channel.send("oc_chat", { kind: "card", card }),
    /发送卡片消息失败（lark-cli exit=1）：card too large/,
  );
  await assert.rejects(
    () => channel.edit("om_card", { kind: "card", card }),
    /更新卡片消息失败（lark-cli exit=1）：message not found/,
  );
});

test("FeishuChannel 拿不到机器人身份时 start 失败（fail-fast）", async () => {
  const channel = new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn: makeFakeSpawn().spawn,
    resolveBotOpenId: async () => {
      throw new Error("lark-cli 未返回机器人 open_id");
    },
    run: makeFakeRun([]).run,
  });
  await assert.rejects(() => channel.start(() => {}), /open_id/);
});

// ---- T9：事件流子进程守护 ----

test("事件流子进程崩溃后自动重启，消息继续进 handler", async () => {
  const fake = makeFakeSpawn();
  const channel = makeChannel(fake.spawn);
  const received: string[] = [];
  await channel.start(async (message) => {
    received.push(message.text);
  });
  assert.equal(fake.children.length, 1);

  // 崩溃：等守护按退避（1s 起）重新拉起
  fake.children[0]!.exit(1);
  await waitFor(() => fake.children.length === 2);

  fake.children[1]!.emitEvent(p2pEvent("崩溃后收到的消息"));
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, ["崩溃后收到的消息"]);

  await channel.stop();
  assert.equal(fake.children[1]?.killedWith, "SIGTERM");
});

test("stop 之后子进程退出不再重启", async () => {
  const fake = makeFakeSpawn();
  const channel = makeChannel(fake.spawn);
  await channel.start(() => {});
  await channel.stop();

  fake.children[0]!.exit(1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.children.length, 1, "stop 后不应再拉起子进程");
});

// ---- T11：图片入站（占位符提取 + downloadImage） ----

test("decodeMessageEvent：单张图片——message_type=image，[Image: key] 占位符被提成 key、文本为空仍是合法消息", () => {
  // 真机实测（2026-10-22）：纯图片消息的预渲染形状是 `[Image: img_key]`，不是 `![Image](key)`
  const message = decodeMessageEvent(p2pEvent("[Image: img_v3_0216n_94fbcfec-1892-4410-b5c8-c94d638071cg]", { message_type: "image" }), BOT);
  assert.deepEqual(message, {
    chatId: "oc_chat",
    chatType: "p2p",
    messageId: "om_msg",
    senderId: "ou_user",
    text: "",
    images: ["img_v3_0216n_94fbcfec-1892-4410-b5c8-c94d638071cg"],
  });
});

test("decodeMessageEvent：富文本内嵌图片——![Image](key) 形状（2026-10-22 真机实测）", () => {
  const message = decodeMessageEvent(
    p2pEvent("![Image](img_v3_0216n_e3a290a7-6605-482d-a377-8d5a767dabag)\n这种类似的问题有很多解决一下", {
      message_type: "post",
    }),
    BOT,
  );
  assert.deepEqual(message?.images, ["img_v3_0216n_e3a290a7-6605-482d-a377-8d5a767dabag"]);
  assert.equal(message?.text, "这种类似的问题有很多解决一下");
});

test("decodeMessageEvent：多张图片——key 按出现顺序全部提取", () => {
  const message = decodeMessageEvent(
    p2pEvent("![Image](img_v3_a)\n![Image](img_v3_b)\n![Image](img_v3_c)", { message_type: "post" }),
    BOT,
  );
  assert.deepEqual(message?.images, ["img_v3_a", "img_v3_b", "img_v3_c"]);
  assert.equal(message?.text, "");
});

test("decodeMessageEvent：图片 + 文字——占位符从文本中移除，文字留下", () => {
  const message = decodeMessageEvent(p2pEvent("帮我看下 ![Image](img_v3_x) 这道题", { message_type: "post" }), BOT);
  assert.equal(message?.text, "帮我看下 这道题");
  assert.deepEqual(message?.images, ["img_v3_x"]);
});

test("decodeMessageEvent：图片与 @ 同时出现——mention 行为不变，图片 key 照样提取", () => {
  const message = decodeMessageEvent(
    p2pEvent("@_user_1 帮我看下 ![Image](img_v3_x)", {
      chat_type: "group",
      mentions: [{ id: BOT, key: "@_user_1", name: "penguin-remote" }],
    }),
    BOT,
  );
  assert.equal(message?.text, "帮我看下");
  assert.deepEqual(message?.images, ["img_v3_x"]);
  assert.equal(message?.chatType, "group");
});

test("decodeMessageEvent：content 为 JSON 原文时同样提取图片 key", () => {
  const message = decodeMessageEvent(
    p2pEvent(JSON.stringify({ text: "看这张 ![Image](img_v3_json)" }), { message_type: "post" }),
    BOT,
  );
  assert.equal(message?.text, "看这张");
  assert.deepEqual(message?.images, ["img_v3_json"]);
});

test("decodeMessageEvent：没有图片的消息 images 为空数组", () => {
  assert.deepEqual(decodeMessageEvent(p2pEvent("现在几点"), BOT)?.images, []);
  // 不是 `![Image](key)` 形状的标记不算图片占位符：文本原样留下，images 为空
  const notPlaceholder = decodeMessageEvent(p2pEvent("帮我看下 ![图片](img_v3_x)", { message_type: "post" }), BOT);
  assert.deepEqual(notPlaceholder?.images, []);
  assert.equal(notPlaceholder?.text, "帮我看下 ![图片](img_v3_x)");
});

/** 假 lark-cli：把图片字节落到 `--output` 指向的路径，再返回带 saved_path 的信封。 */
function makeFakeDownload(
  options: { bytes?: Buffer; result?: RunResult | Error } = {},
): {
  run: (bin: string, args: string[], opts?: { input?: string }) => Promise<RunResult>;
  calls: string[][];
  outputOf: () => string | undefined;
} {
  const calls: string[][] = [];
  const run = async (_bin: string, args: string[], _opts?: { input?: string }): Promise<RunResult> => {
    calls.push(args);
    const flagIndex = args.indexOf("--output");
    const output = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
    if (options.bytes !== undefined && output !== undefined) {
      await writeFile(output, options.bytes);
    }
    if (options.result instanceof Error) throw options.result;
    if (options.result !== undefined) return options.result;
    return { status: 0, stdout: JSON.stringify({ ok: true, data: { saved_path: output } }), stderr: "" };
  };
  return { run, calls, outputOf: () => (calls[0] !== undefined ? calls[0][calls[0].indexOf("--output") + 1] : undefined) };
}

test("FeishuChannel.downloadImage：跑下载命令、读回字节、删掉临时文件", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const fake = makeFakeDownload({ bytes });
  const channel = makeChannel(makeFakeSpawn().spawn, fake.run);

  assert.deepEqual(await channel.downloadImage("om_msg", "img_v3_x"), bytes);
  assert.deepEqual(fake.calls[0], [
    "im",
    "+messages-resources-download",
    "--as",
    "bot",
    "--message-id",
    "om_msg",
    "--file-key",
    "img_v3_x",
    "--type",
    "image",
    "--output",
    fake.outputOf(),
  ]);

  const output = fake.outputOf();
  assert.ok(output !== undefined);
  assert.ok(output.startsWith(tmpdir() + "/"), "临时文件必须落在 os.tmpdir() 下");
  assert.equal(existsSync(output), false, "成功后临时文件应被删除");
});

test("FeishuChannel.downloadImage：lark-cli 非 0 退出时抛错，临时文件仍被清理", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
  const fake = makeFakeDownload({
    bytes,
    result: { status: 4, stdout: JSON.stringify({ ok: false, error: { message: "image not found" } }), stderr: "" },
  });
  const channel = makeChannel(makeFakeSpawn().spawn, fake.run);

  await assert.rejects(() => channel.downloadImage("om_msg", "img_gone"), /下载图片失败（lark-cli exit=4）：image not found/);
  const output = fake.outputOf();
  assert.ok(output !== undefined);
  assert.equal(existsSync(output), false, "失败后临时文件也应被删除");
});

test("FeishuChannel.downloadImage：信封 ok 但没有 saved_path 时抛错", async () => {
  const fake = makeFakeDownload({
    result: { status: 0, stdout: JSON.stringify({ ok: true, data: {} }), stderr: "" },
  });
  const channel = makeChannel(makeFakeSpawn().spawn, fake.run);
  await assert.rejects(() => channel.downloadImage("om_msg", "img_x"), /saved_path/);
});

test("FeishuChannel.downloadImage：非 0 退出且无 error.message 时回退到 stderr", async () => {
  const fake = makeFakeDownload({ result: { status: 1, stdout: "", stderr: "lark-cli 崩了" } });
  const channel = makeChannel(makeFakeSpawn().spawn, fake.run);
  await assert.rejects(() => channel.downloadImage("om_msg", "img_x"), /下载图片失败（lark-cli exit=1）：lark-cli 崩了/);
});
