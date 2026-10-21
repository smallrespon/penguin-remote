// 单次 Run 的生命周期：占位消息 → 节流编辑的流式预览 → 定稿。
// 编辑失败（频率限制）时降级为最后一次性发送，结果不丢。
// 429（并发超限）按 Retry-After 退避重试；409（会话忙）转化为「进行中」提示。

import type { ChannelAdapter } from "../channels/types.js";
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
}

/** 执行一次 Run 并把结果发回聊天；返回供 Registry / 审计记录的 report。 */
export async function executeRun(deps: RunDeps, spec: RunSpec): Promise<RunReport> {
  const startedAt = Date.now();
  const logger = deps.logger.child({ chat: spec.chatId });
  logger.info(`发起 Run：${spec.input.slice(0, 80)}`);

  // 先发占位消息，拿到 message_id 后再开跑：事件到达时已有可编辑的消息。
  const placeholderId = await deps.channel.send(spec.chatId, PLACEHOLDER_TEXT);

  const preview = new RunPreview(spec.preview);
  let degraded = false;

  const startRun = (): AmspRun => {
    const run = spec.client.streamRun({
      input: spec.input,
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
      onEvent: (event: AmspEvent) => {
        preview.update(event);
        if (degraded) return;
        const now = Date.now();
        if (!preview.due(now)) return;
        preview.noteFlushed(now);
        void deps.channel.edit(placeholderId, preview.markdown()).catch((error: unknown) => {
          // 频率限制等：停止编辑，最后一次性发总结。
          degraded = true;
          logger.warn(
            `预览编辑失败，降级为最终一次性发送：${error instanceof Error ? error.message : String(error)}`,
          );
        });
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
    await deps.channel.send(
      spec.chatId,
      error instanceof SessionBusyError ? BUSY_HINT : formatRunFailure(error),
    );
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
  await deliverFinal(deps, spec.chatId, placeholderId, formatFinalText(outcome), degraded);

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
