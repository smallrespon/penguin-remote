# 飞书 ⇄ PenguinHarness 桥接程序 — 实施计划

> 状态：**v1.0.0 已发布**（2026-10-21）。仓库 smallrespon/penguin-remote；spec 见 issue #1，tracer-bullet tickets 为 issue #2–#10（T1–T9，全部关闭）；PR #11（T1–T9）与 #12（回复分区）均已合并，tag `v1.0.0` + GitHub Release 已建；唯一剩余步骤是仓库转公开（人类在 GitHub 设置页操作，见 §14）。**v1.1 变更进行中**：不建 Agent + 会话走 chat 路径（不归档），见 §15 / ADR-0005。
> 目标：通过飞书机器人 App 链接一台正在运行的 PenguinHarness，在聊天里驱动它干活。

---

## 1. 目标与范围

在一个飞书机器人 App 背后挂一个常驻桥接程序（下称 **Bridge**），把飞书聊天消息转成 PenguinHarness 的一次 Agent Run，并把 Run 的过程与结果流回飞书。

v1 功能清单（对齐需求）：

| # | 功能 | 飞书里的形态 |
|---|------|------------|
| 1 | 新开对话 | `/new`（之后每条消息都是新会话的第一轮） |
| 2 | 换对话（回到某个旧会话继续聊） | `/sessions` 列表 + `/use <n>` |
| 3 | 换 Agent | `/agent` 列表 + `/agent <名字>` |
| 4 | 换模型 | `/model` 列表 + `/model <名字>`（见 §4.2 的实现方式） |
| 5 | 换思考程度 | `/thinking low\|medium\|high\|xhigh\|max`（同上） |
| 6 | 换工作区 | `/workspace` 列表 + `/workspace <名字>`（同上） |
| 7 | 使用 Skill | `/skill <名称>`（一次性）或 `/skill <名称> on`（粘滞） |
| 8 | 流式查看执行过程 | 机器人先发一条占位消息，随 AMSP 事件节流编辑（OpenClaw / Claude-to-IM 同款） |
| 9 | 工具调用审批 | `approval.requested` → 飞书交互卡片「允许 / 拒绝」按钮 |
| 10 | 中断执行 | `/stop` |
| 11 | 状态查询 | `/status`（当前绑定、会话、模型、思考档位、最近用量） |
| 12 | 帮助 | `/help` |

非目标（v1 明确不做）：文件/图片附件互通（飞书图片 → base64 再进 AMSP 留到 v2）、多飞书 App/多租户、群聊白名单精细化权限（先做全局 allowlist）、Heartbeat 定时任务（v2，可映射到 PenguinHarness 自带的 `penguin schedule`）。

---

## 2. 现状调研（均已在本机验证）

### 2.1 PenguinHarness 侧（v0.2.16，本机 server 已在 80 端口运行）

PenguinHarness 为「外部程序驱动 Agent」提供了官方入口：**Agent API / AMSP**（`/api/amsp/v1`，位于 cookie 认证网关之前，用 per-agent key 认证）。

| 路由 | 用途 |
|------|------|
| `GET  /api/amsp/v1/agents/:projectId/:agentId` | Agent 元信息 |
| `POST /api/amsp/v1/agents/:projectId/:agentId/runs` | 发起一次 Run，返回 **SSE 事件流** |
| `GET  /api/amsp/v1/sessions/:sessionId` | 会话状态与模型 |
| `POST /api/amsp/v1/sessions/:sessionId/abort` | 中断（202/204） |
| `POST /api/amsp/v1/sessions/:sessionId/approvals/:toolCallId` | 审批 `{decision: allow\|deny}` |

- 认证：`Authorization: Bearer penguin_…`（per-agent key，只属于一个 Agent）；也可开启 keyless（不推荐）。
- Run 请求体只有两个字段：`{ input: string | InputItem[], session_id?: string }`。**没有** model / thinking / workspace 的逐次覆盖参数。
- 事件流（AMSP）：`run.started → request/text/thinking/tool_call/tool_result/approval/compaction 事件 → run.done`，随后 `data: [DONE]`；15s 无事件发 `: keep-alive` 注释。npm 上有官方零依赖客户端 `@prismshadow/amsp@0.2.16`（与 server 同版本），Node 24 可用。
- 会话规则：不带 `session_id` 即新建（`run.started` 返回新 id）；带则必须属于同一 Agent 的 API 会话；同一会话同时只跑一个任务（忙时 409）；Agent 并发上限默认 4（429 + `Retry-After: 2`）；**客户端断流 = 中止 Run**。
- 官方 npm 客户端：`@prismshadow/amsp`（"zero-dependency client for Node 24 and browsers"）。

**关键约束（决定 §4 的设计）**：model / thinkingLevel / workspace 是 **Agent 级**的「New session settings」，只能由项目 owner 在 Web API tab 或 `PUT /api/projects/:p/agents/:a/api`（需人类登录态）修改，且只对**之后新建**的 API 会话生效。CLI `penguin agent api enable/set` 只暴露 `--open/--approve`，不暴露模型/思考/工作区。

### 2.2 飞书侧（lark-cli 1.0.98，bot 身份已就绪）

- 收消息：`lark-cli event consume im.message.receive_v1 --as bot` → stdout 逐行 NDJSON；stderr 就绪标记 `[event] ready event_key=…`；stdin EOF 会优雅退出（长驻需喂不 EOF 的 stdin 或定时重启）。**本机已验证**：bus daemon 自动起、WebSocket 连上、超时干净退出。
- 发消息：`lark-cli im +messages-send --as bot --chat-id oc_xxx --markdown "…"`。
- 编辑已发消息：文本消息走 `lark-cli im +messages-edit --as bot --message-id om_xxx --markdown "…"`（bot only，正好匹配；单条编辑上限 20 次，见 §11）；交互卡片走 `lark-cli im messages patch --as bot --message-id om_xxx --data …`（只更新 interactive 卡片，无编辑次数上限、连打 27 次全过，内容上限 30KB，见 §11 / ADR-0006）。
- 审批按钮：interactive 卡片 + `lark-cli event consume card.action.trigger`；更新卡片用 `api POST /open-apis/interactive/v1/card/update`（token 30 分钟有效）。卡片 JSON 必须按 lark-im skill 的卡片工作流生成（实现时读 `references/card/lark-im-card-create.md`）。
- 事件里带 `chat_type`（p2p/group）、`mentions`（群聊里是否被 @）、`message_id`、`sender_id`，文本已渲染成可读文本。

### 2.3 运行环境事实

