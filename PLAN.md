# 飞书 ⇄ PenguinHarness 桥接程序 — 实施计划

> 状态：计划稿（待确认开放问题后进入 P0）
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
- 编辑已发消息（流式预览用）：`lark-cli im +messages-edit --as bot --message-id om_xxx --markdown "…"`（bot only，正好匹配）。
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
│  │ (lark-cli   │   send/edit │  text/mentions)               │
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
| 流式预览 + 按平台节流（Claude-to-IM） | 占位消息 + `messages-edit` 节流（≥1s/次） |
| 内联按钮审批（Claude-to-IM） | `approval.requested` → 卡片「允许/拒绝」→ `card.action.trigger` → AMSP approvals |
| 密钥 chmod 600 + 日志脱敏 | key 只走 env / 0600 文件；日志对 `penguin_` 打码 |
| Heartbeat / Cron | v2：用 PenguinHarness 自带 `penguin schedule` 或 Bridge 内置定时 |
| Slash commands 控制面 | §5 命令集 |

---

## 4. 核心设计决策

### 4.1 传输层：AMSP HTTP/SSE，而不是包一层 CLI

- 选型：Bridge 直接以 HTTP 客户端调 `/api/amsp/v1`（用官方 `@prismshadow/amsp` 客户端或裸 SSE 解析），飞书侧用 lark-cli 子进程。
- 理由：AMSP 就是官方给外部程序设计的入口；有流式、有审批、有 abort、有会话续接；跨机只需要 Base URL + key。
- 否掉「包 `penguin run` CLI」：虽然 `penguin run --server` 支持逐次指定 `--model-id/--thinking/--workspace`，但它阻塞到任务结束、无流式、审批只能整体 allow-all，且远程场景要额外管 SSH/登录态。作为 v2 的备选运输层保留（见 4.2）。

### 4.2 换模型 / 换思考程度 / 换工作区 / 换 Project / 换 Agent：Owner 动态模式（已定）

**已定决策（2026-10-21）**：同机部署；owner 动态模式；私聊 + 群聊；审批模式 allow-all；额外要求支持换 project、换 agent。

这是本计划最关键的取舍，根源是 §2.1 的约束：model / thinkingLevel / workspace 是 Agent 级设置，run 请求不能逐次覆盖，且只在建新会话时生效。

**Owner 动态模式（v1 采用）**

- Bridge 调 owner 级路由 `PUT /api/projects/:p/agents/:a/api` 动态改 model / thinkingLevel / workspace，改完美下次 `/new`（或切换后首条消息）即用新档位开对话。
- **凭据机制（已验证，无需密码）**：同机部署下，Bridge 直接 shell `penguin auth token`（默认 TTL 1 小时，上限 30 天）铸出一个 `via="cli"` 的会话，把它当 `penguin_session` cookie 用。源码与实测确认：该会话「行为与密码登录完全一致」，能过 owner 路由的 `requireHuman`（2026-10-21 实测：铸令牌后 PUT 设置返回 200，无 cookie 返回 401）。token 只驻内存、不落盘、不进日志，过期前重铸。
- **全局副作用与隔离**：Agent API 设置是全局的——改一个 Agent 的 model，所有之后新建的 API 会话都用它。两个飞书聊天共用同一 Agent 会互相干扰。解法：**按聊天懒建专属 Agent**。某个聊天第一次需要非默认档位时，Bridge 用 owner 会话 `POST /api/projects/:p/agents` 建一个 `feishu_<chatId 哈希>` Agent，按需 PUT 它的 API 设置，并 `POST .../api/keys` 为它铸一个 key（AMSP 只认 key，不认 cookie）。之后这个聊天的换模型/思考/工作区都只动自己的 Agent，互不干扰。
- **换 Project**：AMSP 路径本身带 `:projectId`，key 按 (project, agent) 发放。Bridge 用 owner 会话拉 `GET /api/projects` 列项目、`GET /api/projects/:p/agents` 列 Agent，`/project <名字>` 切项目、`/agent <名字>` 切 Agent（切 Agent = 换对话，session 按 Agent 隔离，语义正确）。
- **换模型/思考/工作区**：`/model`、`/thinking`、`/workspace` 直接改当前绑定 Agent 的 API 设置（即时生效于下一个新会话），并回显当前值。可选档位从 Project 配置里的可用模型动态拉取（`GET /api/projects/:p/models`）。
- **审批 allow-all 的后果**：没有任何 `approval.requested`，审批卡片链路整个变成可选（ticket T8 降为 v2）。allow-all + 群聊意味着「能被机器人接收的消息 = 全权限驱动 Agent」，访问控制只剩 allowlist 一道闸，见 §7。

