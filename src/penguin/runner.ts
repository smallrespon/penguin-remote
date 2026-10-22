// 单次 Run 的生命周期（ADR-0005 会话 API 版）：
// 占位消息 → （续接或新建会话）→ 订阅 SSE → 投递任务 → 流式预览 → 定稿。
// 订阅先于投递（服务端订阅后立刻发 task_state 快照，保证不丢事件）；
// 流中断不会让服务端停止任务，所以断流时显式 abort，避免僵尸任务占住会话。
// 占位 / 预览 / 定稿都承载为交互卡片（ADR-0006），卡片发送或更新失败时整体退回文本链路。

import type { ChannelAdapter, OutboundMessage } from "../channels/types.js";
import { basename, dirname } from "node:path";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ApprovalPolicy } from "../approvals.js";
import { denyAll } from "../approvals.js";
import { redact } from "../logger.js";
import type { Logger } from "../logger.js";
import type { RunEvent } from "../run-event.js";
import { buildPreviewCard, buildRunCard, busyCard, errorCard, placeholderCard, type RunCard } from "../card.js";
import {
  BUSY_HINT,
  PLACEHOLDER_TEXT,
  RunPreview,
  formatFinalText,
  formatRunFailure,
  type FinalOutcome,
  type PreviewOptions,
  type PreviewState,
} from "../render.js";
import { checkPage, extractPagePaths, hasRichBlocks, renderPage, stripPageLinks, toDraft } from "../htmlpage.js";
import type { AgentRef, ModelRef, SessionClient, TaskInputPart } from "./sessions.js";
import { SessionBusyError } from "./sessions.js";
import { RunTracker, isApprovalRequest, isTaskState } from "./omni.js";

/** 预览消息最多续接几条新消息（单条消息的更新次数有上限，长任务要换消息续）。 */
const MAX_CHAINS = 10;

/** 本次 Run 的出站承载：交互卡片（默认，ADR-0006）或文本（卡片发不出去时的降级）。 */
type Carrier = "card" | "text";

/** 新建会话时下发的档位（来自聊天的 binding）。 */
export interface SessionSettings {
  workspace?: string;
  model?: ModelRef;
  thinkingLevel?: string;
}

export interface RunSpec {
  chatId: string;
  input: string;
  /** 随任务投递的图片（data URL 数组，ADR-0009）；缺省 / 空数组 = 纯文本投递。 */
  images?: string[];
  /** 目标 Agent（Project + Agent）。 */
  agent: AgentRef;
  /** 续接的会话；null = 用 settings 新建。 */
  sessionId: string | null;
  /** 新建会话时下发的档位。 */
  settings?: SessionSettings;
  client: SessionClient;
  /** 流式预览节流参数。 */
  preview: PreviewOptions;
  /** 富内容自动渲染器（answer-me-with-html 的 am.mjs，ADR-0012）；null / 缺省 = 关闭。 */
  htmlRenderScript?: string | null;
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

  // 先发占位消息，拿到 message_id 后再开跑：事件到达时已有可更新的消息。
  // 默认走交互卡片（ADR-0006）；卡片发不出去时退回文本占位，整条 Run 走文本链路。
  // 两者都发不出去才抛出（由 gateway 回复「出错了」）。
  let carrier: Carrier;
  let placeholderId: string;
  try {
    placeholderId = await deps.channel.send(spec.chatId, { kind: "card", card: placeholderCard() });
    carrier = "card";
  } catch (error: unknown) {
    logger.warn(`占位卡片发送失败，退回文本消息：${error instanceof Error ? error.message : String(error)}`);
    placeholderId = await deps.channel.send(spec.chatId, { kind: "text", text: PLACEHOLDER_TEXT });
    carrier = "text";
  }

  let degraded = false;
  /** 已换过几条新消息继续预览（飞书单条文本消息最多编辑 20 次，实测）。 */
  let chains = 0;
  /** 当前这条预览消息上成功更新过的次数；0 = 它根本更新不了，换新的也没用。 */
  let editsOnCurrent = 0;
  /** 当前承载预览的消息 id（换消息后指向新消息，定稿也更新它）。 */
  let liveMessageId = placeholderId;
  /** 预览更新串行化：避免上一次 flush 还没落地就改指向。 */
  let flushChain: Promise<void> = Promise.resolve();
  /** Run 已结束：之后的预览 flush 一律作废，避免晚到的更新盖掉定稿。 */
  let finished = false;
  let preview = new RunPreview(spec.preview);

  /** 等未落地的预览更新做完，并此后再不让预览覆盖定稿。 */
  const settlePreview = async (): Promise<void> => {
    await flushChain;
    finished = true;
  };

