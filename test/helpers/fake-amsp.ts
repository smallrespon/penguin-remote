// 测试用假 AMSP 服务器：模拟 runs / abort / session / approvals 路由与 SSE 事件流。
// 通过 AgentClientOptions.fetch 注入，因此官方客户端本身参与测试。

import type { AmspEvent } from "@prismshadow/amsp";

interface FakeRun {
  sessionId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

export type { FakeRun };

export interface FakeRequest {
  method: string;
  path: string;
  body: unknown;
}

const encoder = new TextEncoder();
const BASE = "http://amsp.test/api/amsp/v1";

export class FakeAmspServer {
  readonly requests: FakeRequest[] = [];
  readonly runs: FakeRun[] = [];
  readonly approvalCalls: Array<{ sessionId: string; toolCallId: string; decision: string }> = [];
  /** 下一次 runs 请求强制返回的 HTTP 错误（status + envelope body），用后清除。 */
  nextError: { status: number; body: unknown } | null = null;
  /** 手动让某条流断裂（不发送 run.done 直接 close/error）。 */
  breakNextStream = false;

  get baseUrl(): string {
    return BASE;
  }

  get fetch(): typeof fetch {
    return ((url: string, init?: RequestInit) => this.handle(url, init)) as typeof fetch;
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    // 客户端会把 baseUrl 拼在路径前，这里剥掉再匹配路由。
    const path = parsed.pathname.replace(/^\/api\/amsp\/v1/, "");
    this.requests.push({ method, path, body });

    const runsMatch = /^\/agents\/[^/]+\/[^/]+\/runs$/.exec(path);
    if (runsMatch && method === "POST") {
      if (this.nextError !== null) {
        const { status, body: errorBody } = this.nextError;
        this.nextError = null;
        return jsonResponse(status, errorBody);
      }
      return this.openStream(body as { session_id?: string });
    }
    const abortMatch = /^\/sessions\/([^/]+)\/abort$/.exec(path);
    if (abortMatch && method === "POST") {
      const run = this.runs.find((r) => r.sessionId === abortMatch[1]);
      if (run && !run.closed) {
        this.push(run, {
          type: "run.done",
          at: new Date().toISOString(),
          status: "aborted",
          error: { code: "user_abort", message: "aborted by test" },
          requests: 1,
          usage: { cache_read: 0, cache_write: 0, output: 0, total: 0 },
          session_usage: null,
        } satisfies AmspEvent);
        this.close(run);
      }
      return new Response(null, { status: 202 });
    }
    const approvalMatch = /^\/sessions\/([^/]+)\/approvals\/([^/]+)$/.exec(path);
    if (approvalMatch && method === "POST") {
      this.approvalCalls.push({
        sessionId: approvalMatch[1] ?? "",
        toolCallId: approvalMatch[2] ?? "",
        decision: (body as { decision?: string })?.decision ?? "",
      });
      return new Response(null, { status: 204 });
    }
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch && method === "GET") {
      return jsonResponse(200, {
        session: {
          id: sessionMatch[1],
          agent: "default_project/default_agent",
          status: "idle",
          provider: "stepfun",
          model_id: "step-3",
          created_at: new Date().toISOString(),
          last_active_at: new Date().toISOString(),
        },
      });
    }
    return jsonResponse(404, { error: { code: "not_found", message: `no route: ${path}` } });
  }

  private openStream(body: { session_id?: string } | undefined): Response {
    const sessionId = body?.session_id ?? `session-test-${this.runs.length + 1}`;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const run: FakeRun = { sessionId, controller, closed: false };
    this.runs.push(run);
    this.push(run, { type: "run.started", at: new Date().toISOString(), session_id: sessionId, agent: "default_project/default_agent" } satisfies AmspEvent);
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  push(run: FakeRun, event: AmspEvent): void {
    if (run.closed) throw new Error("stream already closed");
    run.controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  close(run: FakeRun): void {
    if (run.closed) return;
    run.closed = true;
    run.controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    run.controller.close();
  }

  /** 断裂流：不发 run.done，直接以错误结束（模拟连接中断）。 */
  breakStream(run: FakeRun): void {
    if (run.closed) return;
    run.closed = true;
    run.controller.error(new Error("connection reset by test"));
  }

  lastRun(): FakeRun {
    const run = this.runs.at(-1);
    if (run === undefined) throw new Error("no run started");
    return run;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---- 事件构造助手 ----

export function textDelta(text: string): AmspEvent {
  return { type: "text.delta", at: new Date().toISOString(), role: "assistant", text };
}

export function thinkingDelta(thinking: string): AmspEvent {
  return { type: "thinking.delta", at: new Date().toISOString(), thinking };
}

export function toolCallDone(toolCallId: string, name: string, args = "{}"): AmspEvent {
  return {
    type: "tool_call.done",
    at: new Date().toISOString(),
    tool_call_id: toolCallId,
    name,
    arguments: args,
    stop_reason: "completed",
  };
}

export function toolResultDone(toolCallId: string, output: string): AmspEvent {
  return {
    type: "tool_result.done",
    at: new Date().toISOString(),
    tool_call_id: toolCallId,
    output,
    stop_reason: "completed",
  };
}

export function runDone(status: "completed" | "aborted" | "fatal" = "completed"): AmspEvent {
  return {
    type: "run.done",
    at: new Date().toISOString(),
    status,
    requests: 1,
    usage: { cache_read: 0, cache_write: 0, output: 42, total: 42 },
    session_usage: { cache_read: 0, cache_write: 0, output: 42, total: 42 },
  };
}