**备选（未采用，记录在案）**：Profile 池——人工预建几个配好档位的 Agent，纯 key 认证、零人类凭据，但档位组合不自由、切换粒度粗。若日后想收敛凭据，可回退此方案。

### 4.3 会话与「换对话」

- Registry 记录每个 chat 用过的所有 session（`run.started` 回来时落盘），`/sessions` 列最近 N 条（标题取服务端生成的标题或首条消息摘要），`/use <n>` 把绑定切回该 session，下一条消息带 `session_id` 续聊。
- 注意：AMSP 公网路由只能按 id 查单个会话，列会话靠 Bridge 自己的 Registry（OpenClaw 式「Gateway 是单一事实来源」）。
- `/new` = 清掉当前 sessionId 绑定，下一条消息新建。

### 4.4 使用 Skill

PenguinHarness 的 Skill 是 Agent 本地的 `SKILL.md` 指令包（Agent 自己 read）。Bridge 不传输 skill 内容，只做**提示词注入**：

```
/skill lark-im 帮我把这个群的纪要发出来
→ 实际 input：「请使用 skill「lark-im」完成以下任务：帮我把这个群的纪要发出来」
```

`/skill <name> on` 粘滞生效；`/skill off` 取消。skill 是否存在由远程 Agent 自己判断（它的系统提示里就列着可用 skills），Bridge 不维护清单（同机部署时可顺带扫 `agent_state/skills/` 做补全提示，非必须）。

### 4.5 流式预览与渲染

- 每条 Run 开始：发一条占位消息（markdown，内容为「🦐 思考中…」），拿到 `message_id`。
- AMSP 事件 → 增量文本：`text.delta` 累积正文；`thinking.delta` 折叠为一行「思考中…（n 字）」；`tool_call.done` 追加「🔧 调用 `name`」；`tool_result.done` 可截断追加；`run.done` 收尾（状态、请求数、token 用量）。
- 节流：每 ≥1.5s 或累积 ≥300 字符才 `messages-edit` 一次；最终定稿一次。编辑失败（频率限制）退化为「不编辑，最后一次性发总结」。
- 交互卡片不能用 edit 更新（用 patch），所以审批卡片与文本预览分开管理。

### 4.6 并发与限流

- Lane Queue：同一 `chatId` 串行；Run 进行中该聊天再来消息 → 回复「正在执行中，`/stop` 可中断」并丢弃（不排队，避免惊鹜）。
- 跨聊天并行数受 Agent 的 `maxConcurrentRuns`（默认 4）限制；收到 429 按 `Retry-After` 退避重试；409（会话忙）转化为上面的进行中提示。
- Bridge 重启 = 所有在途 Run 断流被中止 → 可接受；重启后 Registry 里的 session 仍可 `/use` 续聊。

---

## 5. 命令集（v1）

| 命令 | 行为 |
|---|---|
| `/help` | 命令列表 |
| `/new` | 新开会话（清 session 绑定） |
| `/sessions` | 列出本聊天绑定过的最近 10 个会话（序号/标题/时间/模型） |
| `/use <n>` | 切到第 n 个会话 |
| `/project` / `/project <名字>` | 列出（owner 会话拉 `GET /api/projects`）/ 切换项目；切项目 = 换 Agent = 换对话 |
| `/agent` / `/agent <名字>` | 列出（`GET /api/projects/:p/agents`）/ 切换 Agent；切 Agent = 换对话（session 按 Agent 隔离） |
| `/model <名字>` | 改当前绑定 Agent 的 API 设置里的 model，下一新会话生效 |
| `/thinking <level>` | 改当前绑定 Agent 的 thinkingLevel，下一新会话生效 |
| `/workspace <路径或名字>` | 改当前绑定 Agent 的 workspace，下一新会话生效 |
| `/skill <名字> [on\|off]` | 一次性 / 粘滞 / 关闭 |
| `/status` | 当前绑定（project/agent/模型/思考/工作区）+ 会话状态（`GET /sessions/:id`）+ 上次用量 |
| `/stop` | 中断当前 Run |
| （无命令） | 普通文本 → 直接作为 Run 输入 |

