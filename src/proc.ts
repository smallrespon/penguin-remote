// 子进程执行：一次性命令（拿 stdout）与长驻子进程（可注入 mock）两类。

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** 跑一个一次性命令，收集输出；超时或启动失败即抛错。 */
export function runCommand(
  bin: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const { input, timeoutMs = 30_000 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${bin} ${args[0] ?? ""} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`无法执行 ${bin}：${error.message}`));
      }
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ status, stdout, stderr });
      }
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** 长驻子进程的最小接口（测试可注入假实现）。 */
export interface ManagedChild {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals): boolean;
  /** 进程退出（或出错）时 resolve。 */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export type SpawnFn = (bin: string, args: string[]) => ManagedChild;

/** 用 node:child_process 实现 ManagedChild。 */
export function spawnManaged(bin: string, args: string[]): ManagedChild {
  const child: ChildProcess = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    stdin: child.stdin,
    kill: (signal) => child.kill(signal),
    exited,
  };
}

/** 逐行读取一个流；每行（不含换行符）回调一次。 */
export function readLines(stream: Readable, onLine: (line: string) => void): void {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("line", (line) => onLine(line));
}
