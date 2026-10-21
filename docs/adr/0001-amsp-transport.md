# 传输层选 AMSP HTTP/SSE，而不是包装 `penguin run` CLI

Bridge 直接以 HTTP 客户端调 PenguinHarness 的 AMSP（`/api/amsp/v1`），飞书侧用 lark-cli 子进程；不包装 `penguin run` CLI 作为运输层。AMSP 是官方给外部程序设计的入口：有流式事件、有 abort、有审批、有会话续接，且跨机部署只需要 Base URL + per-agent key。`penguin run --server` 虽能逐次指定 model/thinking/workspace，但阻塞到任务结束、无流式、审批只能整体 allow-all，远程场景还要管 SSH 与登录态。

**Status**: accepted (2026-10-21)

**Considered Options**:
- 包装 `penguin run --server` CLI：逐次参数覆盖最方便，但无流式、无 abort、审批粒度粗；保留为 v2 备选运输层。
- 直连 server 内部 API：非公开契约，版本升级易碎，否掉。

**Consequences**: 断流即中止 Run（客户端断开 = 中止），Bridge 崩溃会杀掉在途 Run，用 Registry + `/use` 续聊兜底。
