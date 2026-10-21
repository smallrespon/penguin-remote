import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";
import { redact } from "../src/logger.js";

const VALID = {
  OWNER_API_BASE_URL: "http://localhost/api",
  DEFAULT_PROJECT_ID: "default_project",
  DEFAULT_AGENT_ID: "default_agent",
};

test("loadConfig 接受最小配置并套用默认值", () => {
  const config = loadConfig({ ...VALID });
  assert.equal(config.ownerApiBaseUrl, "http://localhost/api");
  assert.equal(config.defaultProjectId, "default_project");
  assert.equal(config.defaultAgentId, "default_agent");
  assert.equal(config.stateDir, "state");
  assert.equal(config.penguinBin, "penguin");
  assert.equal(config.larkBin, "lark-cli");
  assert.deepEqual(config.allowlist, []);
  assert.equal(config.logLevel, "info");
  assert.equal(config.ownerTokenTtlSeconds, 3600);
  assert.equal(config.previewThrottleMs, 1500);
  assert.equal(config.previewThrottleChars, 300);
});

test("loadConfig 接受自定义值并去掉基址末尾斜杠", () => {
  const config = loadConfig({
    ...VALID,
    OWNER_API_BASE_URL: "http://localhost:7364/api/",
    STATE_DIR: "/var/lib/penguin-remote",
    ALLOWLIST: " oc_xxx , ou_yyy ",
    LOG_LEVEL: "debug",
    PREVIEW_THROTTLE_MS: "800",
  });
  assert.equal(config.ownerApiBaseUrl, "http://localhost:7364/api");
  assert.deepEqual(config.allowlist, ["oc_xxx", "ou_yyy"]);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.previewThrottleMs, 800);
});

test("loadConfig 缺必需项时一次性列出全部缺失项并以非零语义失败", () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /OWNER_API_BASE_URL/);
      assert.match(error.message, /DEFAULT_PROJECT_ID/);
      assert.match(error.message, /DEFAULT_AGENT_ID/);
      return true;
    },
  );
});

test("loadConfig 拒绝非法值：URL、非法 id、坏数字、坏级别、TTL 不大于余量", () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ ...VALID, OWNER_API_BASE_URL: "not-a-url" }, /不是合法 URL/],
    [{ ...VALID, OWNER_API_BASE_URL: "" }, /OWNER_API_BASE_URL/],
    [{ ...VALID, DEFAULT_AGENT_ID: "bad id!" }, /非法字符/],
    [{ ...VALID, PREVIEW_THROTTLE_MS: "0" }, /正整数/],
    [{ ...VALID, PREVIEW_THROTTLE_MS: "1.5" }, /正整数/],
    [{ ...VALID, LOG_LEVEL: "verbose" }, /LOG_LEVEL/],
    [{ ...VALID, OWNER_TOKEN_TTL_SECONDS: "60", OWNER_TOKEN_REFRESH_MARGIN_SECONDS: "120" }, /大于/],
  ];
  for (const [env, pattern] of cases) {
    assert.throws(() => loadConfig(env), pattern, JSON.stringify(env));
  }
});

test("redact 打码 penguin_ 密钥", () => {
  const secret = `penguin_${"a1b2c3d4e5f6g7h8i9j0"}`;
  const line = `key=${secret} cookie=penguin_session=${secret}`;
  const masked = redact(line);
  assert.ok(!masked.includes(secret));
  assert.match(masked, /penguin_\*\*\*/);
});
