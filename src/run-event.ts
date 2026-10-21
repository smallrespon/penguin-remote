// Bridge 自有的 Run 事件模型：渲染层（render.ts）只认这一套，
// 由 src/penguin/omni.ts 从 PenguinHarness 会话流的 OmniMessage 翻译而来。
// 与 v1.0 消费的 AMSP 事件结构保持一致（渲染行为不变），但不再依赖 @prismshadow/amsp。

/** 一次 Run 的过程事件（喂给渲染器的增量）。 */
export type RunEvent =
  | { type: "text.delta"; role: "assistant"; text: string }
  | { type: "text.done"; role: "assistant"; text: string }
  | { type: "thinking.delta"; thinking: string; at: string }
  | { type: "thinking.done"; thinking: string; at: string }
  | { type: "tool_call.done"; name: string; arguments: string; tool_call_id: string }
  | { type: "tool_result.done"; output: string; tool_call_id: string }
  | { type: "approval.requested"; tool_call: { name: string; arguments: string; tool_call_id: string } }
  | { type: "compaction.started" };

/** Run 的终局状态（对应服务端的 StopReason 词汇表）。 */
export type RunStatus = "completed" | "aborted" | "retryable" | "fatal";

/** 一次 Run 的结局汇总（对应旧 AMSP 客户端的 outcome）。 */
export interface RunOutcome {
  status: RunStatus;
  /** 失败或中止时的错误信息（脱敏由渲染层负责）。 */
  error?: { code: string; message: string };
  /** 主会话全部 assistant 完整文本，按 "\n\n" 连接（与 AMSP 客户端一致）。 */
  text: string;
  /** 请求数（不含压缩请求）。 */
  requests: number;
  /** 本次 Run 的 token 用量合计；一个 request 都没跑过则为 null。 */
  usage: { total: number } | null;
}
