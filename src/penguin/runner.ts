// 单次 Run 的生命周期：占位消息 → 节流编辑的流式预览 → 定稿。
// 编辑失败（频率限制）时降级为最后一次性发送，结果不丢。
// 429（并发超限）按 Retry-After 退避重试；409（会话忙）转化为「进行中」提示。

import type { ChannelAdapter } from "../channels/types.js";
import type { ApprovalPolicy } from "../approvals.js";
import { denyAll } from "../approvals.js";
import { SessionBusyError, TooManyRunsError } from "./amsp.js";
import type { AmspClient, AmspEvent, AmspRun, AmspRunOutcome } from "./amsp.js";
import {
  BUSY_HINT,
  PLACEHOLDER_TEXT,
  RunPreview,
  formatFinalText,
  formatRunFailure,
  type PreviewOptions,
} from "../render.js";
import type { Logger } from "../logger.js";

/** 429 退避重试次数（另有首次尝试，共 1 + MAX_RETRIES 次）。 */
const MAX_RETRIES = 2;

/** 预览消息最多续接几条新消息（飞书单条消息编辑次数有限，长任务要换消息续）。 */
const MAX_CHAINS = 10;

export interface RunSpec {
  chatId: string;
  input: string;
  /** 续接的会话；省略则新建。 */
  sessionId?: string;
  client: AmspClient;
  /** 流式预览节流参数。 */
  preview: PreviewOptions;
  /** Run 一旦发起即回调（供 /stop 持有 abort）。 */
  onStart?: (run: AmspRun) => void;
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
  const placeholderId = await deps.channel.send(spec.chatId, PLACEHOLDER_TEXT);

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
  // 每次尝试（含 429 后重开）都用新的预览状态，避免上一次的增量文本残留。
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
      await deps.channel.edit(liveMessageId, markdown);
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
      liveMessageId = await deps.channel.send(spec.chatId, markdown);
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

  const startRun = (): AmspRun => {
    preview = new RunPreview(spec.preview);
    const run = spec.client.streamRun({
      input: spec.input,
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
      onEvent: (event: AmspEvent) => {
        preview.update(event);
        if (degraded) return;
        const now = Date.now();
        if (!preview.due(now)) return;
        preview.noteFlushed(now);
        flushChain = flushChain.then(() => flushOnce());
      },
      // 审批：allow-all 模式下不会来；来了就按策略决定，并让用户在预览里看到结果。
      onApproval: (request, ctx) => {
        const decision = policy.decide({
          sessionId: ctx.sessionId,
          toolCallId: request.tool_call.tool_call_id,
          name: request.tool_call.name,
          arguments: request.tool_call.arguments,
        });
        preview.addNotice(
          decision === "allow"
            ? `✅ 已允许 \`${request.tool_call.name}\``
            : `🚫 已拒绝 \`${request.tool_call.name}\`（v1 不做审批卡片）`,
        );
        logger.warn(`审批请求 \`${request.tool_call.name}\` → ${decision}`);
        return decision;
      },
    });
    // 每次重开 Run 都更新 abort 句柄，/stop 中断的永远是当前这次尝试。
    spec.onStart?.(run);
    return run;
  };

  const run = startRun();
  const sessionId = await run.sessionId.catch(() => null);

  let outcome: AmspRunOutcome;
  try {
    outcome = await withRetry(startRun, run, logger);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Run 失败：${message}`);
    // 409 会话忙：转化为「进行中」提示，和其他入口一致。
    const failureText = error instanceof SessionBusyError ? BUSY_HINT : formatRunFailure(error);
    // 预览消息还挂在聊天里，别让它停在「思考中…」：把结局写进同一条消息。
    await settlePreview();
    await deliverFinal(deps, spec.chatId, liveMessageId, failureText, degraded);
    return {
      chatId: spec.chatId,
      sessionId,
      status: "failed",
      error: message,
      usageTotal: null,
      requests: 0,
      durationMs: Date.now() - startedAt,
      modelId: null,
    };
  }

  logger.info(`Run 完成：${outcome.status}，session=${outcome.sessionId}`);
  await settlePreview();
  await deliverFinal(deps, spec.chatId, liveMessageId, formatFinalText(outcome, preview.snapshot()), degraded);

  const modelId = await spec.client
    .session(outcome.sessionId)
    .then((info) => info.model_id)
    .catch(() => null);
  return {
    chatId: spec.chatId,
    sessionId: outcome.sessionId,
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error.message } : {}),
    usageTotal: outcome.usage?.total ?? null,
    requests: outcome.requests,
    durationMs: Date.now() - startedAt,
    modelId,
  };
}

/** 429 时按 Retry-After 退避后重开一次 Run；其余错误直接抛出。 */
async function withRetry(
  startRun: () => AmspRun,
  first: AmspRun,
  logger: Logger,
): Promise<AmspRunOutcome> {
  let run = first;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run.result();
    } catch (error: unknown) {
      if (error instanceof TooManyRunsError && attempt < MAX_RETRIES) {
        logger.warn(`Agent 并发已达上限，${error.retryAfterMs}ms 后重试（第 ${attempt + 1} 次）`);
        await sleep(error.retryAfterMs);
        run = startRun();
        continue;
      }
      throw error;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      await deps.channel.edit(placeholderId, finalText);
      return;
    } catch (error: unknown) {
      deps.logger.warn(
        `定稿编辑失败，改为新发消息：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await deps.channel.send(chatId, finalText);
}
