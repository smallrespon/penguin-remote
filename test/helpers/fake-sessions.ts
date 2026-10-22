// 测试用假会话 API 服务器：以 AuthedFetch 形态注入，覆盖建会话 / 会话列表 / PATCH / tasks /
// abort / approvals / SSE 订阅。帧用真实 ReadableStream 推送，走真实 SSE 解析路径。

import type { AuthedFetch } from "../../src/penguin/sessions.js";
import { SessionClient } from "../../src/penguin/sessions.js";
import { waitFor } from "./wait.js";

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeSession {
  sessionId: string;
  status: "idle" | "running" | "compacting";
  provider: string | null;
  modelId: string | null;
  workspace: string | null;
  title: string | null;
  /** 最近活跃时间（列表排序依据）；不传时由建会话 / 投递任务自动拨快。 */
  lastActiveAt?: string;
  /** true = 已归档：不出现在 GET 列表里（服务端口径；客户端也会再过滤一次）。 */
  archived?: boolean;
  /** 归属：GET 列表按 (project, agent) 过滤，建会话时从路径登记。 */
  projectId?: string;
  agentId?: string;
}

/** 一段流脚本：帧序列；`{ hang: true }` 表示发完不回包、不断流。 */
export type FrameScript = Array<string | { hang: true }>;

const encoder = new TextEncoder();

export class FakeSessionServer {
  readonly requests: FakeRequest[] = [];
  readonly sessions = new Map<string, FakeSession>();
  readonly approvalCalls: Array<{ sessionId: string; toolCallId: string; decision: string }> = [];
  /** 下一次 startTask 强制返回的 HTTP 状态（用后清除）。 */
  nextTaskStatus: number | null = null;
  /** 下一次 GET 会话列表强制返回的 HTTP 状态（用后清除）。 */
  nextListStatus: number | null = null;
  /** 按 sessionId 脚本化的 SSE 帧；缺省的会话用 defaultScript，再缺省只发快照后挂住。 */
  scripts = new Map<string, FrameScript>();
  /** 所有没有单独脚本的会话共用的帧脚本。 */
  defaultScript: FrameScript | null = null;
  /** 自愈：tasks 返回时把会话 id 换成它（假服务器会自动建好目标会话）。 */
  healTo: string | null = null;
  /** 中断时要往在流里补发的帧（默认：abort 事件 + idle + DONE）。 */
  abortScript: FrameScript | null = null;
  /** 已打开的事件流数量（断言 close 用）。 */
  openStreams = 0;
  private counter = 0;
  /** 假时钟刻度：每次会话活动（建会话 / 投递任务）拨快一分钟，保证 lastActiveAt 有序可比。 */
  private clockTicks = 0;
  /** 在流的事件流控制器（abort 时往里补发帧）。 */
  private readonly controllers = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

  readonly fetchAuthed: AuthedFetch = (path, init) => this.handle(path, init);

  /** 最近一次 tasks 投递的会话 id（测试据此拿到runner 建出来的会话）。 */
  lastTaskSession(): string | null {
    for (let i = this.requests.length - 1; i >= 0; i -= 1) {
      const request = this.requests[i];
      if (request !== undefined && request.method === "POST" && /\/tasks$/.test(request.path)) {
        const match = /^\/sessions\/([^/]+)\/tasks$/.exec(request.path);
        return match?.[1] ?? null;
      }
    }
    return null;
  }

  /** 所有 tasks 投递请求（按时间序）。 */
  taskPosts(): FakeRequest[] {
    return this.requests.filter((r) => r.method === "POST" && /\/tasks$/.test(r.path));
  }

  /** 往一条仍在订阅中的事件流补发一帧（模拟 Run 进行中的事件）。 */
  pushLive(sessionId: string, frame: string): void {
    const controller = this.controllers.get(sessionId);
    if (controller === undefined) throw new Error(`没有 ${sessionId} 的在流`);
    controller.enqueue(encoder.encode(frame));
  }

