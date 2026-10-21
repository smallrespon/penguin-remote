import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const VALID_ENV = {
  AMSP_BASE_URL: "http://localhost/api/amsp/v1",
  DEFAULT_PROJECT_ID: "default_project",
  DEFAULT_AGENT_ID: "default_agent",
};

/** 真实 lark-cli 冒烟只在装有 lark-cli 的机器上跑；CI 镜像里没有它，跳过。 */
const larkCliReady = spawnSync("lark-cli", ["--version"], { stdio: "ignore" }).error === undefined;

test("冒烟：缺配置时进程以非零码退出并列出全部缺失项", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, AMSP_BASE_URL: "", DEFAULT_PROJECT_ID: "", DEFAULT_AGENT_ID: "" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AMSP_BASE_URL/);
  assert.match(result.stderr, /DEFAULT_PROJECT_ID/);
  assert.match(result.stderr, /DEFAULT_AGENT_ID/);
});

test("冒烟：配置齐全时进程启动、收到 SIGTERM 干净退出（真实 lark-cli consume）", { skip: larkCliReady ? false : "环境里没有 lark-cli" }, async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...VALID_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const started = await waitForLine(child, "Bridge 已启动", 30_000);
  assert.ok(started, `进程未启动：${stderr}`);
  child.kill("SIGTERM");
  const code = await waitForExit(child, 15_000);
  assert.equal(code, 0, `退出码 ${code}，stderr: ${stderr}`);
});

function waitForLine(child: ChildProcess, needle: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        cleanup();
        resolve(true);
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
    };
    child.stdout?.on("data", onData);
    child.on("exit", () => {
      cleanup();
      resolve(false);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}
