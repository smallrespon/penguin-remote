// runs.jsonl：每次 Run 一行的审计轨迹（chat/session/状态/用量/耗时）。

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface RunLogEntry {
  chatId: string;
  sessionId: string | null;
  status: string;
  usageTotal: number | null;
  requests: number;
  durationMs: number;
  error?: string;
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

  append(entry: RunLogEntry): Promise<void> {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    this.chain = this.chain.then(() => appendFile(this.filePath, line, { mode: 0o600 }));
    return this.chain;
  }
}
