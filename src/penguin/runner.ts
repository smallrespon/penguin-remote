// 单次 Run 的生命周期（ADR-0005 会话 API 版）：
// 占位消息 → （续接或新建会话）→ 订阅 SSE → 投递任务 → 流式预览 → 定稿。
// 订阅先于投递（服务端订阅后立刻发 task_state 快照，保证不丢事件）；
// 流中断不会让服务端停止任务，所以断流时显式 abort，避免僵尸任务占住会话。

import type { ChannelAdapter } from "../channels/types.js";
import type { ApprovalPolicy } from "../approvals.js";
import { denyAll } from "../approvals.js";
import { redact } from "../logger.js";
import type { Logger } from "../logger.js";
import type { RunEvent } from "../run-event.js";
import {
  BUSY_HINT,
  PLACEHOLDER_TEXT,
  RunPreview,
  formatFinalText,
  formatRunFailure,
  type PreviewOptions,
} from "../render.js";
import type { AgentRef, ModelRef, SessionClient } from "./sessions.js";
import { SessionBusyError } from "./sessions.js";
import { RunTracker, isApprovalRequest, isTaskState } from "./omni.js";

/** 预览消息最多续接几条新消息（飞书单条消息编辑次数有限，长任务要换消息续）。 */
const MAX_CHAINS = 10;

/** 新建会话时下发的档位（来自聊天的 binding）。 */
export interface SessionSettings {
  workspace?: string;
  model?: ModelRef;
  thinkingLevel?: string;
}

export interface RunSpec {
  chatId: string;
  input: string;
  /** 目标 Agent（Project + Agent）。 */
  agent: AgentRef;
  /** 续接的会话；null = 用 settings 新建。 */
  sessionId: string | null;
  /** 新建会话时下发的档位。 */
  settings?: SessionSettings;
  client: SessionClient;
  /** 流式预览节流参数。 */
  preview: PreviewOptions;
  /** 会话就绪即回调（供 /stop 持有 abort）。 */
  onStart?: (handle: RunHandle) => void;
}

/** 一次在途 Run 的句柄：/stop 用它中断。 */
export interface RunHandle {
  abort: () => Promise<void>;
}

export interface RunReport {
  chatId: string;
  sessionId: string | null;
  status: string;
  error?: string;
  usageTotal: number | null;
  requests: number;
  durationMs: number;
  /** 会话所用模型（run 结束后查会话得到；查不到为 null）。 */
  modelId: string | null;
}

export interface RunDeps {
  channel: ChannelAdapter;
  logger: Logger;
  /** 审批策略；缺省为「一律拒绝」（allow-all 模式下不会用到）。 */
  approvals?: ApprovalPolicy;
}

