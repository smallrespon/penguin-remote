// Registry：聊天绑定的持久化登记处（state/bindings.json），Bridge 重启后恢复的唯一事实来源。
// 原子写（tmp + rename）；密钥不进本文件。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** /sessions 最多列几条。 */
export const HISTORY_LIMIT = 10;

export interface SessionRecord {
  sessionId: string;
  title: string;
  at: string;
}

export interface Binding {
  projectId: string;
  agentId: string;
  /** 当前续接的会话；null = 下一条消息新建。 */
  sessionId: string | null;
  /** 一次性 skill（下一条消息消费后清空）。 */
  skill: string | null;
  /** 粘滞 skill（/skill off 才清空）。 */
  skillSticky: string | null;
  history: SessionRecord[];
  updatedAt: string;
}

interface RegistryData {
  version: 1;
  bindings: Record<string, Binding>;
}

export interface RegistryDefaults {
  projectId: string;
  agentId: string;
}

function emptyBinding(defaults: RegistryDefaults, at: string): Binding {
  return {
    projectId: defaults.projectId,
    agentId: defaults.agentId,
    sessionId: null,
    skill: null,
    skillSticky: null,
    history: [],
    updatedAt: at,
  };
}

export class Registry {
  private readonly filePath: string;
  private readonly defaults: RegistryDefaults;
  private readonly now: () => Date;
  private data: RegistryData;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, data: RegistryData, defaults: RegistryDefaults, now: () => Date) {
    this.filePath = filePath;
    this.data = data;
    this.defaults = defaults;
    this.now = now;
  }

  /** 加载（缺文件或损坏 = 全新）；目录不存在则创建。 */
  static async load(
    stateDir: string,
    defaults: RegistryDefaults,
    now: () => Date = () => new Date(),
  ): Promise<Registry> {
    const filePath = join(stateDir, "bindings.json");
    await mkdir(stateDir, { recursive: true });
    let data: RegistryData = { version: 1, bindings: {} };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as RegistryData;
      if (parsed?.version === 1 && typeof parsed.bindings === "object" && parsed.bindings !== null) {
        data = parsed;
      }
    } catch {
      // 缺文件或损坏：从全新开始（服务端会话仍在，只是列表丢了）。
    }
    return new Registry(filePath, data, defaults, now);
  }

  get(chatId: string): Binding | undefined {
    return this.data.bindings[chatId];
  }

  /** 取绑定，不存在则按默认档位建一个（未落盘，直到首次 update）。 */
  bindingFor(chatId: string): Binding {
    const existing = this.data.bindings[chatId];
    if (existing !== undefined) return existing;
    const created = emptyBinding(this.defaults, this.now().toISOString());
    this.data.bindings[chatId] = created;
    return created;
  }

  /** 改一个聊天的绑定并原子落盘。 */
  async update(chatId: string, mutate: (binding: Binding) => void): Promise<void> {
    const binding = this.bindingFor(chatId);
    mutate(binding);
    binding.updatedAt = this.now().toISOString();
    await this.persist();
  }

  /** 记录一次新会话：写入历史（去重、置顶、限量）并设为当前会话。 */
  async noteSession(chatId: string, record: { sessionId: string; title: string }): Promise<void> {
    const at = this.now().toISOString();
    await this.update(chatId, (binding) => {
      binding.sessionId = record.sessionId;
      binding.history = [
        { sessionId: record.sessionId, title: record.title, at },
        ...binding.history.filter((item) => item.sessionId !== record.sessionId),
      ].slice(0, HISTORY_LIMIT);
    });
  }

  /** 立即落盘（优雅退出时用）。 */
  async flush(): Promise<void> {
    await this.persist();
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
