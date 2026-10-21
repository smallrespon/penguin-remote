// 审批（v2 可选）：allow-all 模式下服务端不会发 approval.requested，
// 所以 v1 不做飞书审批卡片。这里保留接缝——策略接口 + 默认「一律拒绝」，
// 让切到 always-ask 的 Agent 时行为明确（拒绝并可见），而不是静默挂住。

import type { ApprovalDecision } from "./penguin/amsp.js";

/** 一次审批请求（来自 AMSP 的 `approval.requested`）。 */
export interface ApprovalRequest {
  sessionId: string;
  toolCallId: string;
  /** 工具名，如 `exec_command`。 */
  name: string;
  /** 工具参数原文（JSON 字符串）。 */
  arguments: string;
}

/** 审批策略：v1 只有 denyAll；v2 可换成发飞书卡片等人工应答的实现。 */
export interface ApprovalPolicy {
  decide(request: ApprovalRequest): Promise<ApprovalDecision> | ApprovalDecision;
}

/** v1 默认策略：一律拒绝（与 AMSP 客户端缺省行为一致，但显式且可观测）。 */
export const denyAll: ApprovalPolicy = {
  decide: () => "deny",
};
