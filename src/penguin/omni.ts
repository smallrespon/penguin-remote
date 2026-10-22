// 会话流 → Bridge 自有 Run 事件的翻译层：OmniMessage 信封与 server_event 的解析、
// 到 RunEvent 的映射，以及一个跟踪 Run 结局（状态 / 正文 / 用量）的薄壳。
// 语义忠实复刻 v1.0 经 @prismshadow/amsp 得到的行为（终局优先级、用量合计、正文拼接），
// 依据 PenguinHarness 服务端 amsp/translate.ts 的同一套规则。

import type { RunEvent, RunOutcome, RunStatus } from "../run-event.js";

/** 会话运行状态（服务端 task_state 事件的 state）。 */
export type SessionStatus = "idle" | "running" | "compacting";

/** 工具调用（complete 消息与 approval_request 事件共用）。 */
export interface OmniToolCall {
  name: string;
  /** 工具参数原文（JSON 字符串）。 */
  arguments: string;
  tool_call_id: string;
}

/** server_event：SSE 里带 `event: server_event` 行的数据。 */
export type ServerEvent =
  | { type: "task_state"; state: SessionStatus; queued?: number }
  | { type: "session_title"; sessionId: string; title: string }
  | { type: "approval_request"; toolCall: OmniToolCall; origin?: string[] }
  // 其余类型（heartbeat / resync_required / session_* 通知等） Bridge 不关心
  | { type: string };

/** OmniMessage 信封：SSE 里没有 event 行的数据。 */
export interface OmniMessage {
  timestamp?: string;
  /** model_msg / event_msg / session_meta。 */
  type: string;
  /** 子代理来源标记；缺省或空 = 主会话。 */
  origin?: string[];
  payload: Record<string, unknown>;
}

/** 会话流里的一条条目：server_event 或 OmniMessage。 */
export type StreamItem =
  | { kind: "server"; event: ServerEvent }
  | { kind: "omni"; message: OmniMessage };

/**
 * server_event 窄化辅助。ServerEvent 带一个「未知类型」兜底成员，
 * `event.type === "..."` 窄化不掉它，改用类型守卫（多查一个字段）。
 */
export function isApprovalRequest(event: ServerEvent): event is Extract<ServerEvent, { type: "approval_request" }> {
  return event.type === "approval_request" && "toolCall" in event;
}

export function isTaskState(event: ServerEvent): event is Extract<ServerEvent, { type: "task_state" }> {
  return event.type === "task_state" && "state" in event;
}

interface TerminalRecord {
  status: RunStatus;
  error?: { code: string; message: string };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** payload 里的错误信息（error_code / error_message 任一存在才返回）。 */
function errorOf(payload: Record<string, unknown>): { code: string; message: string } | undefined {
  const code = str(payload.error_code);
  const message = str(payload.error_message);
  if (code === "" && message === "") return undefined;
  return { code: code === "" ? "unknown" : code, message: message === "" ? code : message };
}

/**
 * 一条 OmniMessage → 零到多个 RunEvent（纯函数）。
 * 只翻译主会话（无 origin）的内容；子代理与压缩摘要不进预览分区。
 */
export function toRunEvents(message: OmniMessage): RunEvent[] {
  if (message.type !== "model_msg") return [];
  const p = message.payload;
  // 缺 timestamp 时用当前时间兜底（思考分区按起止时间算耗时，不能拿纪元时间充数）
  const at = message.timestamp ?? new Date().toISOString();
  switch (p.type) {
    case "partial_text": {
      if (p.event_type === "stop" || p.role !== "assistant") return [];
      const text = str(p.text);
      if (text === "") return [];
      return [{ type: "text.delta", role: "assistant", text }];
    }
    case "text": {
      if (p.role !== "assistant") return [];
      const text = str(p.text);
      if (text === "") return [];
      return [{ type: "text.done", role: "assistant", text }];
    }
    case "partial_thinking": {
      if (p.event_type === "stop") return [];
      const thinking = str(p.thinking);
      if (thinking === "") return [];
      return [{ type: "thinking.delta", thinking, at }];
    }
    case "thinking": {
      const thinking = str(p.thinking);
      if (thinking === "") return [];
      return [{ type: "thinking.done", thinking, at }];
    }
    case "tool_call": {
      return [
        {
          type: "tool_call.done",
          name: str(p.name),
          arguments: str(p.arguments),
          tool_call_id: str(p.tool_call_id),
          at,
        },
      ];
    }
    case "tool_call_output": {
      return [{ type: "tool_result.done", output: str(p.output), tool_call_id: str(p.tool_call_id), at }];
    }
    default:
      return [];
  }
}

/**
 * Run 结局跟踪器：喂入流条目，累积终局状态、正文与用量。
 * 规则与服务端 AMSP 翻译器一致：
 * - 终局优先级：abort 事件 > 最后一个未恢复的终局记录（非 completed 且无重试计划的
 *   request_end，或非 completed 的 compaction_end）> 最后一段主会话 assistant 文本
 *   stop_reason 为 fatal（引擎的轮数上限通知）> completed。
 * - 用量：每个请求的 token_usage 求和，压缩请求的用量也计入。
 * - 正文：主会话全部 assistant 完整文本按 "\n\n" 连接。
 */
export class RunTracker {
  private readonly texts: string[] = [];
  private requests = 0;
  private usageTotal = 0;
  private sawUsage = false;
  /** 等待 request_end 配对的请求用量。 */
  private held: number | null = null;
  /** 压缩期间的用量累计（compaction_end 时并入总用量）。 */
  private compactingTotal: number | null = null;
  private compacting = false;
  private terminal: TerminalRecord | null = null;
  private abortError: { code: string; message: string } | null = null;
  private lastMainTextStop: string | null = null;

