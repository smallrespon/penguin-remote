// Lane：按 chatId 的串行执行，保证一个聊天同时只跑一个 Run。
// 语义：进行中的消息不排队，直接返回「忙」，由调用方回复提示。

export type LaneAttempt<T> = { started: true; value: T } | { started: false };

export class Lanes {
  private readonly busy = new Set<string>();

  isBusy(chatId: string): boolean {
    return this.busy.has(chatId);
  }

  get busyChats(): string[] {
    return [...this.busy];
  }

  /** 尝试占用该聊天的 Lane 并执行任务；已在执行则不开工。 */
  async run<T>(chatId: string, task: () => Promise<T>): Promise<LaneAttempt<T>> {
    if (this.busy.has(chatId)) return { started: false };
    this.busy.add(chatId);
    try {
      const value = await task();
      return { started: true, value };
    } finally {
      this.busy.delete(chatId);
    }
  }
}
