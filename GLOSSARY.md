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
基于 lark-cli 子进程的 Channel 适配器实现：两条 `event consume` 事件流入；出口是 `messages-send`（文本与交互卡片）与 `im messages patch`（更新 Run 回复卡片）——`messages-edit` 只剩文本兜底路径在用（卡片发送失败时的降级链路，见 ADR-0006）；入站图片二进制经 `im +messages-resources-download` 下载（见 ADR-0009）。
_Avoid_: 飞书通道、lark adapter

**Lane**:
按 chatId 划分的串行执行队列，保证一个聊天同时只跑一个 Run。
_Avoid_: 队列（queue）、锁

**Registry**:
聊天绑定的持久化登记处（`state/bindings.json`），Bridge 重启后恢复绑定的唯一事实来源。
_Avoid_: 缓存、session store、数据库

**绑定（Binding）**:
某个飞书聊天当前生效的 (project, agent, session, skill) 组合与档位（模型 / 思考 / 工作区），记录在 Registry 中；档位只在这个聊天内生效，互不污染。
_Avoid_: 配置、profile（见 ADR-0002，Profile 是被否决的备选方案）

### PenguinHarness 侧

**Run**:
PenguinHarness 中一次 Agent 执行：由会话 API 的 tasks 路由发起（`POST /api/sessions/:id/tasks`），以该会话的 SSE 事件流推进，直到会话回到 idle。
_Avoid_: 任务（task）、job

**会话（Session）**:
PenguinHarness 侧的对话上下文容器，多个 Run 可续接同一 Session；同一 Session 同时只跑一个 Run。按来源分 `user`（普通会话，`penguin chat` 与人聊出来的）与 `api` / `cli` 等程序会话——后者被服务端按规则归档，不出现在侧栏（见 ADR-0005）。
_Avoid_: chat、conversation（那些指飞书侧的聊天）

**会话 API**:
PenguinHarness 以人类登录态（cookie）驱动的 HTTP 面：`/api/projects/:p/agents/:a/sessions` 建会话、`/api/sessions/:id/*` 做投递 / 中止 / 审批 / 查询；同一路由的 GET 还提供按 Agent 的会话列表（未归档过滤在客户端做，见 ADR-0008）。Bridge 自 ADR-0005 起只走这一面，建出来的都是普通会话，不归档。
_Avoid_: 用户 API、web API

**AMSP**:
PenguinHarness 的 Agent API（`/api/amsp/v1`），位于 cookie 认证网关之前，用 per-agent key 认证。ADR-0005 之前 Bridge 的传输层；现在不再使用（它建的会话按规则归档，且拒绝续接非自建会话）。
_Avoid_: API、REST API（太泛）

**Owner 会话**:
Bridge 用 `penguin auth token` 自铸的临时人类登录态：owner 级路由（列 Project / Agent / 模型）与会话 API 都用它，只驻内存，过期前重铸。
_Avoid_: 登录态、admin token、管理员令牌

**档位**:
模型 / 思考程度 / 工作区三项设置的合称，按聊天存放在 binding 里，只对该聊天之后新建的会话生效（见 ADR-0005）。
_Avoid_: 配置项、参数、设置

### 飞书侧

**回复卡片**:
Run 回复的承载形态：一张飞书交互卡片（Card 2.0），header 放状态文案（🦐 思考中… / 🦐 执行中… / ⏳ 请稍候 / ✅ 完成 / ❌ 未正常完成），内容是按 Run 真实时序排列的回复分区——思考与工具调用收进默认收起的折叠面板、正文永远展开，页脚是分割线 + 用量行；预览与定稿经 `im messages patch` 更新同一张卡，会话忙（409）与 Run 级失败也 patch 同一张占位卡（忙卡 / 错误卡），不另发消息（见 ADR-0006、ADR-0007）。
_Avoid_: 消息卡片、卡片消息（指飞书卡片形态本身，不特指 Run 回复）

**折叠面板**:
回复卡片里默认收起、点击展开的 `collapsible_panel` 元素；每个工具调用与每段思考各占一个，标题行带状态标识（运行中… / 运行完毕）与耗时，展开后是参数与 output 或思考全文（见 ADR-0006、ADR-0007）。连续的思考与工具调用还会被收进外层的「步骤分组」面板（见 ADR-0010）。
_Avoid_: 折叠块、collapsible、手风琴

**步骤分组**:
回复卡片里把连续的思考与工具调用分区合并成的外层折叠面板，标题形如「🧰 运行完毕 · N 步 · X.Xs」；组内每一步各是一个嵌套折叠面板，点开分组再点开某一步才看到详情。正文与提示行打断分组。超预算时整组丢弃（见 ADR-0010）。
_Avoid_: 分组折叠、步骤块

**流式预览**:
用一张占位交互卡片加节流 `im messages patch` 更新实现的渐进显示效果；预览与定稿是同一张卡（见 ADR-0006）。
_Avoid_: streaming（那个指会话 SSE 事件流）、打字机效果

**回复分区**:
一条飞书回复消息内按内容类型划分的结构块：思考、工具调用、正文等，各带一行标签以示区分；分区按 Run 的真实时序排列，工具调用可夹在两段正文之间；在回复卡片里，思考与工具调用收进折叠面板（见「折叠面板」），文本消息里则是普通标签行。
_Avoid_: 消息板块、三段式

**图片占位符**:
lark-cli 把入站消息预渲染成可读文本时，图片呈现成的标记，两种形状均已实测：富文本（post）内嵌图片是 `![Image](img_xxx)`，纯图片（image）消息是 `[Image: img_xxx]`。真正的二进制要用 `im +messages-resources-download` 另取。Bridge 解码时把占位符提取成图片 key、从文本中移除，下载后以 `image_url` part 投给 Agent（见 ADR-0009）。
_Avoid_: 图片标记、image tag

**审批**:
工具执行前请求人类决策的机制；v1 运行在 allow-all 模式，不产生审批请求（见 ADR-0004）。
_Avoid_: 确认（confirm）、授权

### 安全与策略

**allowlist**:
允许与机器人对话的 chat_id / open_id 清单。已决定为空（开放访问），仅作为配置项保留，想收紧时填入即可。
_Avoid_: 白名单、黑名单