`/model`、`/thinking`、`/workspace` 的可选值从 Project 配置动态拉取（`GET /api/projects/:p/models`），不写死。首次在某聊天里改档位时，Bridge 自动为该聊天建专属 Agent（`feishu_<chatId 哈希>`）并铸 key，避免全局设置互相干扰（见 §4.2）。

群聊规则：仅当 `mentions` 含机器人时响应，并剥离 @ 占位符；私聊全响应。全局 allowlist（chat_id / open_id）之外的来源一律静默忽略。

---

## 6. 状态与数据模型

纯文本、Git 友好（OpenClaw 式）：

```
state/
├── bindings.json     # { "<chatId>": { projectId, agentId, sessionId, skill?, skillSticky?, history: [{sessionId, title, at}], updatedAt } }
├── runs.jsonl        # 每次 run 一行：chatId/sessionId/status/usage/耗时（审计与成本）
└── agents.json       # Bridge 创建的专属 Agent 与 key 的登记：{ "<projectId>/<agentId>": { chatId, keyId, createdAt } }
```

- 原子写（tmp + rename）；启动时加载，缺文件即全新。
- 密钥不进 state 文件：每个 Agent 的 key 铸出后只存进程内存 map（`agentId → key`），落盘的只有 keyId 与 Agent 归属；进程重启后按 keyId 重新铸（`POST .../api/keys`，旧 key 可留可删）。
- owner 会话令牌（`penguin auth token`）只驻内存，过期前重铸，不落盘、不进日志。

---

## 7. 安全设计

- **密钥分两类管**：
  - Agent API key（AMSP 用）：Bridge 自铸、只驻内存，日志对 `penguin_` 打码；
  - owner 会话令牌：`penguin auth token` 现铸现用，TTL 1h（可按需调大），过期重铸；全程不落盘。
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
│   ├── penguin/owner.ts     # owner 会话：penguin auth token 铸/换 + settings/keys/agents 路由
│   ├── penguin/agents.ts    # Agent 与 key 的供给：懒建专属 Agent、key 内存管理、项目/Agent 清单
│   ├── penguin/amsp.ts      # AMSP 客户端封装（runs/abort/session；approvals 留接口）
│   ├── penguin/runner.ts    # 单次 Run 生命周期（订阅→渲染→审批→收尾）
│   ├── render.ts            # AMSP 事件 → 增量 markdown
│   └── approvals.ts         # 审批卡片构建与回调
├── state/                   # 运行时状态（bindings.json / runs.jsonl）
└── scripts/start.sh         # 前台启动；systemd unit 另附
```

- 部署：`scripts/start.sh`（`node --enable-source-maps dist/index.js`）+ 可选 systemd user unit；日志滚动到 `logs/`。

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
allowlist（为空则拒绝启动）、日志脱敏、优雅退出、systemd unit、README（含同机部署说明与 `localhost` vs `127.0.0.1` 的坑）。
- **验收**：陌生人消息无响应；重启 Bridge 后旧会话可续；`/status` 输出符合预期。

---

## 11. 风险与未验证点

1. **lark-cli 长驻稳定性**：consume 的 bus daemon「最后一个消费者退出 30s 后自动退出」——Bridge 必须始终持有 consume 进程；进程异常退出要有守护重启（P5）。
2. **飞书消息编辑频率限制**未实测：节流参数（1.5s / 300 字）需按实测调整；失败要有降级路径。
3. **卡片回调链路**（仅 v2 审批模式需要）：`card.action.trigger` 的 token 只有 30 分钟、更新卡片走另一个 API——真要做时先最小验证。
4. **owner 令牌生命周期**：`penguin auth token` 默认 1 小时过期，过期后 owner 路由 401。Bridge 要主动重铸（过期前 5 分钟），重铸失败要能在飞书里提示而不是静默失败。
5. **Agent 蔓延**：按聊天懒建专属 Agent 会让 Agent 数量随聊天增长；要有命名规范（`feishu_<hash>`）+ 定期清理约定（`agents.json` 里记 lastUsedAt，长期不用的可回收）。
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
| 默认档位 | 不预设 | 走 Project/Agent 现有配置；`/model` 动态列全部可用模型 |

> 收集这类决定时用 a2ui 的 form/choice 块提问（用户偏好，2026-10-21）。