- PenguinHarness server：pid 344375，**只监听 127.0.0.1:80 / [::1]:80**（回环）。本机访问要用 `http://localhost/api/amsp/v1`（`127.0.0.1` 直连会被 401——官方文档注明的怪癖：127.0.0.1 是预览端口，API 请求一律 401）。
- 当前 `default_project/default_agent`：API 未开、0 个 key、server 级开关 on。
- Node v24.18.0 已装；pnpm 未装（P0 先装）；机器内存 2GB，需控并发。
- 参考仓库已在本地：`scratchpad/penguin-harness-reference`（commit `8aa7612`），源码与文档可随时查证。

---

## 3. 总体架构（借鉴 OpenClaw）

OpenClaw（前身 Clawdbot）是「本地优先的开源 AI 智能体执行网关」：单进程 Gateway 做控制平面，下挂 Channel 适配器、Lane 串行队列、Heartbeat、纯文本状态、策略即代码的安全模型。Claude-to-IM（op7418）则提供了「Claude Code ↔ IM」的直接先例：会话绑定持久化、流式预览（编辑消息 + 按平台节流）、内联按钮审批、密钥 chmod 600 + 日志脱敏。

本 Bridge 采用同款分层：

```
                飞书用户
                   │ 消息 / 按钮
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Bridge（单进程 Gateway，本地优先）                              │
│                                                              │
│  ┌─────────────┐   NDJSON    ┌──────────────┐                │
│  │ Feishu      │ ──────────► │ 消息解码器    │                │
│  │ Adapter     │ ◄────────── │ (chat/user/  │                │
│  │ (lark-cli   │  send/patch │  text/mentions)               │
│  │  子进程)     │             └──────┬───────┘                │
│  └─────────────┘                    │                        │
│                              ┌──────▼───────┐                │
│                              │ 命令路由器    │ /new /use /agent …│
│                              └──────┬───────┘                │
│                              ┌──────▼───────┐  ┌───────────┐ │
│                              │ Lane Queue   │  │ Registry  │ │
│                              │ (按 chat 串行)│  │ (绑定持久化)│ │
│                              └──────┬───────┘  └───────────┘ │
│                              ┌──────▼───────┐                │
│                              │ Penguin 客户端 │ ── HTTPS ──► │
│                              │ AMSP runs/SSE │               │
│                              └──────────────┘                │
└──────────────────────────────────────────────────────────────┘
                   │ AMSP SSE（run.started … run.done）
                   ▼
        PenguinHarness server（/api/amsp/v1，Bearer key）
```

借鉴点对照：

| OpenClaw / Claude-to-IM 的概念 | 本 Bridge 的对应 |
|---|---|
| Gateway 单进程控制平面、本地优先 | Bridge 单 Node 进程；状态纯文本落盘 |
| Channel 适配器统一接口（协议转换引擎） | `channels/types.ts` 定义接口，`channels/feishu.ts` 是唯一实现；未来加 Telegram/企业微信不动内核 |
| Lane Queue 串行执行 | 按 `chatId` 串行：一个聊天同时只跑一个 Run（AMSP 本身也禁止会话并发） |
| 会话绑定持久化（Claude-to-IM） | `state/bindings.json`：chatId ↔ (profile, sessionId, skill)，原子写 |
| 流式预览 + 按平台节流（Claude-to-IM） | 占位交互卡片 + `im messages patch` 节流（≥1s/次；文本兜底路径仍用 `messages-edit`，见 ADR-0006） |
| 内联按钮审批（Claude-to-IM） | `approval.requested` → 卡片「允许/拒绝」→ `card.action.trigger` → AMSP approvals |
| 密钥 chmod 600 + 日志脱敏 | key 只走 env / 0600 文件；日志对 `penguin_` 打码 |
| Heartbeat / Cron | v2：用 PenguinHarness 自带 `penguin schedule` 或 Bridge 内置定时 |
| Slash commands 控制面 | §5 命令集 |

---

## 4. 核心设计决策

### 4.1 传输层：会话 API HTTP/SSE（ADR-0005，2026-10-21 起取代 AMSP）

- 选型：Bridge 以 owner 令牌当 `penguin_session` cookie，直连 PenguinHarness 的会话 API——`POST /api/projects/:p/agents/:a/sessions` 建会话（带 model / workspace / approvalMode）、`PATCH /api/sessions/:id` 钉 thinkingLevel、订阅 `GET /api/sessions/:id/stream`（SSE）后 `POST /api/sessions/:id/tasks` 投递、`POST /api/sessions/:id/abort` 中断、`POST /api/sessions/:id/approvals/:toolCallId` 应答审批。飞书侧仍用 lark-cli 子进程。
- 理由：这是 `penguin chat` 驱动服务器的同一条路，建出来的是**普通会话**（`source: "user"`），不进「已归档聊天」、`penguin session ls` 直接可见；且建会话接口本身就接受 model / workspace / approvalMode，档位可以按聊天隔离而不必动 Agent。
- 否掉「保留 AMSP + 建完立刻 unarchive」：AMSP 拒绝续接非它创建的会话（校验 `client: "api"`），创建与执行无法拆成两条路；且 AMSP 没有逐次覆盖参数，档位隔离仍要建 Agent，与「不能创建 Agent」冲突。
- v1.0 及以前用的是 AMSP（per-agent key、`/api/amsp/v1`）；它建的会话被服务端按规则归档，这正是本次切换的动因（见 ADR-0005）。

### 4.2 换模型 / 换思考程度 / 换工作区 / 换 Project / 换 Agent：按聊天存 binding（ADR-0005）

**已定决策（2026-10-21 晚，用户拍板）**：Bridge **不创建任何 Agent**，一律用配置里的默认 Agent；档位按聊天存放在 binding，只在建新会话时下发；`/agent` 保留（只切现有 Agent）；服务端遗留的专属 Agent 全部清理。

- **档位存 binding**：`/model`、`/thinking`、`/workspace` 把值写进该聊天的 binding（Registry 持久化），不碰任何 Agent 的设置。下一条消息若需新建会话，建会话时带上这些值（model 以 `provider`+`modelId` 成对下发；thinkingLevel 建后 PATCH 钉上）。已存在的会话保持它创建时的设置——「下一新会话生效」在这里是字面语义。
- **零互相影响**：每个聊天的档位只在自己的 binding 里，改一个聊天不影响其他聊天，也不影响默认 Agent 本身。
- **换 Project**：`/project <名字>` 切项目；Agent 归位到默认（agentId 是项目级的），session 重置；model/thinking 随项目重置（模型目录是项目级的），workspace 保留。列表从 owner 路由 `GET /api/projects` 拉。
- **换 Agent**：`/agent <名字>` 只在现有 Agent 间切（`GET /api/projects/:p/agents`），切完换对话（session 按 Agent 隔离）。不再需要「API 已开启 / 审批模式」检查——会话 API 不认 key，审批模式由 Bridge 在建会话时统一设 allow-all。
- **审批 allow-all**：建会话时 `approvalMode: "allow-all"`，不产生审批请求；万一到来（服务端配置变化），按 `denyAll` 策略应答并在预览里注明（v2 再做飞书卡片）。

