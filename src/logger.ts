// 日志：级别过滤 + 密钥打码。Agent API key（penguin_…）与 owner 会话令牌绝不进日志。

import type { LogLevel } from "./config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 把 `penguin_…` 形态的密钥打码，日志与异常消息共用。 */
export function redact(text: string): string {
  return text.replace(/penguin_[A-Za-z0-9_-]{4,}/g, "penguin_***");
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(bindings: Record<string, string>): Logger;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = console.log): Logger {
  const threshold = LEVELS[level];
  const write = (lvl: LogLevel, message: string, prefix: string): void => {
    if (LEVELS[lvl] < threshold) return;
    sink(`${prefix}${lvl.toUpperCase()} ${redact(message)}`);
  };
  const make = (prefix: string): Logger => ({
    debug: (m) => write("debug", m, prefix),
    info: (m) => write("info", m, prefix),
    warn: (m) => write("warn", m, prefix),
    error: (m) => write("error", m, prefix),
    child: (bindings) =>
      make(`${prefix}[${Object.entries(bindings).map(([k, v]) => `${k}=${redact(v)}`).join(" ")}] `),
  });
  return make("");
}
