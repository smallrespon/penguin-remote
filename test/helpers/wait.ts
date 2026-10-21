// 测试共用的等待助手：等一个条件成立（轮询），超时报错。

export function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("waitFor timeout"));
      else setTimeout(tick, 5);
    };
    tick();
  });
}