### 4.3 会话与「换对话」

- Registry 记录每个 chat 用过的所有 session（task 投递返回时落盘），作为审计轨迹与**兜底**列表；`/sessions` 默认**实时查询服务端**当前 Project/Agent 下的未归档会话（`GET /api/projects/:p/agents/:a/sessions`，按 lastActiveAt 倒序），展示截断到 50 条并注明总数，`/use <n>` 在这份列表上切换——远程（Web/CLI/其他客户端）新建的未归档会话可直接看见并跳入；查询失败才退回 Registry 本地历史并在回复中注明（ADR-0008；截断口径 2026-10-22 改为 50 条，见 ADR-0011）。
- 为什么改：v1.0–v1.3 的「自持列表」让 Bridge 看不见任何非自己创建的会话，用户在远程新建的对话无法跳转；服务端列表接口一直存在（`penguin session ls` 就在用），Bridge 建的会话本就不归档，实时列表天然覆盖自己建的会话，不存在「列出去了却续不了」。
- `/new` = 清掉当前 sessionId 绑定，下一条消息新建（新建时带上当前档位）。
- 迁移约定：v1.0 时期 AMSP 建的会话是 `source: "api"`（已归档）。2026-10-21 实测：默认 Agent 名下的旧会话仍可被会话 API 续接（续了也保持归档），绑定保留、自然老化；按聊天懒建的 `feishu_*` 专属 Agent 名下的旧会话经会话 API 不可达（404，随 Agent 清理一并消失），这类绑定在 Registry 加载时迁回默认 Agent 并清掉会话引用（历史记录按归属自然过滤）。自 ADR-0005 起新建的会话都是普通会话（`source: "user"`，不归档）。

### 4.4 使用 Skill

PenguinHarness 的 Skill 是 Agent 本地的 `SKILL.md` 指令包（Agent 自己 read）。Bridge 不传输 skill 内容，只做**提示词注入**：

```
/skill lark-im 帮我把这个群的纪要发出来
→ 实际 input：「请使用 skill「lark-im」完成以下任务：帮我把这个群的纪要发出来」
```

`/skill <name> on` 粘滞生效；`/skill off` 取消。skill 是否存在由远程 Agent 自己判断（它的系统提示里就列着可用 skills），Bridge 不维护清单（同机部署时可顺带扫 `agent_state/skills/` 做补全提示，非必须）。

### 4.5 流式预览与渲染

- 每条 Run 开始：发一张占位交互卡片（Card 2.0，header 状态「🦐 思考中…」），拿到 `message_id`；预览与定稿都 patch 这一张卡（承载形态见 §13 / ADR-0006）。
- **订阅先于投递**：先连 `GET /api/sessions/:id/stream`（SSE，首事件是 `task_state` 快照），再 `POST .../tasks`，保证不丢事件。
- 事件映射（OmniMessage → 回复分区，格式细节见 §13 / §16）：`partial_text` 增量累积正文分区，完整的 assistant `text` 消息收尾；`partial_thinking`/`thinking` 累积成思考分区，收进默认收起的折叠面板——面板内是完整思考全文（先脱敏后截断，每面板 2000 字上限），标题带运行状态「🧠 思考 · 运行中… · N 字」/「🧠 思考 · 运行完毕 · N 字 · X.Xs」（ADR-0007）；`tool_call` 追加「🔧 工具名」+ 一行截断到 80 字的参数（先 redact 后截断），标题带「运行中… / 运行完毕」状态；`tool_call_output` 回填 `output:` 围栏代码块（末尾 8 行、每行 ≤100 字符）；`compaction_begin` 记一条「🗜️ 正在压缩上下文…」提示分区。
- 终局判定：`task_state` 从 running 回 idle 即 Run 结束；`request_end` 的 status（completed / aborted / fatal / retryable）与 `abort` 事件的 error_code 决定结局文案；用量按请求累计（每个 `request_begin` 配对的 `token_usage.request.total` 求和，压缩期间的用量也计入；一个请求都没跑过则没有用量页脚），与 v1.0 AMSP 客户端口径一致。
- 节流：每 ≥1.5s 或累积 ≥300 字符才 `im messages patch` 一次；最终定稿一次。patch 实测没有单条消息的编辑次数上限（连打 27 次全过），不再需要换新消息续接预览；patch 失败（频控 / 超限）即放弃预览，定稿仍会新发一张卡片（结果不丢）；卡片发送失败则整体退回文本降级链路（换消息续接只属于这条文本兜底路径）。
- 断流处置：SSE 中途断开不会让服务端停止任务，Bridge 显式 `POST .../abort` 中止并把该 Run 记为失败，避免僵尸任务占住会话。

### 4.6 并发与限流

- Lane Queue：同一 `chatId` 串行；Run 进行中该聊天再来消息 → 回复「正在执行中，`/stop` 可中断」并丢弃（不排队，避免惊鹜）。
- 会话 API 的 tasks 支持 `queueIfBusy`（忙时入队、空闲自动起，202 响应的 `queued` 区分）；Bridge **不发送**它——Lane 已经保证一个聊天同时只投递一个任务，撞上 409 只可能是同一个会话被别的客户端占着，按「正在执行中」提示、不排队（与 Lane 语义一致）。要改成排队语义需同时改终局判定（排队期间会话一直忙，现在的「活跃过再回 idle」会在别人那个任务结束时误判定稿）。
- Bridge 重启 = 所有在途 Run 的订阅断开 → 显式 abort 掉；重启后 Registry 里的 session 仍可 `/use` 续聊。

---

## 5. 命令集（v1）

