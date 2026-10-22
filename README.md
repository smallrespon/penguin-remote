# penguin-remote

[![CI](https://github.com/smallrespon/penguin-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/smallrespon/penguin-remote/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

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
| `/status` | 当前绑定（Project/Agent/模型/思考/工作区）+ 会话状态 + 上次 Run 用量 |
| `/stop` | 中断正在执行的任务 |

群聊里必须 @ 机器人才响应（并自动剥掉 @）；私聊全响应。全局 allowlist 之外的来源一律静默忽略。

## 回复长什么样

Agent 的回复是一张**飞书交互卡片**（Card 2.0）：占位、流式预览、定稿始终是同一张卡，header 显示运行状态（🦐 思考中… → 🦐 执行中… → ✅ 完成 / ❌ 未正常完成），内容按「回复分区」排成一条流——思考、工具调用、正文按 Run 的真实时序排列，工具调用可能夹在两段正文之间。每个工具调用是一个**默认收起的折叠面板**，点开才看参数与输出。异常也落在同一张卡上：Run 中撞上会话忙（409），占位卡直接变成「⏳ 请稍候」卡；会话准备失败 / 断流，占位卡 patch 成红色「❌ 未正常完成」错误卡（body 是脱敏后的错误文本）——都不会留下停在「思考中」的僵尸卡。一次渲染长这样：

````
🦐 执行中…                              ← 卡片 header 状态

🧠 思考 · 23 字 · 4.2s

🔧 exec_command · {"command":"pnpm test",…}
   折叠面板（点开展示参数与 output，保留末尾 8 行）
   （已截断，共 12 行，显示末尾 8 行）

测试全部通过，190 个用例全绿。

─────────────────────────
用量 4213 tokens
````

两种异常状态长这样（都是同一张占位卡变身，不另发消息）：

````
⏳ 请稍候                    ← 会话忙（409）：占位卡 patch 成蓝色忙卡
这个聊天正在执行中，/stop 可中断，请稍候再发。

❌ 未正常完成                ← Run 级失败（会话准备失败 / 断流）：红色错误卡
事件流在 Run 结束前中断
````

流式预览与定稿结构一致——预览是随事件流用 `im messages patch` 逐步更新出来的，定稿保留全部分区（思考标签 + 工具折叠面板 + 正文 + 用量页脚）。工具参数与输出会做密钥脱敏与截断（参数约 80 字、输出保留末尾 8 行），`state/runs.jsonl` 同样留有审计轨迹。预览更新失败时放弃预览，定稿仍会新发一张卡片；只有卡片发送本身也失败，才自动退回文本消息兜底（换消息续接只发生在这条文本兜底路径上），结果不丢。

## 前置条件

- Node 24+、pnpm
- 同机运行中的 PenguinHarness server（本机 80 端口），且目标 Agent 的 API 已开启
- `lark-cli`（1.0.98+），并且**复用已有的机器人身份**（本项目不新建飞书应用）
  - 机器人要能被拉进聊天：`lark-cli im +chat-list --as bot` 能列出来才算就绪
  - 事件订阅需要覆盖 `im.message.receive_v1`

## 部署（同机）

### 方式一：单文件可执行文件（推荐，无需 Node）

从 [Releases](https://github.com/smallrespon/penguin-remote/releases) 下载 `penguin-remote-linux-x64.gz`——Node SEA 单文件可执行程序，Node 运行时与全部依赖都已编进这一个文件：

```bash
gunzip penguin-remote-linux-x64.gz
chmod +x penguin-remote-linux-x64
cp /path/to/.env.example .env   # .env.example 取自本仓库或方式二的压缩包
# 编辑 .env 填入配置（至少 OWNER_API_BASE_URL / DEFAULT_PROJECT_ID / DEFAULT_AGENT_ID）
./penguin-remote-linux-x64      # 前台跑；Ctrl-C 退出
```

目标机只要有 Linux x86-64 就能跑，不需要 Node、pnpm 或任何安装步骤。其他平台（macOS / arm64）可在目标机上跑 `bash scripts/build-sea.sh` 自建（需要 Node 24 + pnpm 的源码检出）。

### 方式二：Release 压缩包（需要 Node 24）

从 [Releases](https://github.com/smallrespon/penguin-remote/releases) 下载 `penguin-remote-<版本>.tar.gz`：

```bash
tar -xzf penguin-remote-1.0.0.tar.gz
cd penguin-remote-1.0.0
cp .env.example .env
chmod 600 .env
# 编辑 .env 填入配置（至少 OWNER_API_BASE_URL / DEFAULT_PROJECT_ID / DEFAULT_AGENT_ID）
bash scripts/start.sh   # 前台跑；Ctrl-C 退出
```

压缩包内已含构建产物 `dist/src/` 与生产依赖 `node_modules/`，**部署机只需 Node 24**，无需 pnpm、无需联网装包。

### 方式三：源码安装

```bash
pnpm install
cp .env.example .env
chmod 600 .env          # start.sh 也会做，但先自己设好更稳
pnpm build
bash scripts/start.sh   # 前台跑；Ctrl-C 退出
```

### ⚠️ `OWNER_API_BASE_URL` 必须用 `http://localhost/...`

同机部署时基址写成 `http://localhost/api`（owner 路由前缀，会话 API 与档位清单都走它）。**不要写 `127.0.0.1`**：那条是预览端口，所有 API 请求一律返回 401。主机名部分只有这一条能用。

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

- **凭证只有一类，且不落盘**：owner 会话令牌（`penguin auth token` 现铸现用，默认 TTL 1h，过期前重铸；401 时自动重铸重试），只驻内存。会话 API 与 owner 路由都复用它——Bridge 不再持有任何 Agent API key。
- **日志脱敏**：所有日志与异常消息里的 `penguin_…` 形态密钥都会被打码成 `penguin_***`。
- **访问控制**：`ALLOWLIST` 留空 = 开放访问；填上 chat_id / open_id（逗号分隔）后，只有命中的聊天或发件人才会被响应。
- **远端暴露**：已定同机部署，server 保持回环监听即可，零暴露。改成跨机部署时请自行加 HTTPS 反代并把令牌当密码管理。
- **高危操作可见性**：allow-all 下工具调用直接执行，飞书侧按回复卡片展示每次工具调用——折叠面板标题行是工具名 + 一行截断到约 80 字的参数，点开展示 `output:`（保留末尾 8 行），参数与输出均经密钥脱敏；`state/runs.jsonl` 留审计轨迹。

## 状态文件

```
state/
├── bindings.json     # 每个聊天的 Project/Agent/会话/skill 绑定、档位（model/thinking/workspace）与最近会话（重启后恢复的唯一事实来源）
└── runs.jsonl        # 每次 Run 一行：chat/session/状态/用量/耗时（审计与成本）
```

档位（`/model`、`/thinking`、`/workspace`）按聊天存在各自的 binding 里，建新会话时下发（model 以 `provider`+`modelId` 成对下发，thinkingLevel 建后 PATCH 钉上）——Bridge 不创建任何 Agent，也不改动 Agent 的设置，一个聊天的档位不会影响其他聊天。已存在的会话保持它创建时的设置，「下一新会话生效」是字面语义；`/project` 切项目时模型/思考随项目重置（模型目录是项目级的），workspace 保留。

## 开发

```bash
pnpm test        # node:test 全量单测（含真实 lark-cli 启动/退出冒烟）
pnpm typecheck   # tsc --noEmit
pnpm build       # 产出 dist/
```

实现按 `PLAN.md`（唯一事实来源）的 ticket 逐个推进，每个 ticket 内先写测试；领域词汇见 `GLOSSARY.md`，架构决策见 `docs/adr/`。

## 已知限制

- **没有审批卡片**（v2 可选）：allow-all 模式下服务端不会发 `approval_request`。若手动把某个 Agent 的审批模式改成 `always-ask`，Bridge 会拒绝所有审批并在回复里说明，不会挂起等待。
- **端到端验证**：v1.1（文本承载）已用真人消息验证（2026-10-21，私聊 + 群聊 @ 机器人）：收消息 → 跑 Run → 同一条消息渐进编辑出结果，重启后旧会话可续，`state/runs.jsonl` 有审计行。v1.2（卡片承载）用生产同款代码路径 + 真实飞书通道在测试群完成了一次真实 Run（建会话 → 流式预览 → 定稿卡，折叠面板渲染正确）；用户在本人聊天里的验收待进行。仍未覆盖：跨多聊天的并发、断流重连（按断流处置，不重连）。
- **卡片承载的新边界**：卡片更新走 `im messages patch`，实测没有文本消息那种单条 20 次的编辑上限（连打 27 次全过），长任务不再换新消息续接；但单次 patch 内容上限 30KB、单卡最多 200 个元素，Bridge 用约 20KB 预算收敛分区（超限时中间省略 N 个分区），且飞书客户端需 ≥7.20 才能完整渲染（更旧的只看到卡片 header）。预览 patch 失败即放弃预览，定稿仍会新发一张卡片；只有卡片发送本身也失败，才退回原有文本降级链路（此时编辑失败会换新消息续接，上限 10 次），结果不丢。

## 许可

[MIT](LICENSE)

