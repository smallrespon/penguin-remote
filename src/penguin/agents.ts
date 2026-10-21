// Agent 与 key 的供给：按聊天懒建专属 Agent、key 只驻内存、登记文件只记归属。
// 命名规范：feishu_<chatId 哈希>（ADR-0002）。

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../logger.js";
import type { AmspClient, AgentRef } from "./amsp.js";
import { AmspClient as AmspClientClass } from "./amsp.js";
import { OwnerError, type OwnerSession } from "./owner.js";

export const DEDICATED_PREFIX = "feishu_";

interface AgentRecord {
  chatId: string;
  keyId: string;
  createdAt: string;
}

interface AgentsFile {
  version: 1;
  agents: Record<string, AgentRecord>;
}

/** 聊天 → 专属 Agent id。同一聊天恒定，便于重启后认领。 */
export function dedicatedAgentId(chatId: string): string {
  const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 12);
  return `${DEDICATED_PREFIX}${hash}`;
}

export function isDedicatedAgent(agentId: string): boolean {
  return agentId.startsWith(DEDICATED_PREFIX);
}

export class AgentSupply {
  private readonly owner: OwnerSession;
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly stateDir: string;
  /** 测试注入的传输层（与 AmspClient 一致）。 */
  private readonly fetchImpl: typeof fetch | undefined;
  /** `<projectId>/<agentId>` → key，只驻内存。 */
  private readonly keys = new Map<string, string>();
  private records: AgentsFile = { version: 1, agents: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: {
    owner: OwnerSession;
    baseUrl: string;
    stateDir: string;
    logger: Logger;
    fetch?: typeof fetch;
  }) {
    this.owner = options.owner;
    this.baseUrl = options.baseUrl;
    this.stateDir = options.stateDir;
    this.logger = options.logger;
    this.fetchImpl = options.fetch;
  }

  private filePath(): string {
    return join(this.stateDir, "agents.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.filePath(), "utf8")) as AgentsFile;
      if (parsed?.version === 1 && typeof parsed.agents === "object" && parsed.agents !== null) {
        this.records = parsed;
      }
    } catch {
      // 缺文件：全新开始（key 需重铸）
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const file = this.filePath();
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(`${file}.tmp`, `${JSON.stringify(this.records, null, 2)}\n`, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    await this.writeChain;
  }

  /** 取某个 Agent 的 AMSP 客户端；没有 key 就先铸一个（只存内存）。 */
  async clientFor(ref: AgentRef): Promise<AmspClient> {
    const key = await this.keyFor(ref);
    return new AmspClientClass({
      baseUrl: this.baseUrl,
      agent: ref,
      apiKey: key,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });
  }

  /** 某个 Agent 的 key：内存有就用，否则铸新的并登记 keyId。 */
  async keyFor(ref: AgentRef): Promise<string> {
    const mapKey = `${ref.projectId}/${ref.agentId}`;
    const cached = this.keys.get(mapKey);
    if (cached !== undefined) return cached;
    const created = await this.owner.createKey(ref.projectId, ref.agentId, "penguin-remote-bridge");
    this.keys.set(mapKey, created.secret);
    await this.ensureLoaded();
    this.records.agents[mapKey] = {
      // 保留既有归属信息（专属 Agent 的 chatId）；只补/换 keyId。
      ...this.records.agents[mapKey],
      chatId: this.records.agents[mapKey]?.chatId ?? "",
      keyId: created.keyId,
      createdAt: new Date().toISOString(),
    };
    await this.persist();
    this.logger.info(`已为 ${mapKey} 铸造 AMSP key（只驻内存）`);
    return created.secret;
  }

  /**
   * 确保某个聊天有专属 Agent：当前绑定还不是 feishu_ 开头的专属 Agent 时，
   * 懒建一个并开启 API、铸 key。返回新建（或既有）的 Agent 坐标。
   */
  async ensureDedicatedAgent(projectId: string, currentAgentId: string, chatId: string): Promise<AgentRef> {
    if (isDedicatedAgent(currentAgentId)) {
      return { projectId, agentId: currentAgentId };
    }
    const agentId = dedicatedAgentId(chatId);
    await this.ensureLoaded();
    if (this.records.agents[`${projectId}/${agentId}`] === undefined) {
      await this.createDedicatedAgent(projectId, agentId, chatId);
      this.records.agents[`${projectId}/${agentId}`] = {
        chatId,
        keyId: "",
        createdAt: new Date().toISOString(),
      };
      await this.persist();
      this.logger.info(`已为聊天懒建专属 Agent ${projectId}/${agentId}`);
    }
    await this.keyFor({ projectId, agentId });
    return { projectId, agentId };
  }

  /** 建 Agent 并开 API（allow-all）；服务端已存在（409）时直接沿用。 */
  private async createDedicatedAgent(projectId: string, agentId: string, chatId: string): Promise<void> {
    try {
      await this.owner.createAgent(projectId, agentId, `Feishu ${chatId.slice(0, 12)}`);
    } catch (error: unknown) {
      // 登记文件丢了但 Agent 还在（重启前后状态不一致）：409 = 已存在，继续用它。
      if (!(error instanceof OwnerError) || error.status !== 409) throw error;
      this.logger.info(`专属 Agent ${projectId}/${agentId} 已存在，直接沿用`);
    }
    await this.owner.putAgentApi(projectId, agentId, { enabled: true, approvalMode: "allow-all" });
  }
}
