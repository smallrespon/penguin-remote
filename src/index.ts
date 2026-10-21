// Bridge 入口：加载配置（fail-fast）→ 装配各层 → 常驻 → 优雅退出。
// 各层的装配随 ticket 推进逐步补全。

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  logger.info(
    `配置就绪：AMSP ${config.amspBaseUrl}，默认 Agent ${config.defaultProjectId}/${config.defaultAgentId}`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