  private async handle(path: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, body });

    const createMatch = /^\/projects\/([^/]+)\/agents\/([^/]+)\/sessions$/.exec(path);
    if (createMatch && method === "POST") {
      this.counter += 1;
      const sessionId = `session-fake-${this.counter}`;
      const session: FakeSession = {
        sessionId,
        status: "idle",
        provider: typeof body?.provider === "string" ? body.provider : null,
        modelId: typeof body?.modelId === "string" ? body.modelId : null,
        workspace: typeof body?.workspace === "string" ? body.workspace : null,
        title: null,
        projectId: createMatch[1] ?? "",
        agentId: createMatch[2] ?? "",
        lastActiveAt: this.tick(),
      };
      this.sessions.set(sessionId, session);
      return json({ session });
    }

    // 会话列表（ADR-0008）：按 (project, agent) 取，未归档、lastActiveAt 倒序。
    if (createMatch && method === "GET") {
      if (this.nextListStatus !== null) {
        const status = this.nextListStatus;
        this.nextListStatus = null;
        return json({ error: { code: "boom" } }, status);
      }
      const projectId = createMatch[1] ?? "";
      const agentId = createMatch[2] ?? "";
      const sessions = [...this.sessions.values()]
        .filter((s) => s.archived !== true && s.projectId === projectId && s.agentId === agentId)
        .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""))
        .map((s) => ({
          sessionId: s.sessionId,
          title: s.title,
          status: s.status,
          provider: s.provider,
          modelId: s.modelId,
          workspace: s.workspace,
          lastActiveAt: s.lastActiveAt ?? null,
          createdAt: null,
          archived: false,
          source: "user",
          client: "cli",
        }));
      return json({ sessions });
    }

    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch && method === "GET") {
      const session = this.sessions.get(sessionMatch[1] ?? "");
      if (session === undefined) return json({ error: { code: "session_not_found" } }, 404);
      return json({ session });
    }
    if (sessionMatch && method === "PATCH") {
      const session = this.sessions.get(sessionMatch[1] ?? "");
      if (session === undefined) return json({ error: { code: "session_not_found" } }, 404);
      return json({ session });
    }

    const tasksMatch = /^\/sessions\/([^/]+)\/tasks$/.exec(path);
    if (tasksMatch && method === "POST") {
      if (this.nextTaskStatus !== null) {
        const status = this.nextTaskStatus;
        this.nextTaskStatus = null;
        return json({ error: { code: status === 409 ? "task_in_progress" : "boom" } }, status);
      }
      const session = this.sessions.get(tasksMatch[1] ?? "");
      if (session !== undefined) {
        session.status = "running";
        session.lastActiveAt = this.tick();
      }
      if (this.healTo !== null) {
        // 自愈：Trace 丢了，服务端换成新 id；顺手把新会话登记好，后续路由都认。
        const healed = this.healTo;
        if (!this.sessions.has(healed)) {
          this.sessions.set(healed, { ...(session ?? emptySession(healed)), sessionId: healed, status: "running", lastActiveAt: this.tick() });
        }
        return json({ sessionId: healed, queued: false }, 202);
      }
      return json({ sessionId: tasksMatch[1], queued: false }, 202);
    }

    const abortMatch = /^\/sessions\/([^/]+)\/abort$/.exec(path);
    if (abortMatch && method === "POST") {
      const sessionId = abortMatch[1] ?? "";
      const session = this.sessions.get(sessionId);
      const was = session?.status;
      if (session !== undefined) session.status = "idle";
      // 中断后服务端会在流里补发 abort 事件并让会话回 idle
      const frames =
        this.abortScript ?? [
          frame.event({ type: "abort", error_code: "user_abort", error_message: "已被中断" }),
          frame.taskState("idle"),
          frame.done(),
        ];
      const controller = this.controllers.get(sessionId);
      if (controller !== undefined) {
        for (const item of frames) {
          if (typeof item !== "string") continue;
          try {
            controller.enqueue(encoder.encode(item));
          } catch {
            // 流已关闭：没有观众了，不必补发
          }
        }
      }
      return was === "running" || was === "compacting"
        ? new Response(null, { status: 202 })
        : new Response(null, { status: 204 });
    }

    const approvalMatch = /^\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(path);
    if (approvalMatch && method === "POST") {
      if (!this.sessions.has(approvalMatch[1] ?? "")) {
        return json({ error: { code: "approval_not_found" } }, 404);
      }
      this.approvalCalls.push({
        sessionId: approvalMatch[1] ?? "",
        toolCallId: approvalMatch[2] ?? "",
        decision: String(body?.decision ?? ""),
      });
      return new Response(null, { status: 204 });
    }

    const streamMatch = /^\/sessions\/([^/]+)\/stream$/.exec(path);
    if (streamMatch && method === "GET") {
      const sessionId = streamMatch[1] ?? "";
      if (!this.sessions.has(sessionId)) {
        return json({ error: { code: "session_not_found" } }, 404);
      }
      const script =
        this.scripts.get(sessionId) ??
        this.defaultScript ?? [
          `event: server_event\ndata: {"type":"task_state","state":"idle","queued":0}\n\n`,
          { hang: true },
        ];
      return new Response(this.body(script, sessionId), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return json({ error: { code: "not_found", message: `no route ${method} ${path}` } }, 404);
  }

  /**
   * 登记一条会话（列表字段可控：lastActiveAt / archived / 标题 / 模型 / 归属）。
   * 归属缺省算默认 Project/Agent 名下——与建会话路由的默认坐标一致。
   */
  addSession(session: Partial<FakeSession> & { sessionId: string }): FakeSession {
    const full: FakeSession = {
      ...emptySession(session.sessionId),
      projectId: "default_project",
      agentId: "default_agent",
      ...session,
    };
    this.sessions.set(full.sessionId, full);
    return full;
  }

  /** 拨快假时钟一分钟，返回 ISO 时间戳（服务端 lastActiveAt 形态）。 */
  private tick(): string {
    this.clockTicks += 1;
    return new Date(Date.parse("2026-10-22T10:00:00.000Z") + this.clockTicks * 60_000).toISOString();
  }

  /** 脚本 → SSE 响应体；hang 之后流永远不结束（直到 close 或 abort 补发帧）。 */
  private body(script: FrameScript, sessionId: string): ReadableStream<Uint8Array> {
    this.openStreams += 1;
    let index = 0;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controllers.set(sessionId, controller);
      },
      pull: (controller) => {
        const item = script[index];
        index += 1;
        // 不发数据也不 close：模拟长连接（脚本结束或显式 hang）
        if (item === undefined || typeof item !== "string") {
          return new Promise<void>(() => {});
        }
        controller.enqueue(encoder.encode(item));
      },
      cancel: () => {
        this.openStreams -= 1;
        this.controllers.delete(sessionId);
      },
    });
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 等下一次 tasks 投递出现（此刻订阅已就绪），返回会话 id。 */
export async function waitForTask(server: FakeSessionServer): Promise<string> {
  const before = server.taskPosts().length;
  await waitFor(() => server.taskPosts().length > before);
  return server.lastTaskSession() ?? "";
}

