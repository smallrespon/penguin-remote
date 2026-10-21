# penguin_remote

飞书聊天 ⇄ PenguinHarness Agent 的桥接域：一个常驻 Bridge 把飞书消息转成 Agent Run，并把 Run 的过程与结果流回飞书。

## Language

### Bridge 架构

**Bridge**:
常驻的单进程 Node 程序，飞书消息的唯一入口与 PenguinHarness 的唯一驱动者，掌握全部运行时状态。
_Avoid_: 网关（gateway）、bot、机器人（指飞书应用本身）

**Channel 适配器**:
Bridge 与外部 IM 之间的协议转换接口（发送消息、编辑消息、接收消息事件）；v1 唯一实现是 Feishu 适配器，未来加其他平台不动内核。
_Avoid_: 渠道插件、connector

**Feishu 适配器**:
基于 lark-cli 子进程的 Channel 适配器实现：两条 `event consume` 事件流入，`messages-send` / `messages-edit` 出。
_Avoid_: 飞书通道、lark adapter

**Lane**:
按 chatId 划分的串行执行队列，保证一个聊天同时只跑一个 Run。
_Avoid_: 队列（queue）、锁

**Registry**:
聊天绑定的持久化登记处（`state/bindings.json`），Bridge 重启后恢复绑定的唯一事实来源。
_Avoid_: 缓存、session store、数据库

**绑定（Binding）**:
某个飞书聊天当前生效的 (project, agent, session, skill) 组合，记录在 Registry 中。
_Avoid_: 配置、profile（见 ADR-0002，Profile 是被否决的备选方案）

### PenguinHarness 侧

**Run**:
PenguinHarness 中一次 Agent 执行：由 AMSP runs 路由发起，以 SSE 事件流推进，直到 `run.done`。
_Avoid_: 任务（task）、job

**会话（Session）**:
PenguinHarness 侧的对话上下文容器，多个 Run 可续接同一 Session；同一 Session 同时只跑一个 Run。
_Avoid_: chat、conversation（那些指飞书侧的聊天）

**AMSP**:
PenguinHarness 的 Agent API（`/api/amsp/v1`），位于 cookie 认证网关之前，用 per-agent key 认证，提供 runs / 会话查询 / abort / approvals。
_Avoid_: API、REST API（太泛）

**Owner 会话**:
Bridge 用 `penguin auth token` 自铸的临时人类登录态，用于调用 owner 级路由（改 Agent API 设置、建 Agent、铸 key）；只驻内存，过期前重铸。
_Avoid_: 登录态、admin token、管理员令牌

**专属 Agent**:
Bridge 为某个聊天懒建的 PenguinHarness Agent（命名 `feishu_<chatId 哈希>`），让该聊天的档位切换只影响自己，隔离 Agent 级设置的全局副作用。
_Avoid_: 私有 Agent、per-chat Agent、临时 Agent

**档位**:
模型 / 思考程度 / 工作区三项 Agent 级设置的合称；只对之后新建的会话生效。
_Avoid_: 配置项、参数、设置

### 飞书侧

**流式预览**:
用一条占位消息加节流 `messages-edit` 实现的渐进显示效果。
_Avoid_: streaming（那个指 AMSP 事件流）、打字机效果

**审批**:
工具执行前请求人类决策的机制；v1 运行在 allow-all 模式，不产生审批请求（见 ADR-0004）。
_Avoid_: 确认（confirm）、授权

### 安全与策略

**allowlist**:
允许与机器人对话的 chat_id / open_id 清单。已决定为空（开放访问），仅作为配置项保留，想收紧时填入即可。
_Avoid_: 白名单、黑名单
