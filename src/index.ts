// Bridge 入口：加载配置（fail-fast）→ 装配各层 → 常驻 → 优雅退出。

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { FeishuChannel } from "./channels/feishu.js";
import { Lanes } from "./lanes.js";
import { Gateway } from "./gateway.js";
import { OwnerSession } from "./penguin/owner.js";
import { SessionClient } from "./penguin/sessions.js";
import { Registry } from "./registry.js";
import { RunLog } from "./runlog.js";
import { TierCommands } from "./tiers.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const channel = new FeishuChannel({ bin: config.larkBin, logger });
  const lanes = new Lanes();
  const registry = await Registry.load(config.stateDir, {
    projectId: config.defaultProjectId,
    agentId: config.defaultAgentId,
  });
  const runLog = await RunLog.load(config.stateDir);

  const owner = new OwnerSession({
    bin: config.penguinBin,
    baseUrl: config.ownerApiBaseUrl,
    ttlSeconds: config.ownerTokenTtlSeconds,
    refreshMarginSeconds: config.ownerTokenRefreshMarginSeconds,
    logger,
  });
  // 会话 API 与档位清单共用同一条 owner 会话（令牌只驻内存，401 自动重铸重试）。
  const sessions = new SessionClient({
    fetchAuthed: (path, init) => owner.fetchAuthed(path, init),
  });
  const tiers = new TierCommands({
    owner,
    registry,
    logger,
    defaultAgentId: config.defaultAgentId,
  });

  const gateway = new Gateway({
    config,
    channel,
    lanes,
    logger,
    registry,
    runLog,
    sessions,
    tiers,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`收到 ${signal}，正在退出`);
    await gateway.stop();
    await registry.flush();
    await runLog.flush();
    process.exit(0);
  };
  // 先装信号处理再启动：否则启动日志到 handler 注册之间的 SIGTERM 会走默认行为（被信号杀死）。
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await gateway.start();
  logger.info("Bridge 已启动，等待飞书消息");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
