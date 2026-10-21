import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeMessageEvent, FeishuChannel, stripMentions } from "../src/channels/feishu.js";
import { createLogger } from "../src/logger.js";
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

test("decodeMessageEvent：机器人自己发的、非文本类型、空文本、坏结构都被忽略", () => {
  assert.equal(decodeMessageEvent(p2pEvent("hi", { sender_type: "bot" }), BOT), null);
  assert.equal(decodeMessageEvent(p2pEvent("[图片]", { message_type: "image" }), BOT), null);
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

function makeChannel(spawn = makeFakeSpawn().spawn): FeishuChannel {
  return new FeishuChannel({
    bin: "lark-cli",
    logger: silentLogger,
    spawn,
    resolveBotOpenId: async () => BOT,
    run: makeFakeRun([]).run,
  });
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
  assert.equal(await channel.send("oc_chat", "你好"), "om_reply");
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
  await assert.rejects(() => channel2.send("oc_chat", "你好"), /bot not in chat/);
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
  await channel.edit("om_reply", "更新后的内容");
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
