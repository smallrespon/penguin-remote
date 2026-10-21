// Owner 会话：用 `penguin auth token` 自铸临时人类登录态，调 owner 级路由
// （改 Agent API 设置、建 Agent、铸 key）。令牌只驻内存，过期前重铸，不落盘、不进日志。

import type { Logger } from "../logger.js";
import { runCommand } from "../proc.js";

export interface ProjectInfo {
  projectId: string;
  name?: string;
  role?: string;
}

export interface AgentInfo {
  agentId: string;
  name?: string;
  description?: string;
  apiEnabled?: boolean;
}

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName?: string;
  isDefault?: boolean;
}

/** 一个模型引用（`provider` + `modelId`）。 */
export interface ModelRef {
  provider: string;
  modelId: string;
}

/** 一个 Project 的可用模型清单 + 它的默认模型。 */
export interface ModelCatalog {
  models: ModelInfo[];
  /** Project 配置里的默认模型；没有则 null。 */
  defaultModel: ModelRef | null;
}

export interface AgentApiSettings {
  enabled: boolean;
  open: boolean;
  approvalMode: "allow-all" | "deny-all" | "read-only" | "always-ask";
  model: { provider: string; modelId: string } | null;
  thinkingLevel: "none" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  workspace: string | null;
  maxConcurrentRuns: number;
}

export interface AgentApiResponse {
  api: AgentApiSettings;
  serverEnabled: boolean;
}

export interface CreatedKey {
  keyId: string;
  secret: string;
}

export interface OwnerSessionOptions {
  /** penguin 可执行文件。 */
  bin: string;
  /** owner 路由基址，如 http://localhost/api。 */
  baseUrl: string;
  ttlSeconds: number;
  /** 提前多少秒重铸。 */
  refreshMarginSeconds: number;
  logger: Logger;
  /** 测试注入。 */
  run?: typeof runCommand;
  fetch?: typeof fetch;
  now?: () => number;
}

const TOKEN_MARKER = "---penguin-auth-token---";

/** owner 路由失败（含重铸后仍失败）。 */
export class OwnerError extends Error {
  /** HTTP 状态码；铸造令牌失败等非 HTTP 场景为 null。 */
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "OwnerError";
    this.status = status;
  }
}

export class OwnerSession {
  private readonly bin: string;
  private readonly baseUrl: string;
  private readonly ttlSeconds: number;
  private readonly refreshMarginSeconds: number;
  private readonly logger: Logger;
  private readonly run: typeof runCommand;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private currentToken: string | null = null;
  private expiresAt = 0;
  private minting: Promise<string> | null = null;

  constructor(options: OwnerSessionOptions) {
    this.bin = options.bin;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.ttlSeconds = options.ttlSeconds;
    this.refreshMarginSeconds = options.refreshMarginSeconds;
    this.logger = options.logger;
    this.run = options.run ?? runCommand;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** 当前可用的 owner 令牌；过期前自动重铸。 */
  async token(): Promise<string> {
    if (this.currentToken !== null && this.now() < this.expiresAt) return this.currentToken;
    this.minting ??= this.mint();
    try {
      return await this.minting;
    } finally {
      this.minting = null;
    }
  }

  /** 丢弃当前令牌（401 时调用），下次 token() 重铸。 */
  invalidate(): void {
    this.currentToken = null;
    this.expiresAt = 0;
  }

  private async mint(): Promise<string> {
    const result = await this.run(this.bin, [
      "auth",
      "token",
      "--mark",
      "--ttl-seconds",
      String(this.ttlSeconds),
    ]);
    const token = parseToken(result.stdout);
    if (result.status !== 0 || token === null) {
      throw new OwnerError(
        `铸造 owner 令牌失败（penguin exit=${result.status}）：${result.stderr.trim() || "未拿到令牌"}`,
      );
    }
    this.currentToken = token;
    this.expiresAt = this.now() + (this.ttlSeconds - this.refreshMarginSeconds) * 1000;
    this.logger.info("owner 会话令牌已铸造（只驻内存）");
    return token;
  }

  /** 带 cookie 调一条 owner 路由；401 时重铸一次再试。 */
  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const send = async (token: string): Promise<Response> =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          Cookie: `penguin_session=${token}`,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });

    let response = await send(await this.token());
    if (response.status === 401) {
      this.invalidate();
      response = await send(await this.token());
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new OwnerError(
        `owner 路由 ${path} 失败：HTTP ${response.status} ${detail.slice(0, 200)}`,
        response.status,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const data = await this.request<{ projects?: ProjectInfo[] }>("/projects");
    return data.projects ?? [];
  }

  async listAgents(projectId: string): Promise<AgentInfo[]> {
    const data = await this.request<{ agents?: AgentInfo[] }>(
      `/projects/${encodeURIComponent(projectId)}/agents`,
    );
    return data.agents ?? [];
  }

  async listModels(projectId: string): Promise<ModelCatalog> {
    const data = await this.request<{ models?: ModelInfo[]; defaultModel?: ModelRef }>(
      `/projects/${encodeURIComponent(projectId)}/models`,
    );
    return { models: data.models ?? [], defaultModel: data.defaultModel ?? null };
  }

  async getAgentApi(projectId: string, agentId: string): Promise<AgentApiResponse> {
    return this.request<AgentApiResponse>(
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/api`,
    );
  }

  async putAgentApi(
    projectId: string,
    agentId: string,
    patch: {
      enabled?: boolean;
      approvalMode?: string;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: string | null;
      workspace?: string | null;
      maxConcurrentRuns?: number;
    },
  ): Promise<AgentApiResponse> {
    return this.request<AgentApiResponse>(
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/api`,
      { method: "PUT", body: patch },
    );
  }

  async createAgent(projectId: string, agentId: string, name: string): Promise<void> {
    await this.request(`/projects/${encodeURIComponent(projectId)}/agents`, {
      method: "POST",
      body: { agentId, name },
    });
  }

  /** 铸一个 Agent 的 AMSP key；响应是 `{ key: { keyId, ... }, secret }`，只取这两个字段。 */
  async createKey(projectId: string, agentId: string, name: string): Promise<CreatedKey> {
    const data = await this.request<{ key?: { keyId?: string }; secret?: string }>(
      `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}/api/keys`,
      { method: "POST", body: { name } },
    );
    const keyId = data.key?.keyId;
    if (typeof keyId !== "string" || typeof data.secret !== "string") {
      throw new OwnerError("铸造 key 失败：响应里没有 keyId / secret");
    }
    return { keyId, secret: data.secret };
  }
}

/** 从 `penguin auth token --mark` 的输出里取令牌（标记行的下一行）。 */
export function parseToken(stdout: string): string | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const marker = lines.indexOf(TOKEN_MARKER);
  if (marker >= 0 && marker + 1 < lines.length) return lines[marker + 1] ?? null;
  return lines.at(-1) ?? null;
}
