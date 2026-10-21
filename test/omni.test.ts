// omni 翻译层测试：OmniMessage → RunEvent 映射、终局优先级、用量合计、正文拼接。
// 期望行为对齐 v1.0 经 @prismshadow/amsp 得到的结果（服务端 amsp/translate.ts 同款规则）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { RunTracker, toRunEvents, type OmniMessage, type ServerEvent, type StreamItem } from "../src/penguin/omni.js";

function omni(payload: Record<string, unknown>, extra: Partial<OmniMessage> = {}): OmniMessage {
  return { type: "model_msg", ...extra, payload };
}

function eventMsg(payload: Record<string, unknown>, extra: Partial<OmniMessage> = {}): OmniMessage {
  return { type: "event_msg", ...extra, payload };
}

function server(event: ServerEvent): StreamItem {
  return { kind: "server", event };
}

test("partial_text 增量与完整 text 收尾都映射为正文事件", () => {
  const events = [
    ...toRunEvents(omni({ type: "partial_text", role: "assistant", event_type: "start", text: "" })),
    ...toRunEvents(omni({ type: "partial_text", role: "assistant", event_type: "delta", text: "你好" })),
    ...toRunEvents(omni({ type: "partial_text", role: "assistant", event_type: "stop", text: "" })),
    ...toRunEvents(omni({ type: "text", role: "assistant", text: "你好", stop_reason: "completed" })),
  ];
  assert.deepEqual(events, [
    { type: "text.delta", role: "assistant", text: "你好" },
    { type: "text.done", role: "assistant", text: "你好" },
  ]);
});

test("user 角色的 text 不回显（那是入站消息的回声）", () => {
  assert.deepEqual(toRunEvents(omni({ type: "text", role: "user", text: "现在几点" })), []);
});

test("thinking 增量与完整思考映射为思考事件", () => {
  const events = [
    ...toRunEvents(omni({ type: "partial_thinking", role: "assistant", event_type: "delta", thinking: "让" }, { timestamp: "2026-10-21T10:00:00.000Z" })),
    ...toRunEvents(omni({ type: "partial_thinking", role: "assistant", event_type: "delta", thinking: "我想" }, { timestamp: "2026-10-21T10:00:01.000Z" })),
    ...toRunEvents(omni({ type: "thinking", role: "assistant", thinking: "让我想想", stop_reason: "completed" }, { timestamp: "2026-10-21T10:00:02.000Z" })),
  ];
  assert.deepEqual(events, [
    { type: "thinking.delta", thinking: "让", at: "2026-10-21T10:00:00.000Z" },
    { type: "thinking.delta", thinking: "我想", at: "2026-10-21T10:00:01.000Z" },
    { type: "thinking.done", thinking: "让我想想", at: "2026-10-21T10:00:02.000Z" },
  ]);
});

test("tool_call 与 tool_call_output 映射为工具事件", () => {
  const events = [
    ...toRunEvents(omni({ type: "tool_call", role: "assistant", name: "exec_command", arguments: '{"cmd":"date"}', tool_call_id: "tc1" })),
    ...toRunEvents(omni({ type: "tool_call_output", role: "user", output: "Tue Oct 21", tool_call_id: "tc1" })),
  ];
  assert.deepEqual(events, [
    { type: "tool_call.done", name: "exec_command", arguments: '{"cmd":"date"}', tool_call_id: "tc1" },
    { type: "tool_result.done", output: "Tue Oct 21", tool_call_id: "tc1" },
  ]);
});

test("未知 payload 类型被忽略（不产生渲染事件）", () => {
  assert.deepEqual(toRunEvents(omni({ type: "mcp_connect.done", status: "completed", results: [] })), []);
  assert.deepEqual(toRunEvents(omni({ type: "session_meta", sessionId: "s1" })), []);
});

test("approval_request server_event 映射为审批事件", () => {
  const tracker = new RunTracker();
  const events = tracker.feed(
    server({ type: "approval_request", toolCall: { name: "exec_command", arguments: "{}", tool_call_id: "tc9" } }),
  );
  assert.deepEqual(events, [
    { type: "approval.requested", tool_call: { name: "exec_command", arguments: "{}", tool_call_id: "tc9" } },
  ]);
});

test("task_state / session_title 等 server_event 不产生渲染事件", () => {
  const tracker = new RunTracker();
  assert.deepEqual(tracker.feed(server({ type: "task_state", state: "running" })), []);
  assert.deepEqual(tracker.feed(server({ type: "session_title", sessionId: "s1", title: "标题" })), []);
  assert.deepEqual(tracker.feed(server({ type: "heartbeat" })), []);
});

