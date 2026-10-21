// Bridge 入口：加载配置（fail-fast）→ 装配各层 → 常驻 → 优雅退出。

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { FeishuChannel } from "./channels/feishu.js";
import { LaneQueue } from "./lanes.js";
import { Gateway } from "./gateway.js";
import { AmspClient } from "./penguin/amsp.js";
import { Registry } from "./registry.js";
import { RunLog } from "./runlog.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const channel = new FeishuChannel({ bin: config.larkBin, logger });
  const lanes = new LaneQueue();
  const registry = await Registry.load(
    config.stateDir,
    { projectId: config.defaultProjectId, agentId: config.defaultAgentId },
  );
  const runLog = await RunLog.load(config.stateDir);
  // T4/T5：key 来自环境变量；T7 起改为按需懒建专属 Agent 并铸 key（只驻内存）。
  const envKey = process.env.AMSP_API_KEY?.trim() ?? "";

  const gateway = new Gateway({
    config,
    channel,
    lanes,
    logger,
    registry,
    runLog,
    clientFor: async ({ projectId, agentId }) => {
      if (envKey === "") {
        throw new Error("未配置 AMSP_API_KEY：无法调用 AMSP（T7 起支持自动铸 key）");
      }
      return new AmspClient({
        baseUrl: config.amspBaseUrl,
        agent: `${projectId}/${agentId}`,
        apiKey: envKey,
      });
    },
  });

  await gateway.start();
  logger.info("Bridge 已启动，等待飞书消息");

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`收到 ${signal}，正在退出`);
    await gateway.stop();
    await registry.flush();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
