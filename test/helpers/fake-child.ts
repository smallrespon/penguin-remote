import { PassThrough } from "node:stream";
import type { ManagedChild, RunResult, SpawnFn } from "../../src/proc.js";

/** 测试用长驻子进程：可手动灌事件行、可查询 kill 信号。 */
export class FakeChild implements ManagedChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  killedWith: string | undefined = undefined;
  private resolveExited: (value: { code: number | null; signal: string | null }) => void = () => {};
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    this.exit(0, signal ?? null);
    return true;
  }

  exit(code: number, signal: string | null = null): void {
    this.stdout.end();
    this.resolveExited({ code, signal });
  }

  emitEvent(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  emitRaw(line: string): void {
    this.stdout.write(`${line}\n`);
  }
}

export interface FakeSpawn {
  spawn: SpawnFn;
  calls: Array<{ bin: string; args: string[] }>;
  children: FakeChild[];
}

export function makeFakeSpawn(): FakeSpawn {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawn: SpawnFn = (bin, args) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

/** 记录型假 run：按 args 谓词匹配 canned 响应。 */
export function makeFakeRun(
  handlers: Array<{ match: (args: string[]) => boolean; result: RunResult | Error }>,
): { run: (bin: string, args: string[], opts?: { input?: string }) => Promise<RunResult>; calls: string[][] } {
  const calls: string[][] = [];
  const run = (bin: string, args: string[]) => {
    calls.push(args);
    const handler = handlers.find((h) => h.match(args));
    if (handler === undefined) return Promise.reject(new Error(`unexpected command: ${args.join(" ")}`));
    if (handler.result instanceof Error) return Promise.reject(handler.result);
    return Promise.resolve(handler.result);
  };
  return { run, calls };
}
