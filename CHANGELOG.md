# 变更记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-21

首个正式版本：飞书机器人 ⇄ PenguinHarness 桥接程序（Bridge）v1 全部功能，测试 123 个全绿，飞书端到端真人验收通过。

### 功能

- **消息闭环**：飞书私聊全响应、群聊 @ 才响应（自动剥离 @ 占位符）；普通文本直接作为一次 Agent Run 的输入，过程与结果流回同一条飞书消息。
- **回复分区渲染**：思考 / 工具调用 / 正文按 Run 真实时序排成有序 parts 流，加粗标签行分隔；思考标签带字数与耗时；工具调用展示截断参数（约 80 字，先脱敏后截断）与 `output:` 代码块（末尾 8 行）；定稿以 `outcome.text` 兜底，超长消息优先整块丢弃中间分区、结尾分区段内截断。
- **流式预览**：占位消息 + 节流编辑（1.5s / 300 字）；飞书单条消息编辑上限 20 次（实测）耗尽后自动换新消息续接，定稿落在最新消息上。
- **会话管理**：`/new`、`/sessions`、`/use`；绑定持久化到 `state/bindings.json`，重启后可续聊。
- **控制面命令**：`/project`、`/agent`、`/model`、`/thinking`、`/workspace`、`/skill`、`/status`、`/stop`、`/help`。
- **Owner 动态模式**：`penguin auth token` 自铸 owner 会话（不落盘）调 owner 路由；按聊天懒建 `feishu_<hash>` 专属 Agent 并铸 key（只驻内存），隔离 model / thinkingLevel / workspace 的 Agent 级全局副作用。
- **安全**：密钥打码日志、`ALLOWLIST` 访问控制（留空 = 开放）、审批 allow-all 下的策略接缝与明确提示、`state/runs.jsonl` 审计轨迹。

### 工程

- `pnpm-workspace.yaml` 显式批准 esbuild 的构建脚本：全新克隆后 `pnpm install` 直接通过，不再报 `ERR_PNPM_IGNORED_BUILDS`（pnpm ≥ 10.26 起 `onlyBuiltDependencies` 更名为 `allowBuilds`）。
- CI：push/PR 到 main 跑 `pnpm typecheck` + `pnpm test`。

### 已知限制

- 审批卡片闭环未做（v2 可选，见 PLAN.md §4.2）；allow-all 模式下服务端不发起审批。
- 429 退避逻辑有单测覆盖，未在真实触发场景下验证。
- 同机部署；跨机部署需自行加固（PLAN.md §7）。

[1.0.0]: https://github.com/smallrespon/penguin-remote/releases/tag/v1.0.0