| 命令 | 行为 |
|---|---|
| `/help` | 命令列表 |
| `/new` | 新开会话（清 session 绑定） |
| `/sessions` | 实时列出当前 Project/Agent 下未归档会话（序号/标题/时间/模型，最近 50 条并注明总数；当前会话以 `→` 标出）；查询失败退回本地历史并注明（ADR-0008 / ADR-0011） |
| `/use <n>` | 切到实时列表的第 n 个会话（含远程新建的未归档会话） |
| `/project` / `/project <名字>` | 列出（owner 会话拉 `GET /api/projects`）/ 切换项目；切项目 = Agent 归位默认 + 换对话（session 按 Agent 隔离） |
| `/agent` / `/agent <名字>` | 列出（`GET /api/projects/:p/agents`）/ 切换 Agent；切 Agent = 换对话（session 按 Agent 隔离） |
| `/model <名字>` | 把模型写进本聊天 binding，下一新会话生效 |
| `/thinking <level>` | 把思考档位写进本聊天 binding，下一新会话生效 |
| `/workspace <路径或名字>` | 把工作区写进本聊天 binding，下一新会话生效 |
| `/skill <名字> [on\|off]` | 一次性 / 粘滞 / 关闭 |
| `/status` | 当前绑定（project/agent/会话/本聊天档位）+ 会话状态（`GET /api/sessions/:id`）+ 上次用量 |
| `/stop` | 中断当前 Run（`POST /api/sessions/:id/abort`） |
| （无命令） | 普通文本 → 直接作为 Run 输入 |

`/model`、`/thinking`、`/workspace` 的可选值从 Project 配置动态拉取（`GET /api/projects/:p/models`），不写死。档位只写本聊天的 binding，建新会话时下发，不建 Agent、不动共享 Agent（见 §4.2 / ADR-0005）。

`/model` 列表取舍：模型目录实测有五百多个（2026-10-21 是 524 个，还在涨），全列会把飞书消息撑爆，因此**列表只展示前 30 个并注明总数**；匹配切换不受此限（`provider/modelId`、裸 `modelId`、displayName 全量匹配，唯一命中即切换）。这是对 §12「动态列全部」的有意 UX 取舍。

群聊规则：仅当 `mentions` 含机器人时响应，并剥离 @ 占位符；私聊全响应。全局 allowlist（chat_id / open_id）之外的来源一律静默忽略。

---

## 6. 状态与数据模型

纯文本、Git 友好（OpenClaw 式）：

```
state/
├── bindings.json     # { "<chatId>": { projectId, agentId, sessionId, skill?, skillSticky?, model?, thinkingLevel?, workspace?, history: [{sessionId, title, at, model?, projectId?, agentId?}], updatedAt } }
└── runs.jsonl        # 每次 run 一行：chatId/sessionId/status/usage/耗时（审计与成本）
```

- 原子写（tmp + rename）；启动时加载，缺文件即全新。
- 档位（model / thinkingLevel / workspace）就在 binding 里，缺省 = 跟随 Agent 与 Project 默认；换 Project 时重置 model/thinking（模型目录是项目级的），workspace 保留。
- 迁移：v1.0 遗留的、agentId 为 `feishu_*` 专属 Agent 的绑定，加载时归位到默认 Agent。
- owner 会话令牌（`penguin auth token`）只驻内存，过期前重铸，不落盘、不进日志。Bridge 不持有任何 per-agent key。

---

## 7. 安全设计

- **密钥只有一类**：owner 会话令牌（`penguin auth token` 现铸现用，TTL 1h，过期重铸；全程不落盘、不进日志）。ADR-0005 起 Bridge 不再铸造、不持有任何 per-agent key。
- **访问控制（已定：开放）**：访问范围定为「任何能与机器人对话的人」，不设 allowlist——用户已确认接受这个暴露面。配套措施：群聊仍需 @ 机器人才响应（防误触发）；`/help` 回复里常驻一句风险提示；README 用显眼位置写明「任何能给机器人发消息的人都能全权限驱动 Agent」。allowlist 代码保留为配置项（默认空=开放），想收紧时填几个 chat_id 即可。
- **远端暴露**：已定同机部署，server 保持回环监听即可，零暴露。若哪天改跨机：`penguin server --host 0.0.0.0`（或反代 + HTTPS），并把 key 当密码管理；不要开 keyless。
- **高危操作可见性**：allow-all 模式下工具调用直接执行，飞书侧靠流式预览展示 `tool_call`/`tool_result`（截断显示），`runs.jsonl` 留审计轨迹。

---

## 8. 项目结构与技术栈

- Node 24（已装）+ TypeScript + pnpm（P0 安装）；运行时依赖尽量只用 `@prismshadow/amsp` 一个，其余走 Node 内置（fetch / stream / child_process）。
- 目录：

```
/root/penguin_remote/
├── PLAN.md                  ← 本文档
├── package.json / tsconfig.json / .env.example
├── src/
│   ├── index.ts             # 装配 + 启动 + 优雅退出（SIGTERM → 关 consume 子进程）
│   ├── config.ts            # env 加载与校验（fail-fast）
│   ├── gateway.ts           # 控制平面：把下面各层接起来
│   ├── channels/types.ts    # Channel 适配器接口（send/edit/onMessage）
│   ├── channels/feishu.ts   # lark-cli 子进程：consume 两条事件流 + send/edit
│   ├── router.ts            # 命令解析与分发
│   ├── lanes.ts             # 按 chatId 串行队列
│   ├── registry.ts          # bindings 持久化
│   ├── penguin/owner.ts     # owner 会话：penguin auth token 铸/换 + settings/agents 路由 + fetchAuthed（供会话 API 复用）
│   ├── penguin/sessions.ts  # 会话 API 客户端（建会话/PATCH/SSE 订阅/tasks/abort/approvals，ADR-0005）
│   ├── penguin/omni.ts      # OmniMessage → RunEvent 翻译 + RunTracker（终局/用量/正文）
│   ├── penguin/runner.ts    # 单次 Run 生命周期（续接或新建会话→订阅→投递→守终局→定稿）
│   ├── run-event.ts         # Bridge 自有 RunEvent 联合类型（渲染层只认这套）
│   ├── render.ts            # RunEvent → 增量 markdown
│   └── approvals.ts         # 审批策略接缝（v1 默认一律拒绝）
├── state/                   # 运行时状态（bindings.json / runs.jsonl）
└── scripts/start.sh         # 前台启动；systemd unit 另附
```

- 部署：`scripts/start.sh`（`node --enable-source-maps dist/src/index.js`）+ 可选 systemd user unit；日志滚动到 `logs/`。
- 代码结构为 v1.1 现状（ADR-0005 起无 amsp.ts / agents.ts，运行时零依赖）；v1.0 的 AMSP 传输与专属 Agent 供给已删，历史描述以上方各节与 §15 为准。

---

