// 单次 Run 的生命周期：发起 → 等结果 → 把最终文本发回聊天。
// 流式预览（占位消息 + 节流编辑）在 T6 接入；此处只发最终一条。

import type { ChannelAdapter } from "../channels/types.js";
import type { AmspClient, AmspRun, AmspRunOutcome } from "./amsp.js";
import { formatFinalText, formatRunFailure } from "../render.js";
import type { Logger } from "../logger.js";

export interface RunSpec {
  chatId: string;
  input: string;
  /** 续接的会话；省略则新建。 */
  sessionId?: string;
  client: AmspClient;
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

/** 执行一次 Run 并把最终文本发回聊天；返回供 Registry / 审计记录的 report。 */
export async function executeRun(deps: RunDeps, spec: RunSpec): Promise<RunReport> {
  const startedAt = Date.now();
  const logger = deps.logger.child({ chat: spec.chatId });
  logger.info(`发起 Run：${spec.input.slice(0, 80)}`);

  const run = spec.client.streamRun({
    input: spec.input,
    ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
  });
  spec.onStart?.(run);
  const sessionId = await run.sessionId.catch(() => null);

  let outcome: AmspRunOutcome;
  try {
    outcome = await run.result();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Run 失败：${message}`);
    await deps.channel.send(spec.chatId, formatRunFailure(error));
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
  await deps.channel.send(spec.chatId, formatFinalText(outcome));
  const modelId = await spec.client.session(outcome.sessionId).then(
    (info) => info.model_id,
    () => null,
  );
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