/** 执行一次 Run 并把结果发回聊天；返回供 Registry / 审计记录的 report。 */
export async function executeRun(deps: RunDeps, spec: RunSpec): Promise<RunReport> {
  const startedAt = Date.now();
  const logger = deps.logger.child({ chat: spec.chatId });
  const policy = deps.approvals ?? denyAll;
  logger.info(`发起 Run：${spec.input.slice(0, 80)}`);

  // 先发占位消息，拿到 message_id 后再开跑：事件到达时已有可编辑的消息。
  const placeholderId = await deps.channel.send(spec.chatId, { kind: "text", text: PLACEHOLDER_TEXT });

  let degraded = false;
  /** 已换过几条新消息继续预览（飞书单条消息最多编辑 20 次，实测）。 */
  let chains = 0;
  /** 当前这条预览消息上成功编辑过的次数；0 = 它根本编辑不了，换新的也没用。 */
  let editsOnCurrent = 0;
  /** 当前承载预览的消息 id（换消息后指向新消息，定稿也编辑它）。 */
  let liveMessageId = placeholderId;
  /** 预览编辑串行化：避免上一次 flush 还没落地就改指向。 */
  let flushChain: Promise<void> = Promise.resolve();
  /** Run 已结束：之后的预览 flush 一律作废，避免晚到的编辑盖掉定稿。 */
  let finished = false;
  let preview = new RunPreview(spec.preview);

  /** 等未落地的预览编辑做完，并此后再不让预览覆盖定稿。 */
  const settlePreview = async (): Promise<void> => {
    await flushChain;
    finished = true;
  };

  /** 把当前预览写进聊天里的消息；编辑不成就换一条新消息，再也发不出去才彻底放弃预览。 */
  const flushOnce = async (): Promise<void> => {
    if (finished) return;
    const markdown = preview.markdown();
    try {
      await deps.channel.edit(liveMessageId, { kind: "text", text: markdown });
      editsOnCurrent += 1;
      return;
    } catch (error: unknown) {
      logger.warn(`预览编辑失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 这条消息一次都没编辑成功过：换新的也白搭，直接放弃预览（发送本身出问题时走这条）。
    if (editsOnCurrent === 0 || chains >= MAX_CHAINS) {
      degraded = true;
      logger.warn("放弃流式预览，改为最终一次性发送");
      return;
    }
    // 飞书对单条消息的编辑次数有上限（实测 20 次，错误码 230072）。
    // 长任务的后半程不能因此没有进度可见：换一条新消息继续承载预览。
    try {
      liveMessageId = await deps.channel.send(spec.chatId, { kind: "text", text: markdown });
      chains += 1;
      editsOnCurrent = 0;
      logger.info(`预览消息编辑次数已用尽，换用新消息继续（第 ${chains} 次续接）`);
    } catch (error: unknown) {
      degraded = true;
      logger.warn(
        `新发预览消息失败，改为最终一次性发送：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /** 事件 → 预览（节流）；approval 由调用方单独处理，不在这里渲染。 */
  const applyEvents = (events: readonly RunEvent[], now: number): void => {
    for (const event of events) {
      preview.update(event);
      if (degraded) continue;
      if (!preview.due(now)) continue;
      preview.noteFlushed(now);
      flushChain = flushChain.then(() => flushOnce());
    }
  };

  /** 审批应答：allow-all 模式下不会来；来了按策略决定，并让用户在预览里看到结果。 */
  const answerApproval = async (
    sessionId: string,
    call: { name: string; arguments: string; tool_call_id: string },
  ): Promise<void> => {
    const decision = await policy.decide({
      sessionId,
      toolCallId: call.tool_call_id,
      name: call.name,
      arguments: call.arguments,
    });
    preview.addNotice(
      decision === "allow"
        ? `✅ 已允许 \`${call.name}\``
        : `🚫 已拒绝 \`${call.name}\`（v1 不做审批卡片）`,
    );
    logger.warn(`审批请求 \`${call.name}\` → ${decision}`);
    try {
      await spec.client.decideApproval(sessionId, call.tool_call_id, decision);
    } catch (error: unknown) {
      logger.warn(`应答审批失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ---- 会话就绪：续接或新建 ----

  let sessionId: string;
  try {
    if (spec.sessionId !== null) {
      sessionId = spec.sessionId;
    } else {
      const settings = spec.settings ?? {};
      const info = await spec.client.createSession(spec.agent.projectId, spec.agent.agentId, {
        ...(settings.workspace !== undefined ? { workspace: settings.workspace } : {}),
        ...(settings.model !== undefined ? { model: settings.model } : {}),
      });
      sessionId = info.sessionId;
      logger.info(`已新建会话 ${sessionId}`);
      if (settings.thinkingLevel !== undefined) {
        // 建会话不接受 thinkingLevel（服务端只认 PATCH）；钉失败不致命——会话按默认档位跑。
        try {
          await spec.client.patchThinkingLevel(sessionId, settings.thinkingLevel);
        } catch (error: unknown) {
          logger.warn(`钉思考档位失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`会话准备失败：${message}`);
    await settlePreview();
    await deliverFinal(deps, spec.chatId, liveMessageId, formatRunFailure(error), degraded);
    return failedReport(spec.chatId, null, message, startedAt);
  }

  let aborted = false;
  const handle: RunHandle = {
    abort: async () => {
      aborted = true;
      try {
        await spec.client.abort(sessionId);
      } catch (error: unknown) {
        logger.warn(`中断失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  spec.onStart?.(handle);

  // ---- 订阅 → 投递 → 守到 idle ----

  const tracker = new RunTracker();
  let sawActive = false;
  let streamFailure: unknown = null;

  try {
    let stream = await spec.client.stream(sessionId);
    await stream.ready();

    const started = await spec.client.startTask(sessionId, spec.input);
    if (started.sessionId !== sessionId) {
      // 服务端把会话自愈成了新 id：旧订阅作废，改订阅新 id 再继续。
      logger.info(`会话自愈：${sessionId} → ${started.sessionId}`);
      await stream.close();
      sessionId = started.sessionId;
      stream = await spec.client.stream(sessionId);
      await stream.ready();
    }

    for await (const item of stream) {
      if (item.kind === "server") {
        // 审批先进预览（「⚠️ 等待审批」），应答结果再由 answerApproval 追加一条提示。
        if (isApprovalRequest(item.event)) {
          applyEvents(tracker.feed(item), Date.now());
          await answerApproval(sessionId, item.event.toolCall);
          continue;
        }
        if (isTaskState(item.event)) {
          // running/compacting 会在 Run 中途重复发布；只有「活跃过再回 idle」才是结局。
          if (item.event.state !== "idle") sawActive = true;
          else if (sawActive) break;
        }
        continue;
      }
      applyEvents(tracker.feed(item), Date.now());
    }
    if (!sawActive) {
      // 没看到 running 就结束了：流断了或任务没起来，按断流处置。
      streamFailure = new Error("事件流在 Run 结束前中断");
    }
    await stream.close();
  } catch (error: unknown) {
    streamFailure = error;
  }

  if (streamFailure !== null) {
    const message = redact(streamFailure instanceof Error ? streamFailure.message : String(streamFailure));
    logger.warn(`Run 失败：${message}`);
    // 断流不会让服务端停止任务：显式中止，避免僵尸任务占住会话。
    // 会话忙（409）除外——那个在跑的任务不是我们起的，不能替别人中断。
    if (!aborted && !(streamFailure instanceof SessionBusyError)) await handle.abort();
    await settlePreview();
    const text =
      streamFailure instanceof SessionBusyError ? BUSY_HINT : formatRunFailure(streamFailure);
    await deliverFinal(deps, spec.chatId, liveMessageId, text, degraded);
    return failedReport(spec.chatId, sessionId, message, startedAt);
  }

  const outcome = tracker.outcome;
  logger.info(`Run 完成：${outcome.status}，session=${sessionId}`);
  await settlePreview();
  await deliverFinal(deps, spec.chatId, liveMessageId, formatFinalText(outcome, preview.snapshot()), degraded);

  const modelId = await spec.client
    .sessionInfo(sessionId)
    .then((info) => info.modelId)
    .catch(() => null);
  return {
    chatId: spec.chatId,
    sessionId,
    status: outcome.status,
    ...(outcome.error !== undefined ? { error: outcome.error.message } : {}),
    usageTotal: outcome.usage?.total ?? null,
    requests: outcome.requests,
    durationMs: Date.now() - startedAt,
    modelId,
  };
}

function failedReport(chatId: string, sessionId: string | null, message: string, startedAt: number): RunReport {
  return {
    chatId,
    sessionId,
    status: "failed",
    error: message,
    usageTotal: null,
    requests: 0,
    durationMs: Date.now() - startedAt,
    modelId: null,
  };
}

/** 定稿：优先编辑占位消息；编辑失败（或已降级）就新发一条，保证结果不丢。 */
async function deliverFinal(
  deps: RunDeps,
  chatId: string,
  placeholderId: string,
  finalText: string,
  degraded: boolean,
): Promise<void> {
  if (!degraded) {
    try {
      await deps.channel.edit(placeholderId, { kind: "text", text: finalText });
      return;
    } catch (error: unknown) {
      deps.logger.warn(
        `定稿编辑失败，改为新发消息：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await deps.channel.send(chatId, { kind: "text", text: finalText });
}