## 9. 工作流：matt 技能链（setup → grill → spec/tickets → implement → review）

本项目按仓库内的 matt 工程技能链推进（`/ask-matt` 是路由入口；主流程：idea → ship）。

### 第 0 步（一次性前置）：`/setup-matt-pocock-skills`

本仓库当前不是 git 仓库、没有 `AGENTS.md`/`CLAUDE.md`、没有 `docs/agents/`。该技能会先探索、再逐段确认后写入配置：

- **Issue tracker（需你选）**：推荐 **Local markdown**（`.scratch/<feature>/` 下每 ticket 一个文件，适合当前无 git 远端的单人项目）；若打算建 GitHub 仓库并开源/协作，则选 GitHub（`gh issue`）。
- **Triage labels**：`triage` 技能已安装，用默认五档：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- **Domain docs**：默认 single-context——根目录一份 `GLOSSARY.md` + `docs/adr/`（无需询问，直接写）。

### 第 1 步：`/grill-with-docs`（有工作目录，用带文档的版本）

把 §12 的开放问题作为访谈议程逐条敲定，过程中沉淀：

- `GLOSSARY.md`：Bridge / Channel 适配器 / Lane / Profile / Registry / Run / AMSP 等术语，后续测试命名与 ticket 描述都用这套词汇。
- ADR（至少三条）：① 传输层选 AMSP 而非包装 CLI；② 模型/思考/工作区切换：profile 池（v1）还是 owner 动态模式；③ 会话绑定与持久化：Registry 作为单一事实来源。

### 第 2 步：原型绕行 `/prototype`（按需，`/handoff` 双向桥接）

三个「必须有可运行答案」的问题（§11 风险 1–3）各做一个一次性原型，放独立目录，答案带回主线：

- lark-cli `event consume` 长驻行为（bus daemon 生命周期、stdin 保活、优雅退出）；
- 飞书消息编辑的频率上限与节流参数实测；
- `card.action.trigger` 审批闭环（发卡片 → 点按钮 → 更新卡片）。

### 第 3 步：`/to-spec` → `/to-tickets`

这是跨多个会话的工程：先 `/to-spec` 把讨论沉淀成 spec，再 `/to-tickets` 切成 **tracer-bullet 竖切 tickets**（每片穿透各层、可独立验证、声明 blocking edges）。建议切法（与 §10 阶段对应，最终以 `/to-tickets` 产出为准）：

| # | Ticket | Blocked by | 交付的可验证行为 |
|---|--------|-----------|-----------------|
| T1 | 工程脚手架 + 配置加载 | — | `pnpm build` 通过；`.env` 缺项 fail-fast |
| T2 | Feishu Channel 适配器 | — | 能收到机器人消息事件、能发/改消息 |
| T3 | Penguin AMSP 客户端 | — | 能对测试服务器发起 run 并解析事件流 |
| T4 | 最小闭环 | T2, T3 | 飞书发一句话 → 收到 Agent 回复 |
| T5 | Registry + Lane Queue + 控制命令 | T4 | `/new` `/sessions` `/use` `/status` `/stop` 生效且重启不丢 |
| T6 | 流式渲染与节流编辑 | T4 | 长回答渐进显示，可见工具调用轨迹 |
| T7 | Owner 会话 + Agent 供给 + 档位切换 | T5 | `penguin auth token` 铸令牌可用；`/project` `/agent` 列出/切换；`/model` `/thinking` `/workspace` 改设置并即时生效；首次改档位自动懒建专属 Agent 并铸 key |
| T8 | （v2，可选）审批卡片闭环 | T4 + 原型结论 | always-ask/read-only 模式下点「允许/拒绝」任务正确继续。v1 用 allow-all，本 ticket 不阻塞交付 |
| T9 | 安全加固 + 部署 | T5, T7 | 群聊 @ 闸门生效；`/help` 常驻风险提示；systemd 常驻；README 含同机部署说明 |

### 第 4 步：`/implement`（逐 ticket，之间 `/clear`），ticket 内驱动 `/tdd`

- 测试只写在**事先约定并经你确认的 seam** 上。建议 seam：Channel 适配器接口（send/edit/onMessage）、AMSP 客户端（runs/abort/approvals，mock 传输层）、命令路由器（纯函数解析）、Registry（文件读写）、渲染器（AMSP 事件 → 增量文本）、Lane Queue（并发语义）。
- 每个 ticket 走红→绿竖切片；频繁跑 typecheck 与单测，结束跑全量；完成后 `/code-review`（Standards + Spec 双轴）。

### 第 5 步：收尾

`/code-review` 总览 →（如开源）`/pr` 写 PR body → `/retro` 复盘（机械错误变确定性检查，判断沉淀为编码规范）。

**人类专属步骤用 `/wizard`**：飞书开放平台建应用、开事件订阅、拿 App ID/Secret；PenguinHarness Web UI 开 Agent API、建 key——这些仪表盘操作生成一个交互式 bash 向导代劳，值写进 `.env`（0600）。

**上下文卫生**：grill → spec → tickets 保持在同一个上下文窗口；每个 `/implement` 开新窗口从 ticket 出发。

---

## 10. 分阶段实施计划（与技能链对应）

> 实施状态（2026-10-21）：P0–P5 全部完成（ticket T1–T9），测试 123 个全绿（typecheck 干净）；
> T8（审批卡片）按 §12 的决策降为 v2，v1 只保留接缝与明确提示，见 §4.2。

每个阶段都有可观察的验收标准，做完一个再下一个。

### P0 环境与打通（约 0.5 天）
1. 装 pnpm；`pnpm init` + TS 骨架；`.env.example`。
2. Bridge 自己开道：`penguin auth token` 铸 owner 会话 → 给绑定 Agent `PUT .../api`（enabled=true）→ `POST .../api/keys` 铸 key。人工只在飞书开放平台建应用（用 `/wizard` 引导）。
3. 用文档里的 curl 打通一次 run：`curl -N http://localhost/api/amsp/v1/agents/default_project/default_agent/runs -H "Authorization: Bearer $KEY" -d '{"input":"现在几点"}'`，看到 `run.started … run.done`。
4. 验证 `lark-cli event consume im.message.receive_v1 --as bot` 长连接（stdin 保活）与 `+messages-send` 自发自收。
- **验收**：curl 能跑通一次完整 Run；飞书能收到机器人发的测试消息。

### P1 最小闭环（约 1 天）
FeishuAdapter（consume 子进程 + NDJSON 解析 + send）→ router（无命令也进任务）→ AMSP run → 完成后把最终文本发回。无流式、无状态持久化。
- **验收**：飞书私聊发「现在几点」，几秒后收到包含真实时间的回复。

