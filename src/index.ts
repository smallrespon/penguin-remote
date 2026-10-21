// Bridge 入口：加载配置（fail-fast）→ 装配各层 → 常驻 → 优雅退出。

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { FeishuChannel } from "./channels/feishu.js";
import { Lanes } from "./lanes.js";
import { Gateway } from "./gateway.js";
import { AmspClient } from "./penguin/amsp.js";
import { AgentSupply } from "./penguin/agents.js";
import { OwnerSession } from "./penguin/owner.js";
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
  const supply = new AgentSupply({
    owner,
    baseUrl: config.amspBaseUrl,
    stateDir: config.stateDir,
    logger,
  });
  const tiers = new TierCommands({ owner, supply, registry, logger });

  const gateway = new Gateway({
    config,
    channel,
    lanes,
    logger,
    registry,
    runLog,
    tiers,
    clientFor: async (agent) => {
      // AMSP_API_KEY 是显式覆盖：设了就不自动铸 key（运维/调试用）。
      if (config.amspApiKey !== null) {
        return new AmspClient({ baseUrl: config.amspBaseUrl, agent, apiKey: config.amspApiKey });
      }
      return supply.clientFor(agent);
    },
  });

  await gateway.start();
  logger.info("Bridge 已启动，等待飞书消息");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`收到 ${signal}，正在退出`);
    await gateway.stop();
    await registry.flush();
    await runLog.flush();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