  /** 喂入一条流条目，返回应当渲染的事件。 */
  feed(item: StreamItem): RunEvent[] {
    if (item.kind === "server") {
      if (isApprovalRequest(item.event)) {
        const call = item.event.toolCall;
        return [{ type: "approval.requested", tool_call: { ...call } }];
      }
      return [];
    }
    return this.feedMessage(item.message);
  }

  private feedMessage(message: OmniMessage): RunEvent[] {
    const main = message.origin === undefined || message.origin.length === 0;
    const p = message.payload;
    switch (p.type) {
      case "request_begin":
        this.requests += 1;
        // Run 继续走了：之前那个在任务边界失败的压缩不是它的结局。
        if (main) this.terminal = null;
        return [];
      case "token_usage": {
        const request = num(p.request && typeof p.request === "object" ? (p.request as Record<string, unknown>).total : undefined);
        if (request !== null) {
          if (this.compacting) {
            this.compactingTotal = (this.compactingTotal ?? 0) + request;
          } else {
            this.held = request;
          }
          this.sawUsage = true;
        }
        return [];
      }
      case "request_end": {
        if (this.held !== null) {
          this.usageTotal += this.held;
          this.held = null;
        }
        if (main && p.status !== "completed" && p.retry_in_ms === undefined) {
          const error = errorOf(p);
          this.terminal = { status: p.status as RunStatus, ...(error !== undefined ? { error } : {}) };
        }
        return [];
      }
      case "compaction_begin":
        this.compacting = true;
        this.compactingTotal = null;
        return [{ type: "compaction.started" }];
      case "compaction_end": {
        this.compacting = false;
        if (this.compactingTotal !== null) {
          this.usageTotal += this.compactingTotal;
          this.compactingTotal = null;
        }
        if (main && p.status !== "completed") {
          const error = errorOf(p);
          this.terminal = { status: p.status as RunStatus, ...(error !== undefined ? { error } : {}) };
        }
        return [];
      }
      case "abort":
        if (main) {
          this.abortError = errorOf(p) ?? { code: "user_abort", message: "已被中断" };
        }
        return [];
      case "text":
        if (main && p.role === "assistant") {
          this.lastMainTextStop = str(p.stop_reason) || "completed";
          const text = str(p.text);
          if (text !== "") this.texts.push(text);
        }
        return toRunEvents(message);
      default:
        return toRunEvents(message);
    }
  }

  /** 当前累积的结局（流结束后调用）。 */
  get outcome(): RunOutcome {
    const record: TerminalRecord =
      this.abortError !== null
        ? { status: "aborted", error: this.abortError }
        : (this.terminal ??
          (this.lastMainTextStop === "fatal"
            ? { status: "fatal", error: { code: "max_turns", message: "已达到最大轮数" } }
            : { status: "completed" }));
    return {
      status: record.status,
      ...(record.error !== undefined ? { error: record.error } : {}),
      text: this.texts.join("\n\n"),
      requests: this.requests,
      usage: this.sawUsage ? { total: this.usageTotal } : null,
    };
  }
}