### P2 控制命令与会话绑定（约 1 天）
Registry 持久化 + Lane Queue + `/new` `/sessions` `/use` `/status` `/stop` `/help`。
- **验收**：连续两轮对话有上下文连续性；`/new` 后上下文干净；`/sessions` 能列出来并 `/use` 回去续聊；`/stop` 能中断长任务。

### P3 流式预览与 skill（约 1 天）
占位消息 + 节流编辑 + render.ts（text/thinking/tool_call/tool_result 渲染）+ `/skill`。
- **验收**：长回答在飞书里渐进显示；能看见工具调用轨迹；`/skill <name> xxx` 生效。

### P4 owner 会话与档位切换（约 1 天）
`penguin/owner.ts` + `penguin/agents.ts` + `/project` `/agent` `/model` `/thinking` `/workspace`；懒建专属 Agent 与 key 管理。
- **验收**：飞书里 `/model` 列出可用模型并切换；切到深度思考后下一轮回答的思考档位变化可感知（`/status` 可见）；换 agent 后上下文按新 Agent 干净开始；同一进程内 key 与令牌不落地。

### P5 安全与部署加固（约 0.5 天）
allowlist（配置项，留空 = 开放访问，见 §7）、日志脱敏、consume 子进程守护重启（退避 1s→30s）、`.env` 0600、优雅退出、`scripts/start.sh` + systemd user unit、README（含同机部署说明与 `localhost` vs `127.0.0.1` 的坑）。
- **验收**：allowlist 之外的消息无响应；重启 Bridge 后旧会话可续；`/status` 输出符合预期。

---

## 11. 风险与未验证点

1. **lark-cli 长驻稳定性**：consume 的 bus daemon「最后一个消费者退出 30s 后自动退出」——Bridge 必须始终持有 consume 进程；进程异常退出要有守护重启（P5）。
2. **卡片承载上限**（已实测，2026-10-22，ADR-0006）：预览 / 定稿走 `im messages patch` 更新同一张交互卡片，没有文本消息那种单条编辑 20 次的上限（连打 27 次全过），长任务不再需要换新消息续接；真正的新边界是单次 patch 内容 30KB、单卡 200 个元素、客户端需 ≥7.20（更旧的只显示 header）——渲染层用约 20KB 预算收敛分区（超限时中间省略 N 个分区）规避。20 次编辑上限（第 21 次报 `230072 The message has reached the number of times it can be edited`；官方文档未写明，用探测脚本实测）只对文本兜底路径仍成立：卡片路径下预览 patch 失败即放弃预览，定稿仍会新发一张卡片（结果不丢）；只有卡片发送本身也失败，才退回 `messages-edit` 文本链路，此时编辑失败就换一条新消息继续承载预览（持续续接，上限 10 次；若新消息一次都没编辑成功过则不再换，直接降级），定稿落在最新那条消息上。
3. **卡片回调链路**（仅 v2 审批模式需要）：`card.action.trigger` 的 token 只有 30 分钟、更新卡片走另一个 API——真要做时先最小验证。
4. **owner 令牌生命周期**：`penguin auth token` 默认 1 小时过期，过期后 owner 路由 401。Bridge 要主动重铸（过期前 5 分钟），重铸失败要能在飞书里提示而不是静默失败。
5. **Agent 蔓延**：按聊天懒建专属 Agent 会让 Agent 数量随聊天增长；命名规范 `feishu_<hash>`，`agents.json` 记 `chatId`/`keyId`/`createdAt`（v1 未记 lastUsedAt，回收脚本留待需要时再加）。
6. **allow-all 暴露面**：审批模式定为 allow-all，allowlist 是唯一闸门；群聊场景任何被允许的人都能全权限驱动 Agent。这是已确认的取舍，但要写进 README 的显眼处。
7. **断流即中止**：Bridge 崩溃会杀掉在途 Run；用 Registry + `/use` 兜底。
8. **2GB 内存**：并发 Run 数受 `maxConcurrentRuns` 与内存双重限制，建议默认池 ≤4。

---

## 12. 决策记录（grill 结论，2026-10-21）

| 决定 | 取值 | 备注 |
|---|---|---|
| 部署形态 | 同机部署 | server 保持回环监听，零暴露 |
| 档位切换实现 | owner 动态模式 | `penguin auth token` 自铸会话（实测可过 requireHuman）；按聊天懒建专属 Agent 隔离全局副作用 |
| 使用场景 | 私聊 + 群聊 | 群聊需 @ 机器人 |
| 审批模式 | allow-all | 审批卡片链路降为 v2 可选 |
| 访问范围 | 任何能与机器人对话的人 | 已确认接受全权限开放的暴露面；配套措施见 §7 |
| Agent/Project 切换范围 | 全部 | owner 可见即可切 |
| Issue tracker | GitHub Issues | 需先 git init + 建仓库；gh 已登录（smallrespon，repo scope） |
| 默认档位 | 不预设 | 走 Project/Agent 现有配置；`/model` 动态列可用模型（列表截断到前 30 个 + 注明总数，见 §5；匹配不限） |
| 回复结构 | 有序「回复分区」承载为交互卡片：工具折叠面板 + 思考标签行 + 正文 + 状态 header / 用量页脚 | 不新增配置项；header 状态含会话忙「⏳ 请稍候」与失败「❌ 未正常完成」；超长优先整块丢弃中间分区，另设约 20KB 预算，详见 §13 / ADR-0006 |

> 收集这类决定时用 a2ui 的 form/choice 块提问（用户偏好，2026-10-21）。

---

## 13. 回复卡片（2026-10-22，ADR-0006）

Run 的回复承载为飞书交互卡片（Card 2.0，词条见 `GLOSSARY.md`）：数据模型仍是单一有序 parts 流（思考 / 工具调用 / 正文按 Run 真实时序排列，设计参照 ZCode 的有序 parts 模型，调研：`docs/research/zcode-reply-structure.md`），渲染目标从文本消息变为卡片。占位消息、流式预览、定稿三态共用同一张卡：占位即建卡，预览与定稿都经 lark-cli `im messages patch` 更新。

