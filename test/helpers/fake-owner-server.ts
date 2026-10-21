// 测试共用的假 owner HTTP 服务器：按 method+path 返回脚本化响应（路径含 /api 前缀），
// 记录每个请求的方法、路径、cookie 与 body，便于断言令牌与路由形状。

export interface Recorded {
  method: string;
  path: string;
  cookie: string | null;
  body: unknown;
}

export class FakeOwnerServer {
  readonly requests: Recorded[] = [];
  private nextStatus = 200;
  private alwaysStatus: number | null = null;
  private readonly routes: Record<string, unknown>;

  constructor(routes: Record<string, unknown> = {}) {
    this.routes = routes;
  }

  /** 下一次请求强制返回的状态码（用后清除）。 */
  failNextWith(status: number): void {
    this.nextStatus = status;
  }

  /** 之后所有请求都返回该状态码（模拟服务端持续故障）。 */
  failAllWith(status: number): void {
    this.alwaysStatus = status;
  }

  get fetch(): typeof fetch {
    return ((url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
      const headers = new Headers(init?.headers);
      this.requests.push({
        method,
        path: parsed.pathname,
        cookie: headers.get("cookie"),
        body,
      });
      const status = this.nextStatus;
      this.nextStatus = 200;
      if (status !== 200 || this.alwaysStatus !== null) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: "boom", message: "boom" } }), {
            status: this.alwaysStatus ?? status,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      const key = `${method} ${parsed.pathname}`;
      const payload = this.routes[key] ?? {};
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
  }
}