/** 测试共用的会话 API 客户端（传输层直接打假服务器）。 */
export function sessionClient(server: FakeSessionServer): SessionClient {
  return new SessionClient({ fetchAuthed: server.fetchAuthed });
}

function emptySession(sessionId: string): FakeSession {
  return { sessionId, status: "idle", provider: null, modelId: null, workspace: null, title: null };
}

/** 常用帧构造函数（测试脚本用）。 */
export const frame = {
  taskState: (state: string, queued = 0): string =>
    `event: server_event\ndata: ${JSON.stringify({ type: "task_state", state, queued })}\n\n`,
  title: (sessionId: string, title: string): string =>
    `event: server_event\ndata: ${JSON.stringify({ type: "session_title", sessionId, title })}\n\n`,
  approval: (toolCallId: string, name: string): string =>
    `event: server_event\ndata: ${JSON.stringify({ type: "approval_request", toolCall: { name, arguments: "{}", tool_call_id: toolCallId } })}\n\n`,
  ping: (): string => "event: ping\ndata: {}\n\n",
  omni: (payload: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ type: "model_msg", ...extra, payload })}\n\n`,
  event: (payload: Record<string, unknown>): string =>
    `data: ${JSON.stringify({ type: "event_msg", payload })}\n\n`,
  done: (): string => "data: [DONE]\n\n",
};