1. 数据模型是单一有序 parts 流：思考 / 工具调用 / 正文按 Run 真实时序排列，工具调用可夹在两段正文之间；审批、压缩等提示作为独立普通行按发生时刻插入。
2. 承载形态：卡片 header 只放状态文案——占位「🦐 思考中…」、预览「🦐 执行中…」、会话忙（409）「⏳ 请稍候」、定稿完成「✅ 完成」、定稿失败「❌ 未正常完成」；定稿页脚 = 分割线 + 用量行（与旧文本版文案一致）。会话忙与 Run 级失败（会话准备失败 / 断流）都 patch 同一张占位卡：忙卡是蓝色 header + 忙提示文本，错误卡是红色 header + 脱敏后的错误文本——不另发消息，不留停在「思考中」的僵尸卡；命令级的忙提示（Lane 忙）仍是文本消息。
3. 工具调用 = 一个默认收起的 `collapsible_panel`（折叠面板）：标题行「🔧 名称 · 截断参数」（参数约 80 字，与输出一同先过 `redact()` 脱敏再截断），点开展示参数与 output——保留末尾 8 行、每行 ≤100 字符，超出显式标注「已截断，共 N 行」。
4. 思考标签行：流式「🧠 思考中…（N 字）」，定稿「🧠 思考 · N 字 · X.Xs」（耗时按事件时间戳真实计算），定稿用 12px notation 字号；不存全文、不进面板。
5. 正文永远展开，不进面板；定稿正文以 `outcome.text` 为准：与流式累积的正文在忽略空白差异后不一致时，替换为 `outcome.text` 单段（保证答案不丢）；一致时保留全部分区原样。
6. 预算与降级：不新增配置项；parts 超限时优先整块丢弃中间分区并标注「……（中间省略 N 个分区）……」，单个正文段超预算时段内首尾对半砍；展不开时结尾分区（通常是最终答案）段内截断，永远不整块丢弃。另设约 20KB 的内容预算，防撞 patch 的 30KB 上限与单卡 200 元素上限；卡片路径 patch 失败即放弃预览，定稿仍新发一张卡片（结果不丢），只有卡片发送也失败才退回原有文本降级链路（文本渲染路径保留为兜底，不删除；「换新消息续接」只属于这条文本兜底路径）。

---

## 14. 发布（2026-10-21）

v1.0.0 发布清单与唯一剩余步骤。

**已完成**：

- PR #11（T1–T9）、PR #12（回复分区）均已合并；`main` 即发布代码（merge commit `5af813b`）。
- `LICENSE`（MIT）、`CHANGELOG.md`（1.0.0 条目）、`package.json` version 1.0.0；README 增加 CI / License / Node 徽章与「许可」节，并修正「已知限制」（私聊路径已真人验收，测试数 120 → 123）。
- tag `v1.0.0` + GitHub Release 已创建；仓库 description / topics 已设置。
- 全量验证：`pnpm typecheck`、`pnpm test`（123 个全绿）、`pnpm build` 通过；push 后 CI 绿。
- 移除 `HANDOFF.md`（实现期的内部交接文档，内容已过期且对公众读者有误导）。

**发布形态**：源码发布——tag `v1.0.0` + GitHub Release；**不发 npm 包**（`package.json` 保留 `private: true`）。Release 附两个产物，均由 `scripts/package.sh` 一键生成：

1. `penguin-remote-linux-x64.gz`——**单文件可执行程序**（Node SEA）：tsc 编译 → esbuild 打成单文件 CJS → 生成 SEA blob → 注入官方 Node 运行时副本；目标机无需 Node/pnpm，解压即跑。仅限 linux-x64，其他平台在目标机跑 `scripts/build-sea.sh` 自建。
2. `penguin-remote-1.0.0.tar.gz`——`dist/src/` 构建产物 + hoisted 生产依赖 `node_modules/` + 部署文件，解压即用（需要 Node 24）。

**唯一剩余步骤（人类操作）**：GitHub 仓库设置页把 `smallrespon/penguin-remote` 从 Private 改为 Public。除此之外无未决项。

**后续可选（不阻塞发布）**：审批卡片闭环（v2，§4.2）；按工具定制投影与 diff 渲染（`docs/research/zcode-reply-structure.md` 第 8 节）；Agent 回收脚本（§11 风险 5）。

---

## 15. v1.1：不建 Agent + 会话走 chat 路径（2026-10-21，ADR-0005）

**动因（用户原话）**：「不能创建 agent，默认用默认 agent；更换 workspace 后会更换 agent 这个不行，每个配置都是单独的，不能互相影响；对话的创建用 chat 命令，用 chat 我想要不归档的。」

**根因**：v1.0 的档位隔离靠「按聊天懒建专属 Agent」——AMSP 没有逐次覆盖参数，model / thinkingLevel / workspace 是 Agent 级设置。副作用正是用户看到的：改一次档位就换 Agent、Agent 数量随聊天增长、404 事故（登记残留）的温床；且 AMSP 建的会话 `source: "api"`，被服务端按规则归档。

**落地清单**（用户 2026-10-21 拍板 5 项：传输切换 / 档位存 binding / `/agent` 保留 / 清理残留 / 旧绑定保留续接）：

| # | 项 | 落点 |
|---|----|------|
| 1 | 传输层换会话 API（建会话 / PATCH thinking / SSE 订阅 / tasks / abort / approvals），删 `src/penguin/amsp.ts` 与 `@prismshadow/amsp` 依赖 | `src/penguin/sessions.ts`、`src/penguin/runner.ts` |
| 2 | Bridge 自有 RunEvent 联合类型，OmniMessage → RunEvent 翻译器（纯函数） | `src/run-event.ts`、`src/render.ts` 改导入 |
| 3 | Binding 加 `model` / `thinkingLevel` / `workspace`；加载时把 `feishu_*` 绑定迁回默认 Agent | `src/registry.ts` |
| 4 | 档位命令改写 binding；`/project` 切项目重置 model/thinking、保留 workspace；删 `approvalWarning` | `src/tiers.ts` |
| 5 | 配置：`OWNER_API_BASE_URL` 取代 `AMSP_BASE_URL`，删 `AMSP_API_KEY` | `src/config.ts`、`.env` |
| 6 | 删 `src/penguin/agents.ts`、`state/agents.json`；owner.ts 暴露 `fetchAuthed`（SSE 用） | `src/penguin/owner.ts`、`src/index.ts` |
| 7 | 真实验收后清理服务端两个遗留 `feishu_*` Agent 与 key，重启 Bridge | 运维动作 |

**验收标准**：飞书发消息 → PenguinHarness 侧新建会话 `source: "user"`、`archived: false`（`penguin session ls` 不加 `-a` 可见）；服务端不再新增任何 Agent；两个聊天各自 `/workspace`、`/model` 互不影响；`/status` 显示本聊天档位；旧会话仍可 `/use` 续接。

