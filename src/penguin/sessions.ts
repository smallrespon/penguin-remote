// 会话 API 客户端：Bridge 与 PenguinHarness 之间的唯一传输层（ADR-0005）。
// 走 `penguin chat` 同款路径——owner 令牌当 penguin_session cookie：
//   建会话 POST /api/projects/:p/agents/:a/sessions（普通会话，不归档）
//   钉思考 PATCH /api/sessions/:id
//   订阅   GET  /api/sessions/:id/stream（SSE）
//   投递   POST /api/sessions/:id/tasks
//   中断   POST /api/sessions/:id/abort
//   审批   POST /api/sessions/:id/approvals/:toolCallId
// 传输层（fetch / SSE 读取）全部可注入，行为可离线测试。

import type { OmniMessage, ServerEvent, SessionStatus, StreamItem } from "./omni.js";

export type { StreamItem } from "./omni.js";

/** Agent 坐标（Project + Agent）；会话按它隔离。 */
export interface AgentRef {
  projectId: string;
  agentId: string;
}

/** 模型引用：provider + modelId 必须成对出现（服务端从不推断另一半）。 */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** 建会话时可下发的档位（thinkingLevel 服务端不接受，改用 PATCH 钉）。 */
export interface CreateSessionOptions {
  workspace?: string;
  model?: ModelRef;
  approvalMode?: string;
}

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  provider: string | null;
  modelId: string | null;
  workspace: string | null;
  title: string | null;
}

export interface TaskStartResult {
  /** 实际承载任务的会话 id（自愈改名后与请求的 id 不同）。 */
  sessionId: string;
  queued: boolean;
}

/** 带 cookie 的请求函数（OwnerSession.fetchAuthed），401 自动重铸重试。 */
export type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SessionClientOptions {
  fetchAuthed: AuthedFetch;
}

/** 会话 API 调用失败（非 2xx）。 */
export class SessionApiError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "SessionApiError";
    this.status = status;
  }
}

/** 会话已有任务在跑（409）：Bridge 的 Lane 正常不会撞上。 */
export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

interface SseFrame {
  event?: string;
  data: string;
}

