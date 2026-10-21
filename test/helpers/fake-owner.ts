// 测试共用的假 owner 基类：记录调用。档位测试（tiers.test.ts）在它之上
// 脚本化 projects/agents/models 清单；owner.test.ts 用 fake-owner-server.ts。

import type { OwnerSession } from "../../src/penguin/owner.js";

export interface OwnerCall {
  method: string;
  path: string;
  body: unknown;
}

export class FakeOwnerSession {
  readonly calls: OwnerCall[] = [];

  /** 只取某类调用。 */
  of(method: string): OwnerCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** 当作 OwnerSession 注入（测试只用到子类实现的几个方法）。 */
  get asOwnerSession(): OwnerSession {
    return this as unknown as OwnerSession;
  }
}
