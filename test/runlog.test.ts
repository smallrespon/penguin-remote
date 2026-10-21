import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RunLog } from "../src/runlog.js";

test("RunLog：每次 Run 追加一行可解析 JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-runlog-"));
  const log = await RunLog.load(dir);
  await log.append({ chatId: "oc_1", sessionId: "s1", status: "completed", usageTotal: 42, requests: 1, durationMs: 1200 });
  await log.append({ chatId: "oc_1", sessionId: null, status: "failed", usageTotal: null, requests: 0, durationMs: 10, error: "boom" });

  const lines = (await readFile(join(dir, "runs.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0] ?? "{}") as { chatId: string; status: string; usageTotal: number; at: string };
  assert.equal(first.chatId, "oc_1");
  assert.equal(first.status, "completed");
  assert.equal(first.usageTotal, 42);
  assert.ok(first.at.length > 0);
  const second = JSON.parse(lines[1] ?? "{}") as { error?: string };
  assert.equal(second.error, "boom");
});
