// Penguin AMSP 客户端：发起 Run、消费 SSE 事件流、查会话、中断。
// 传输层（fetch）可注入，行为可离线测试；官方客户端只负责协议，本模块负责错误语义与清理。

import {
  AgentClient,
  AmspHttpError,
  AmspStreamError,
  type AmspEvent,
  type AmspError,
  type InputItem,
  type SessionInfo,
  type StopReason,
  type TokenCounts,
} from "@prismshadow/amsp";

/** 文档规定的 429 退避：服务器回 `Retry-After: 2`。 */
export const DEFAULT_RETRY_AFTER_MS = 2000;

/** 会话正在执行中（409 task_in_progress / compacting）。 */
export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBusyError";
  }
}

/** Agent 并发已达上限（429 too_many_runs）。 */
export class TooManyRunsError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number = DEFAULT_RETRY_AFTER_MS) {
    super(message);
    this.name = "TooManyRunsError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** 事件流在 run.done 之前断裂；Run 的最终结局未知（断流即中止）。 */
export class RunStreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RunStreamError";
  }
}

export type RunInput = string | InputItem[];
export type ApprovalDecision = "allow" | "deny";

/** 一个 Agent 的坐标。 */
export interface AgentRef {
  projectId: string;
  agentId: string;
}

/** AMSP 路由里的 `<projectId>/<agentId>`。 */
export function agentPath(ref: AgentRef): string {
  return `${ref.projectId}/${ref.agentId}`;
}

export interface AmspRunOutcome {
  sessionId: string;
  status: StopReason;
  text: string;
  error?: AmspError;
  usage: TokenCounts;
  sessionUsage: TokenCounts | null;
  requests: number;
}

export interface StreamRunOptions {
  input: RunInput;
  /** 续接的会话；省略则新建（run.started 返回新 id）。 */
  sessionId?: string;
  signal?: AbortSignal;
  /** 每个 AMSP 事件回调一次（渲染器消费）。 */
  onEvent?: (event: AmspEvent) => void;
  /** approval.requested 的应答；缺省 = deny。 */
  onApproval?: (
    request: AmspEvent & { type: "approval.requested" },
    ctx: { sessionId: string },
  ) => Promise<ApprovalDecision> | ApprovalDecision;
}

/** 一次进行中的 Run。 */
export interface AmspRun {
  readonly sessionId: Promise<string>;
  result(): Promise<AmspRunOutcome>;
  abort(): Promise<void>;
}

export interface AmspClientOptions {
  baseUrl: string;
  /** 目标 Agent。 */
  agent: AgentRef;
  apiKey: string;
  /** 测试注入的传输层。 */
  fetch?: typeof fetch;
}

export class AmspClient {
  private readonly baseUrl: string;
  private readonly agent: AgentRef;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: AmspClientOptions) {
    this.baseUrl = options.baseUrl;
    this.agent = options.agent;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch;
  }

  private client(): AgentClient {
    return new AgentClient({
      baseUrl: this.baseUrl,
      agent: agentPath(this.agent),
      apiKey: this.apiKey,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
  }

  /** 发起一次 Run 并消费事件流。 */
  streamRun(options: StreamRunOptions): AmspRun {
    const client = this.client();
    const run = client.stream({
      input: options.input,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      onApproval: options.onApproval,
    });

    const result = (async (): Promise<AmspRunOutcome> => {
      try {
        if (options.onEvent) {
          for await (const event of run) options.onEvent(event);
        }
        return await run.result();
      } catch (error: unknown) {
        // 断流 = 服务端已中止；仍主动 abort 一次确保连接清理。
        if (error instanceof AmspStreamError) await run.abort().catch(() => {});
        throw mapRunError(error);
      }
    })();

    return {
      sessionId: run.session,
      result: () => result,
      abort: async () => {
        await run.abort();
      },
    };
  }

  async session(sessionId: string): Promise<SessionInfo> {
    return this.client().session(sessionId);
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return this.client().abort(sessionId);
  }
}

function mapRunError(error: unknown): unknown {
  if (error instanceof AmspHttpError) {
    if (error.status === 409) {
      return new SessionBusyError(error.message || "会话正在执行中");
    }
    if (error.status === 429) {
      return new TooManyRunsError(error.message || "Agent 并发已达上限");
    }
  }
  if (error instanceof AmspStreamError) {
    return new RunStreamError(error.message, { cause: error });
  }
  return error;
}