test("简单完成：正文拼接、用量求和、completed 状态", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_begin" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "token_usage", request: { total: 120 }, session: { total: 120 } }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "completed" }) });
  tracker.feed({ kind: "omni", message: omni({ type: "text", role: "assistant", text: "答案", stop_reason: "completed" }) });
  assert.deepEqual(tracker.outcome, { status: "completed", text: "答案", requests: 1, usage: { total: 120 } });
});

test("多轮对话：正文按 \\n\\n 连接，用量逐请求累加", () => {
  const tracker = new RunTracker();
  for (const [text, total] of [["先看看", 100], ["看完了", 50]] as const) {
    tracker.feed({ kind: "omni", message: eventMsg({ type: "request_begin" }) });
    tracker.feed({ kind: "omni", message: eventMsg({ type: "token_usage", request: { total }, session: { total } }) });
    tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "completed" }) });
    tracker.feed({ kind: "omni", message: omni({ type: "text", role: "assistant", text, stop_reason: "completed" }) });
  }
  const outcome = tracker.outcome;
  assert.equal(outcome.text, "先看看\n\n看完了");
  assert.equal(outcome.requests, 2);
  assert.deepEqual(outcome.usage, { total: 150 });
});

test("abort 事件压过一切：状态 aborted 且带错误信息", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: eventMsg({ type: "abort", error_code: "user_abort", error_message: "用户中断" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "completed" }) });
  const outcome = tracker.outcome;
  assert.equal(outcome.status, "aborted");
  assert.deepEqual(outcome.error, { code: "user_abort", message: "用户中断" });
});

test("request_end 非 completed 且无重试计划 = 终局失败，带错误", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_begin" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "fatal", error_code: "auth", error_message: "403 quota" }) });
  const outcome = tracker.outcome;
  assert.equal(outcome.status, "fatal");
  assert.deepEqual(outcome.error, { code: "auth", message: "403 quota" });
});

test("request_end 带 retry_in_ms 不是终局：后续请求成功即 completed", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_begin" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "retryable", retry_in_ms: 2000, error_code: "rate_limited", error_message: "429" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_begin" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "token_usage", request: { total: 30 }, session: { total: 30 } }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "completed" }) });
  tracker.feed({ kind: "omni", message: omni({ type: "text", role: "assistant", text: "重试后成功", stop_reason: "completed" }) });
  const outcome = tracker.outcome;
  assert.equal(outcome.status, "completed");
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.text, "重试后成功");
});

test("最后一段 assistant 文本 stop_reason=fatal（轮数上限）→ fatal", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: omni({ type: "text", role: "assistant", text: "到顶了", stop_reason: "fatal" }) });
  assert.equal(tracker.outcome.status, "fatal");
});

test("压缩期间的用量计入总用量，压缩失败成为终局", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_begin" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "token_usage", request: { total: 100 }, session: { total: 100 } }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "completed" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "compaction_begin", reason: "context", mode: "summarize" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "token_usage", request: { total: 40 }, session: { total: 140 } }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "compaction_end", reason: "context", mode: "summarize", status: "completed" }) });
  const outcome = tracker.outcome;
  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.usage, { total: 140 });
});

test("压缩失败后没有新请求：终局取压缩的失败", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: eventMsg({ type: "compaction_begin", reason: "context", mode: "summarize" }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "compaction_end", reason: "context", mode: "summarize", status: "fatal", error_code: "auth", error_message: "no key" }) });
  const outcome = tracker.outcome;
  assert.equal(outcome.status, "fatal");
  assert.deepEqual(outcome.error, { code: "auth", message: "no key" });
});

test("没有任何用量事件时 usage 为 null", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: omni({ type: "text", role: "assistant", text: "hi", stop_reason: "completed" }) });
  assert.deepEqual(tracker.outcome, { status: "completed", text: "hi", requests: 0, usage: null });
});

test("子代理来源（origin 非空）的内容不进正文与终局", () => {
  const tracker = new RunTracker();
  tracker.feed({ kind: "omni", message: omni({ type: "text", role: "assistant", text: "子代理的话", stop_reason: "completed" }, { origin: ["sub"] }) });
  tracker.feed({ kind: "omni", message: eventMsg({ type: "request_end", status: "fatal" }, { origin: ["sub"] }) });
  const outcome = tracker.outcome;
  assert.equal(outcome.text, "");
  assert.equal(outcome.status, "completed");
});
