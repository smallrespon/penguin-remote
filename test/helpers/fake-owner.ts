// 测试共用的假 owner：脚本化 projects/agents/models/api/keys 路由，记录所有调用。
// 各测试只覆盖自己关心的字段（见 agents.test.ts / tiers.test.ts / owner.test.ts）。

import { OwnerError, type OwnerSession } from "../../src/penguin/owner.js";

export interface OwnerCall {
  method: string;
  path: string;
  body: unknown;
}

export class FakeOwnerSession {
  readonly calls: OwnerCall[] = [];
  /** 让 createAgent 抛出（模拟 409 已存在 / 其他错误）。 */
  failCreateWith: Error | null = null;
  /** 让 getAgentApi 失败（模拟 server 侧读取失败）。 */
  failGet = false;
  /** getAgentApi 返回的设置（测试可覆盖 model / thinkingLevel / workspace）。 */
  api: Record<string, unknown> = { model: null, thinkingLevel: null, workspace: null };
  /** 按 agentId 覆盖审批模式（默认 allow-all）。 */
  approvalModes: Record<string, string> = {};
  /** 覆盖 API 开关（默认开启）。 */
  apiEnabled = true;
  private keySeq = 0;

  async createAgent(projectId: string, agentId: string, name: string): Promise<void> {
    if (this.failCreateWith !== null) throw this.failCreateWith;
    this.calls.push({ method: "POST /agents", path: `${projectId}/${agentId}`, body: { name } });
  }

  async putAgentApi(projectId: string, agentId: string, patch: unknown): Promise<unknown> {
    this.calls.push({ method: "PUT /api", path: `${projectId}/${agentId}`, body: patch });
    return { api: patch, serverEnabled: true };
  }

  async createKey(projectId: string, agentId: string, name: string) {
    this.keySeq += 1;
    this.calls.push({ method: "POST /keys", path: `${projectId}/${agentId}`, body: { name } });
    return { keyId: `key_${this.keySeq}`, secret: `penguin_secret_${this.keySeq}` };
  }

  async getAgentApi(projectId: string, agentId: string) {
    if (this.failGet) throw new Error("boom");
    return {
      api: {
        model: null,
        thinkingLevel: null,
        workspace: null,
        approvalMode: this.approvalModes[agentId] ?? "allow-all",
        enabled: this.apiEnabled,
        // 测试可按需覆盖其中任意一项
        ...this.api,
      },
      serverEnabled: true,
    };
  }

  /** 只取某类调用。 */
  of(method: string): OwnerCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** 当作 OwnerSession 注入（测试只用到上面几个方法）。 */
  get asOwnerSession(): OwnerSession {
    return this as unknown as OwnerSession;
  }
}

export { OwnerError };