---

## 16. v1.3：思考折叠 + 状态标识（2026-10-22，ADR-0007）

**动因（用户原话）**：「再修改一下，我发现你的回复中有部分思考和工具可以折叠，标识好像是运行完毕，主要在正文之间，这个能不能做」——对照 PenguinHarness app：ThinkingBlock / ToolCallCard 都是默认收起的折叠块，标题带运行状态，思考点开有全文。这逆转了 ADR-0006「思考不存全文、不进面板」：那一条的理由「避免刷屏」由折叠机制本身满足（收起态只占标题一行），而用户明确要「可以折叠、点开能看」。

1. **数据模型不变**：仍是单一有序 parts 流（思考 / 工具调用 / 正文按 Run 真实时序排列，§13 的口径沿用）；`ThoughtPart` 多记一个 `text` 全文字段，只驻 `PreviewState`——`runs.jsonl` 仍只记 RunReport（chat/session/状态/用量/耗时），不落分区内容，日志不打印思考。
2. **承载变化：思考进面板**：思考分区渲染成一个默认收起的 `collapsible_panel`，标题是思考标签（带运行状态），面板内是完整思考全文——先 `redact()` 脱敏再按 2000 字上限头尾对半砍、中间标注省略字数，围栏代码块保真（思考文本可能含 markdown 记号与 ```）；预览与定稿都默认收起，预览期面板同样放累积全文（同一 2000 字上限），随节流 patch 增长。脱敏时机从「累积时」移到「渲染时」：工具参数在 `tool_call.done` 一次性拿到完整字符串，可以累积时脱敏；思考只有渲染时才能拿到全文，跨 delta 的密钥只有在完整文本上才能被正则命中。
3. **承载变化：折叠块状态标识**：思考标题「🧠 思考 · 运行中… · N 字」（流式）/「🧠 思考 · 运行完毕 · N 字 · X.Xs」（定稿，耗时按事件时间戳真实计算）；工具标题「🔧 名称 · 运行完毕 · 参数」（收到 output）/「🔧 名称 · 运行中… · 参数」（未收到 output），状态紧跟工具名，与思考标题「名称 · 状态 · 详情」语序一致。
4. **预算优先级**：超预算时先把思考面板当丢弃首选（靠中间的优先），保住工具轨迹与正文答案；思考丢光仍超预算，再按现有规则从中间丢其他分区。文本兜底路径的预算口径不变（`render.ts` 的 `fitMiddleDropping` 原样保留）。
5. **边界**：定稿时仍未闭合的思考段（始终没等到 `thinking.done`）标题不带状态词，沿用「🧠 思考 · N 字」——拿不到终态，不谎报「完毕」；文本兜底路径里思考仍是一行标签（文本消息没有折叠载体），「运行完毕」等状态词只出现在卡片路径。

---

## 17. v1.4：会话列表实时化 + 图片入站（2026-10-22，ADR-0008 / ADR-0009）

**动因（用户原话）**：「我发现你换对话时不能实时监测当前工作区未归档的对话，这样的话我也不能直接跳转到在远程新添加的对话」「llm-homework 这个工作区的最新的对话发送不了图片」。

1. **会话列表实时化（ADR-0008）**：`/sessions` 与 `/use` 改查服务端 `GET /api/projects/:p/agents/:a/sessions`——未归档、按 `lastActiveAt` 倒序前 10 条；本地 Registry 历史降级为查询失败时的兜底（回复中注明）。用户在任何客户端新建的对话从此可见、可跳。
2. **图片入站（ADR-0009）**：入站消息的 `![Image](img_key)` 占位符在解码时提取为图片 key 并从文本中移除；`message_type` 白名单扩到含 `image`；Channel 适配器新增 `downloadImage(messageId, fileKey)`（lark-cli `im +messages-resources-download`，临时文件即用即删）；`src/images.ts` 纯函数按魔数嗅探 mime、拼 base64 data URL，超服务端 20MB inline 上限或嗅探失败的图片跳过并在输入里注明；`startTask` 入参扩为「字符串或 part 数组」，有图片时投 `[{type:"text"},…{type:"image_url",imageUrl}]`，纯图片消息只投 image_url parts（不注入占位文本，用户拍板）。
3. **边界**：文件 / 音频 / 视频类消息仍不响应；回复方向不出图；data URL 不落 `runs.jsonl`、不进日志。

---

## 18. v1.5：步骤分组折叠 + /sessions 全量 + HTML 页交付（2026-10-22）

**动因（用户原话）**：「我要的是思考和工具调用等等能被折叠在一起形如图片所示，运行完毕那两步可以被折叠」「/sessions 能展示当前工作区未归档的所有对话，然后 use 支持跳换到那次对话」「要支持对 a2ui 的 ui 图的渲染在飞书中，或者找类似的解决方法，或者可以用 answermewithhtml 找办法」。

三项决策经 a2ui form 拍板（2026-10-22）：① 分组超预算直接丢中间整组（不做组内二级预算）；② `/sessions` 截断到 50 条并注明总数；③ a2ui/mermaid 走 answer-me-with-html 路线（产出单文件 HTML 发进飞书）；④ 分组标题用「🧰 运行完毕 · 2 步 · 41.4s」式（带图标前缀，沿用现有 · 分隔风格）。

1. **步骤分组折叠（ADR-0010）**：连续的思考/工具分区合并为一个默认收起的 `collapsible_panel`，标题「🧰 运行完毕 · N 步 · X.Xs」（流式「🧰 运行中… · N 步」；定稿有步未闭合时不标状态），组内每步一个嵌套折叠面板（工具「🔧 名称 · 状态 · X.Xs · 参数」、思考沿用 ADR-0007 标题），正文与提示行打断分组。`tool_call`/`tool_result` 事件补 `at` 时间戳（omni.ts 从 OmniMessage.timestamp 带出）供每步耗时计算。文本兜底路径不变。
2. **/sessions 全量（ADR-0011）**：`listSessions` 去掉 10 条截断返回全部未归档会话；展示层截断 50 条 + 头部注明总数；`/use <n>` 口径不变。
3. **HTML 页交付（ADR-0012）**：远程回复里的 a2ui / mermaid 等富内容，Bridge 用 answer-me-with-html 的渲染器生成单文件 HTML，随 Run 定稿一并作为文件消息发进聊天；飞书卡片保持现状（正文 + 分组折叠），HTML 是「点开即看」的富载体。详见 ADR-0012 与 GLOSSARY「HTML 页」词条。
