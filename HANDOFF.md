# HANDOFF — 全自动实现交接（2026-10-21）

给接管这个仓库的新会话：**全自动完成实现阶段**。除下面「只有这些才停下」列出的情况，不要停下来问问题，自己定、自己验、自己提交。

## 上下文（先读这些，别重查）

- 工作区 `/root/penguin_remote`；仓库 `smallrespon/penguin-remote`（私有，main）。
- 唯一事实来源 `PLAN.md`（12 节；§12 决策表）。领域词汇 `GLOSSARY.md`；架构决策 `docs/adr/0001–0004`。
- Spec：issue #1；Tickets：issue #2–#10（T1–T9），全部 `ready-for-agent`，阻塞边已在 GitHub 连好。
- 代码尚未开始：无 `src/`、无 `package.json`、无测试。
- 工作区记忆里有已验证事实清单（owner 令牌链路、AMSP 基址、可用路由），与本文不冲突时以本文为准。

## 任务：按 matt 技能链把 T1–T9 全部实现完

1. 读 issue #1 与 #2–#10（`gh issue view <n>`）。
2. 用 `/implement-spec` 把 spec 当任务图并行推进；或按 frontier 逐个 `/implement`：#2/#3/#4 先开工，#4 依赖 #2+#3，之后 #6/#7，再 #10；#8（审批卡片）是 v2 可选，放最后或明确跳过并在收尾说明。
3. 每个 ticket 内驱动 `/tdd`：只写在 PLAN §9「第 4 步」约定并经用户确认的 seam 上——Channel 适配器接口（send/edit/onMessage）、AMSP 客户端（runs/abort/session，mock 传输层）、命令路由器（纯函数解析）、Registry（文件读写）、渲染器（AMSP 事件→增量文本）、Lane Queue（并发语义）。
4. 每个 ticket 完成：typecheck + 单测 + 全量测试全绿 → `/code-review`（Standards + Spec 双轴）→ 修完再下一个。
5. 全部完成后 `/pr` 写 PR body 并开 PR（推 main 也行，收尾时说明选了哪条）；最后跑 `/retro`。

## 硬约束（直接遵守，不要重新论证）

- 同机部署；AMSP 基址 `http://localhost/api/amsp/v1`。不要用 `127.0.0.1`——会 401。
- owner 凭据：同机 shell `penguin auth token`，把令牌当 `penguin_session` cookie 调 owner 路由（实测可过 requireHuman）。令牌只驻内存，不落盘、不进日志，过期前重铸。
- 审批 allow-all；访问范围开放（不设 allowlist）。但群聊必须 @ 机器人才响应，`/help` 里常驻一句风险提示。
- 换 project / 换 agent：`/project`、`/agent` 动态拉取（`GET /api/projects`、`GET /api/projects/:p/agents`）；切 Agent 即换对话（session 按 Agent 隔离）。
- 档位切换：`PUT /api/projects/:p/agents/:a/api`。首次在某聊天改档位时，懒建 `feishu_<chatId 哈希>` 专属 Agent 并铸 key（key 只存内存），避免全局设置互相污染。
- Node 24；先装 pnpm；运行时依赖尽量只有 `@prismshadow/amsp`。
- 机器 2GB 内存：并发 run 默认 ≤4；测试并行度别炸内存。
- 飞书侧复用现有 lark-cli bot 身份（`cli_a735aad03efa9013`，已就绪），**不要新建飞书应用**。

## 自主决策授权（直接定，不要问）

默认档位（走 Project 现有配置）、节流参数（先 1.5s / 300 字）、目录与文件命名（按 PLAN §8）、测试框架（Node 内置 `node:test` 优先，不够再 vitest）、commit 粒度（每 ticket 1–2 个）。

## 只有这些情况才停下来报告

- 需要人类在飞书开放平台或 GitHub 网页上操作（预期不需要）；
- 三个未实测风险出现反预期结果：lark-cli 长驻稳定性、飞书消息编辑频率、卡片回调（最后这个是 v2）；
- 要执行破坏性操作：删 key、删 Agent、reset 之类。

## 完成时的交付

- 全部 ticket 关闭、测试全绿、PR 已开（或已推 main）。
- 一段收尾说明：做了什么、验证了什么、**哪些没验**（预期：飞书端到端需要真人发消息）、用户验收步骤（飞书里私聊或 @ 机器人发一句话，看是否回复）。
