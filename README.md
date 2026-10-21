# penguin-remote

飞书机器人 ⇄ PenguinHarness 的桥接程序（Bridge）：在飞书里给机器人发一句话，它就把这句话派给同机的 PenguinHarness Agent 执行，并把流式过程与最终结果回到同一条飞书消息里。

> ## ⚠️ 风险提示（先读这段）
>
> **任何能给这个机器人发消息的人，都能全权限驱动它背后的 Agent。**
> 默认配置下：审批模式是 `allow-all`（工具调用直接执行，不询问）、访问范围是「任何能与机器人对话的人」（不设 allowlist）。
> 也就是说，谁能给机器人发消息，谁就能让 Agent 在那台机器上跑命令、读写文件。
> 请只把机器人拉进受控聊天；要收紧访问，在 `.env` 里填 `ALLOWLIST`（见下文）。

## 它能做什么

| 命令 | 行为 |
|---|---|
| （无命令） | 普通文本直接作为一次 Run 的输入 |
| `/new` | 新开会话（上下文干净） |
| `/sessions` | 列出本聊天在当前 Project/Agent 下最近用过的 10 个会话 |
| `/use <序号>` | 切回某个旧会话续聊 |
| `/project` / `/project <名字>` | 列出 / 切换 Project（换 Project = 换 Agent = 换对话） |
| `/agent` / `/agent <名字>` | 列出 / 切换 Agent（换 Agent = 换对话） |
| `/model <名字>` | 切换模型（`/model` 列出前 30 个可用模型并注明总数；匹配 `provider/modelId`、裸 `modelId` 或显示名，不受截断影响；下一新会话生效） |
| `/thinking low\|medium\|high\|xhigh\|max` | 切换思考档位（下一新会话生效） |
| `/workspace <路径>` | 切换工作区（下一新会话生效） |
| `/skill <名字>` | 一次性使用 Skill；`/skill <名字> on` 粘滞；`/skill off` 关闭 |
| `/status` | 当前绑定（Project/Agent/模型/思考/工作区/审批）+ 会话状态 + 上次 Run 用量 |
| `/stop` | 中断正在执行的任务 |

群聊里必须 @ 机器人才响应（并自动剥掉 @）；私聊全响应。全局 allowlist 之外的来源一律静默忽略。

## 前置条件

- Node 24+、pnpm
- 同机运行中的 PenguinHarness server（本机 80 端口），且目标 Agent 的 API 已开启
- `lark-cli`（1.0.98+），并且**复用已有的机器人身份**（本项目不新建飞书应用）
  - 机器人要能被拉进聊天：`lark-cli im +chat-list --as bot` 能列出来才算就绪
  - 事件订阅需要覆盖 `im.message.receive_v1`

## 部署（同机）

```bash
pnpm install
cp .env.example .env
chmod 600 .env          # start.sh 也会做，但先自己设好更稳
pnpm build
bash scripts/start.sh   # 前台跑；Ctrl-C 退出
```

### ⚠️ `AMSP_BASE_URL` 必须用 `http://localhost/...`

同机部署时基址写成 `http://localhost/api/amsp/v1`。**不要写 `127.0.0.1`**：那条是预览端口，所有 API 请求一律返回 401。启动时配置校验会检查路径后缀，但主机名部分只有这一条能用。

### 常驻（systemd user unit）

```bash
mkdir -p ~/.config/systemd/user
cp deploy/penguin-remote.service ~/.config/systemd/user/
# unit 里写死了 /root/penguin_remote，仓库放在别处就改 WorkingDirectory / ExecStart / 日志路径
systemctl --user enable --now penguin-remote
systemctl --user status penguin-remote
journalctl --user -u penguin-remote -f     # 若 unit 用的是 append: 日志，则看 logs/bridge.log
```

## 安全设计

- **密钥分两类管，都不落盘**：
  - Agent API key：Bridge 按需自铸（`POST .../api/keys`），只存进程内存；`state/agents.json` 里只有 keyId 与归属。
  - owner 会话令牌：`penguin auth token` 现铸现用（默认 TTL 1h，过期前重铸），只驻内存。
- **日志脱敏**：所有日志与异常消息里的 `penguin_…` 形态密钥都会被打码成 `penguin_***`。
- **访问控制**：`ALLOWLIST` 留空 = 开放访问；填上 chat_id / open_id（逗号分隔）后，只有命中的聊天或发件人才会被响应。
- **远端暴露**：已定同机部署，server 保持回环监听即可，零暴露。改成跨机部署时请自行加 HTTPS 反代并把 key 当密码管理。
- **高危操作可见性**：allow-all 下工具调用直接执行，飞书侧靠流式预览展示 `tool_call` / `tool_result`（截断显示），`state/runs.jsonl` 留审计轨迹。

## 状态文件

```
state/
├── bindings.json     # 每个聊天的 Project/Agent/会话/skill 绑定与最近会话（重启后恢复的唯一事实来源）
├── runs.jsonl        # 每次 Run 一行：chat/session/状态/用量/耗时（审计与成本）
└── agents.json       # Bridge 懒建的专属 Agent 与 key 的登记（只有 keyId，没有 secret）
```

首次在某聊天里改档位（`/model`、`/thinking`、`/workspace`）时，Bridge 会自动为该聊天建一个 `feishu_<chatId 哈希>` 专属 Agent 并铸 key——因为 model / thinkingLevel / workspace 是 Agent 级设置，多个聊天共用一个 Agent 会互相干扰。

## 开发

```bash
pnpm test        # node:test 全量单测（含真实 lark-cli 启动/退出冒烟）
pnpm typecheck   # tsc --noEmit
pnpm build       # 产出 dist/
```

实现按 `PLAN.md`（唯一事实来源）的 ticket 逐个推进，每个 ticket 内先写测试；领域词汇见 `GLOSSARY.md`，架构决策见 `docs/adr/`。

## 已知限制

- **没有审批卡片**（v2 可选）：allow-all 模式下服务端不会发 `approval.requested`。若手动把某个 Agent 的审批模式改成 `always-ask`，Bridge 会拒绝所有审批并在回复里说明，不会挂起等待。
- **端到端已用真人消息验证**（2026-10-21，群聊 @ 机器人）：收消息 → 跑 Run → 同一条消息渐进编辑出结果，`state/runs.jsonl` 有审计行。仍未覆盖：私聊（p2p）路径、跨多聊天的并发、以及 429 退避（未真实触发）。
- **预览编辑有次数上限**：飞书对单条消息的编辑次数有限制（实测 **20 次**，第 21 次报 `230072`），长任务会撞上。撞上后 Bridge 会**换一条新消息继续承载预览**（可续接多次），定稿仍落在最新那条消息上；只有发送本身也失败，才退化成「最后一次性发总结」，结果不丢。
