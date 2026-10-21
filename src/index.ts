// Bridge 入口：加载配置（fail-fast）→ 装配各层 → 常驻 → 优雅退出。

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { FeishuChannel } from "./channels/feishu.js";
import { Lanes } from "./lanes.js";
import { Gateway } from "./gateway.js";
import { AmspClient } from "./penguin/amsp.js";
import { Registry } from "./registry.js";
import { RunLog } from "./runlog.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const channel = new FeishuChannel({ bin: config.larkBin, logger });
  const lanes = new Lanes();
  const registry = await Registry.load(
    config.stateDir,
    { projectId: config.defaultProjectId, agentId: config.defaultAgentId },
  );
  const runLog = await RunLog.load(config.stateDir);

  const gateway = new Gateway({
    config,
    channel,
    lanes,
    logger,
    registry,
    runLog,
    clientFor: async (agent) => {
      const key = config.amspApiKey;
      if (key === null) {
        throw new Error("未配置 AMSP_API_KEY：无法调用 AMSP");
      }
      return new AmspClient({ baseUrl: config.amspBaseUrl, agent, apiKey: key });
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