/** 读 SSE 响应体，逐帧产出（event 行可选；注释行与 ping 心跳由上层处理）。 */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string | null = null;
  const dispatch = (): SseFrame | null => {
    if (data === null) {
      event = undefined;
      return null;
    }
    const frame: SseFrame = { data };
    if (event !== undefined) frame.event = event;
    event = undefined;
    data = null;
    return frame;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (line === "") {
          const frame = dispatch();
          if (frame !== null) yield frame;
          continue;
        }
        if (line.startsWith(":")) continue; // 注释（keep-alive）
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data = data === null ? value : `${data}\n${value}`;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function frameToItem(frame: SseFrame): StreamItem | null {
  if (frame.event === "ping") return null;
  const data = frame.data.trim();
  if (data === "") return null;
  const parsed: unknown = JSON.parse(data);
  if (frame.event === "server_event") {
    return { kind: "server", event: parsed as ServerEvent };
  }
  return { kind: "omni", message: parsed as OmniMessage };
}

/**
 * 一条会话的 SSE 订阅：异步可迭代，帧到达即推向消费者。
 * `ready()` 等到首帧（服务端订阅后立刻发 task_state 快照）——调用方必须
 * 先 ready 再投递任务，保证不丢事件。断开不重连（调用方按断流处置）。
 */
export class SessionStream implements AsyncIterable<StreamItem> {
  private readonly frames: AsyncGenerator<SseFrame>;
  private primed: IteratorResult<SseFrame> | null = null;
  private finished = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(frames: AsyncGenerator<SseFrame>) {
    this.frames = frames;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** 首帧到达即 resolve；连接建立失败则 reject。 */
  async ready(): Promise<void> {
    if (this.primed === null && !this.finished) {
      this.primed = await this.frames.next();
    }
    this.resolveReady();
  }

  async next(): Promise<IteratorResult<StreamItem>> {
    for (;;) {
      if (this.finished) return { done: true, value: undefined };
      let frame: IteratorResult<SseFrame>;
      if (this.primed !== null) {
        frame = this.primed;
        this.primed = null;
      } else {
        frame = await this.frames.next();
      }
      if (frame.done === true) {
        this.finished = true;
        return { done: true, value: undefined };
      }
      // 服务端的流终止哨兵（与 AMSP 一致）
      if (frame.value.data.trim() === "[DONE]") {
        this.finished = true;
        return { done: true, value: undefined };
      }
      const item = frameToItem(frame.value);
      if (item !== null) return { done: false, value: item };
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamItem> {
    return this;
  }

  /** for-await 正常结束 / break 时释放底层连接。 */
  async return(): Promise<IteratorResult<StreamItem>> {
    await this.close();
    return { done: true, value: undefined };
  }

  /** 主动断开（Run 结束或失败时调用）。 */
  async close(): Promise<void> {
    this.finished = true;
    await this.frames.return(undefined);
  }
}

export class SessionClient {
  private readonly fetchAuthed: AuthedFetch;

  constructor(options: SessionClientOptions) {
    this.fetchAuthed = options.fetchAuthed;
  }

  /** 建一个普通会话（source=user，不归档），按聊天档位下发。 */
  async createSession(projectId: string, agentId: string, options: CreateSessionOptions = {}): Promise<SessionInfo> {
    const body: Record<string, unknown> = {
      client: "cli",
      approvalMode: options.approvalMode ?? "allow-all",
    };
    if (options.workspace !== undefined) body.workspace = options.workspace;
    if (options.model !== undefined) {
      body.modelId = options.model.modelId;
      body.provider = options.model.provider;
    }
    const data = await this.request<{ session?: Record<string, unknown> }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/sessions`,
      body,
    );
    return toSessionInfo(data.session);
  }

  /** 钉思考档位（建会话不接受，只能 PATCH）。 */
  async patchThinkingLevel(sessionId: string, level: string): Promise<void> {
    await this.request("PATCH", `/sessions/${encodeURIComponent(sessionId)}`, { thinkingLevel: level });
  }

  async sessionInfo(sessionId: string): Promise<SessionInfo> {
    const data = await this.request<{ session?: Record<string, unknown> }>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return toSessionInfo(data.session);
  }

  /** 投递一条任务；返回实际会话 id（可能因自愈而变）与是否入队。 */
  async startTask(sessionId: string, input: string): Promise<TaskStartResult> {
    let response: Response;
    try {
      response = await this.fetchAuthed(`/sessions/${encodeURIComponent(sessionId)}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: [{ type: "text", text: input }] }),
      });
    } catch (error: unknown) {
      throw new SessionApiError(`投递任务失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 409) throw new SessionBusyError("该会话已有任务在执行");
    if (!response.ok) throw new SessionApiError(`投递任务失败：HTTP ${response.status}`, response.status);
    const data = (await response.json()) as { sessionId?: string; queued?: boolean };
    return { sessionId: data.sessionId ?? sessionId, queued: data.queued === true };
  }

  /** 中断；返回是否真的中断了什么（204 = 没有在跑的任务）。 */
  async abort(sessionId: string): Promise<boolean> {
    const response = await this.fetchAuthed(`/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    if (!response.ok && response.status !== 404) {
      throw new SessionApiError(`中断失败：HTTP ${response.status}`, response.status);
    }
    return response.status === 202;
  }

  /** 应答一个审批；404 = 已裁决或不存在。 */
  async decideApproval(sessionId: string, toolCallId: string, decision: "allow" | "deny"): Promise<boolean> {
    const response = await this.fetchAuthed(
      `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(toolCallId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw new SessionApiError(`应答审批失败：HTTP ${response.status}`, response.status);
    return true;
  }

  /** 订阅会话事件流（先 ready 再 startTask）。 */
  async stream(sessionId: string): Promise<SessionStream> {
    const response = await this.fetchAuthed(`/sessions/${encodeURIComponent(sessionId)}/stream`);
    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => "");
      throw new SessionApiError(
        `订阅事件流失败：HTTP ${response.status} ${detail.slice(0, 200)}`,
        response.status,
      );
    }
    return new SessionStream(sseFrames(response.body));
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchAuthed(path, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new SessionApiError(`${method} ${path} 失败：HTTP ${response.status} ${detail.slice(0, 200)}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function toSessionInfo(raw: Record<string, unknown> | undefined): SessionInfo {
  const session = raw ?? {};
  return {
    sessionId: typeof session.sessionId === "string" ? session.sessionId : "",
    status: typeof session.status === "string" ? (session.status as SessionStatus) : "idle",
    provider: typeof session.provider === "string" ? session.provider : null,
    modelId: typeof session.modelId === "string" ? session.modelId : null,
    workspace: typeof session.workspace === "string" ? session.workspace : null,
    title: typeof session.title === "string" ? session.title : null,
  };
}