  /** 把当前预览写进聊天里的消息；更新不成就换一条新消息，再也发不出去才彻底放弃预览。 */
  const flushOnce = async (): Promise<void> => {
    if (finished) return;
    const message: OutboundMessage =
      carrier === "card"
        ? { kind: "card", card: buildPreviewCard(preview.snapshot()) }
        : { kind: "text", text: preview.markdown() };
    try {
      await deps.channel.edit(liveMessageId, message);
      editsOnCurrent += 1;
      return;
    } catch (error: unknown) {
      logger.warn(`预览编辑失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 这条消息一次都没更新成功过，或卡片载体（ADR-0006：预览与定稿都 patch 同一张卡，
    // 不换新消息续接）：放弃预览，定稿仍会新发卡片 / 文本，结果不丢。
    if (editsOnCurrent === 0 || chains >= MAX_CHAINS || carrier === "card") {
      degraded = true;
      logger.warn("放弃流式预览，改为最终一次性发送");
      return;
    }
    // 文本载体：单条消息的更新次数有上限（实测 20 次，错误码 230072），
    // 长任务的后半程不能因此没有进度可见，换一条新消息继续承载预览。
    try {
      liveMessageId = await deps.channel.send(spec.chatId, message);
      chains += 1;
      editsOnCurrent = 0;
      logger.info(`预览消息更新次数已用尽，换用新消息继续（第 ${chains} 次续接）`);
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
    const failure = formatRunFailure(error);
    await deliverFinal(deps, spec.chatId, liveMessageId, {
      carrier,
      card: carrier === "card" ? errorCard(failure) : null,
      text: failure,
    }, degraded);
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

    // 图片 parts（ADR-0009）：文本非空时 text part 在前，data URL 按序随后；
    // 无图片时把原字符串原样交给 startTask，与旧行为逐字一致。
    const images = spec.images ?? [];
    const started =
      images.length === 0
        ? await spec.client.startTask(sessionId, spec.input)
        : await spec.client.startTask(sessionId, inputParts(spec.input, images));
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
    // 忙提示不是 Run 结果，是「请稍候」的普通提示：卡片载体下同样 patch 进占位卡
    // （busyCard），不留「思考中」僵尸卡；其它失败仍走 errorCard；文本载体下编辑占位文本。
    const busy = streamFailure instanceof SessionBusyError;
    const text = busy ? BUSY_HINT : formatRunFailure(streamFailure);
    await deliverFinal(deps, spec.chatId, liveMessageId, {
      carrier,
      card: carrier === "card" ? (busy ? busyCard(text) : errorCard(text)) : null,
      text,
    }, degraded);
    return failedReport(spec.chatId, sessionId, message, startedAt);
  }

  const outcome = tracker.outcome;
  logger.info(`Run 完成：${outcome.status}，session=${sessionId}`);
  await settlePreview();
  const snapshot = preview.snapshot();

  // ---- HTML 页交付（ADR-0012）----
  // 顺序要紧：先把 Agent 产出的页面挑出来、把死链从定稿文本里剥掉，再建定稿卡——
  // 飞书里点不动的本地链接没有意义。剥链对 outcome 全文与正文分区同构应用，
  // 这样 finalParts 的「流式累积 vs outcome 权威全文」比较不会被单侧修改破坏。
  const pages = await collectPages(outcome.text, logger);
  const stripped = pages.length > 0 ? stripPageLinks(outcome.text, pages) : outcome.text;
  const finalOutcome: FinalOutcome = pages.length > 0 ? { ...outcome, text: stripped } : outcome;
  const finalState: PreviewState = pages.length > 0 ? stripParts(snapshot, pages) : snapshot;
  await deliverFinal(deps, spec.chatId, liveMessageId, {
    carrier,
    card: carrier === "card" ? buildRunCard(finalOutcome, finalState) : null,
    text: formatFinalText(finalOutcome, finalState),
  }, degraded);
  await deliverPages(deps, spec, pages, stripped, logger);

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

/**
 * 文本 + 图片 data URL → input parts（ADR-0009）：文本非空时 text part 在前，
 * 图片按序随后；纯图片消息（文本为空）只投 image_url parts，不注入占位文本。
 */
function inputParts(input: string, images: readonly string[]): TaskInputPart[] {
  const parts: TaskInputPart[] = [];
  if (input !== "") parts.push({ type: "text", text: input });
  for (const imageUrl of images) parts.push({ type: "image_url", imageUrl });
  return parts;
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

/** 定稿内容：载体 + 卡片与文本双份；文本兜底保证结果不丢。 */
interface FinalContent {
  carrier: Carrier;
  card: RunCard | null;
  text: string;
}

/**
 * 从定稿文本里挑出真能转发的页面（ADR-0012）：提取 → 逐个校验存在、是文件、.html、不超上限。
 * 校验不过只记日志——页面发不出去不影响卡片定稿，结果不丢是老原则。
 */
async function collectPages(text: string, logger: Logger): Promise<string[]> {
  const pages: string[] = [];
  for (const path of extractPagePaths(text)) {
    const check = await checkPage(path);
    if (check.ok) {
      pages.push(path);
      continue;
    }
    logger.warn(`跳过页面 ${path}：${check.reason ?? "不可转发"}`);
  }
  return pages;
}

/**
 * 剥链同构应用到正文分区：流式攒下来的正文与 outcome 的权威全文过同一个变换，
 * 原本相等的两边变换后仍然相等，finalParts 的比较口径不被破坏。
 */
function stripParts(state: PreviewState, paths: readonly string[]): PreviewState {
  return {
    parts: state.parts.map((part) =>
      part.kind === "text" ? { ...part, text: stripPageLinks(part.text, paths) } : part,
    ),
  };
}

/**
 * 丢掉一个自动渲染出来的临时产物：删文件，顺手收掉 mkdtemp 出来的那个临时目录
 * （只收 `os.tmpdir()` 直下一层的，绝不碰用户自己的目录）。删不掉不影响结果——
 * 它本来就是要丢的东西。
 */
async function discardArtifact(path: string): Promise<void> {
  const parent = dirname(path);
  const weOwnParentDir = dirname(parent) === tmpdir();
  try {
    await rm(path, { force: true });
    if (weOwnParentDir) await rm(parent, { recursive: true, force: true });
  } catch {
    // 见上
  }
}

/**
 * HTML 页交付（ADR-0012）：Agent 产出的页面逐个以文件消息发进聊天；一页都没产出、
 * 配置了渲染器、且清理后的回复还含 a2ui / mermaid 围栏时，先渲染成 HTML 页再发。
 *
 * 全程只记日志：定稿卡已经发出去了，这里是加分项，任何一步失败都不能让 Run 收尾出事。
 */
async function deliverPages(
  deps: RunDeps,
  spec: RunSpec,
  pages: readonly string[],
  text: string,
  logger: Logger,
): Promise<void> {
  try {
    const forwarded = [...pages];
    const temporary: string[] = [];
    const script = spec.htmlRenderScript ?? null;
    if (forwarded.length === 0 && script !== null && hasRichBlocks(text)) {
      try {
        const artifact = await renderPage(toDraft(text), { script });
        forwarded.push(artifact);
        temporary.push(artifact);
      } catch (error: unknown) {
        logger.warn(`HTML 页渲染失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const page of forwarded) {
      try {
        await deps.channel.send(spec.chatId, { kind: "file", path: page, name: basename(page) });
      } catch (error: unknown) {
        logger.warn(`页面发送失败（${page}）：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // 自动渲染的产物是临时文件，发完就删（发送失败也删，与 downloadImage 同一纪律）；
        // Agent 自己产出的页面不归我们管，不能删。
        if (temporary.includes(page)) await discardArtifact(page);
      }
    }
  } catch (error: unknown) {
    logger.warn(`HTML 页交付失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 定稿：优先更新占位消息（卡片 patch / 文本 edit），失败则新发一条，再失败退回另一种载体，
 * 任何路径都保证结果不丢；只有最后的发送本身失败才抛出（由 gateway 回复「出错了」）。
 * carrier = "text"（或没有卡片内容）时走原有文本链路，一字不改。
 */
async function deliverFinal(
  deps: RunDeps,
  chatId: string,
  messageId: string,
  content: FinalContent,
  degraded: boolean,
): Promise<void> {
  if (content.carrier === "card" && content.card !== null) {
    if (!degraded) {
      try {
        await deps.channel.edit(messageId, { kind: "card", card: content.card });
        return;
      } catch (error: unknown) {
        deps.logger.warn(
          `定稿编辑失败，改为新发消息：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await deps.channel.send(chatId, { kind: "card", card: content.card });
      return;
    } catch (error: unknown) {
      deps.logger.warn(
        `定稿卡片发送失败，改为发送文本：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await deps.channel.send(chatId, { kind: "text", text: content.text });
    return;
  }
  if (!degraded) {
    try {
      await deps.channel.edit(messageId, { kind: "text", text: content.text });
      return;
    } catch (error: unknown) {
      deps.logger.warn(
        `定稿编辑失败，改为新发消息：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await deps.channel.send(chatId, { kind: "text", text: content.text });
}
