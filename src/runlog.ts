// runs.jsonl：每次 Run 一行的审计轨迹（chat/session/状态/用量/耗时）。

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunReport } from "./penguin/runner.js";

/** 落盘的一行 = RunReport + 时间戳。 */
export interface RunLogRecord extends RunReport {
  at: string;
}

export class RunLog {
  private readonly filePath: string;
  private chain: Promise<void> = Promise.resolve();

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async load(stateDir: string): Promise<RunLog> {
    await mkdir(stateDir, { recursive: true });
    return new RunLog(join(stateDir, "runs.jsonl"));
  }

  /** 追加一行；同一进程内串行写，避免交错。 */
  append(report: RunReport): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...report })}\n`;
    this.chain = this.chain.then(() => appendFile(this.filePath, line, { mode: 0o600 }));
    return this.chain;
  }

  /** 等未落盘的尾行写完（优雅退出时用）。 */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** 某个聊天最近一次 Run 的记录（/status 的「上次用量」）；没有则 null。 */
  async lastFor(chatId: string): Promise<RunLogRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return null;
    }
    for (const line of raw.trim().split("\n").reverse()) {
      if (line === "") continue;
      try {
        const record = JSON.parse(line) as RunLogRecord;
        if (record.chatId === chatId) return record;
      } catch {
        // 跳过坏行
      }
    }
    return null;
  }
}
