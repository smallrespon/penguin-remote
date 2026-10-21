import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runIndex(env: Record<string, string | undefined>): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("冒烟：配置齐全时进程正常退出", () => {
  const result = runIndex({
    AMSP_BASE_URL: "http://localhost/api/amsp/v1",
    DEFAULT_PROJECT_ID: "default_project",
    DEFAULT_AGENT_ID: "default_agent",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /配置就绪/);
});

test("冒烟：缺配置时进程以非零码退出并列出缺失项", () => {
  const result = runIndex({ AMSP_BASE_URL: "", DEFAULT_PROJECT_ID: "", DEFAULT_AGENT_ID: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AMSP_BASE_URL/);
  assert.match(result.stderr, /DEFAULT_PROJECT_ID/);
  assert.match(result.stderr, /DEFAULT_AGENT_ID/);
});
