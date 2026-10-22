# 会话列表实时化：/sessions 查服务端

`/sessions` 与 `/use` 从「只读 Bridge 本地 Registry 历史」改为「实时查询服务端当前 Project/Agent 下的未归档会话列表」，本地历史只在查询失败时兜底。动因是用户原话：「我发现你换对话时不能实时监测当前工作区未归档的对话，这样的话我也不能直接跳转到在远程新添加的对话」——在 Web 界面或 CLI 里新建的会话，Bridge 完全看不见，更切不过去。

**Status**: accepted (2026-10-22)

**背景（服务端能力事实，均已实测）**：`GET /api/projects/:p/agents/:a/sessions` 返回该 Agent 的全部会话（`{sessions: [...]}`，含 `sessionId`/`title`/`lastActiveAt`/`status`/`archived`/`modelId`/`workspace`/`source`/`client`），`penguin session ls` 正是拉这个路由后在客户端按 `archived` 过滤（默认不含已归档，`--all` 才含）。Bridge 建的会话是 `source:"user"`、不归档，因此实时列表天然覆盖 Bridge 自己建的会话，不会出现「列出去了却续不了」的条目。

**决策**：

- `/sessions` 每次执行都实时拉取当前 binding 的 (project, agent) 下**未归档**会话，按 `lastActiveAt` 倒序取前 10 条展示（序号/标题/最近活跃时间/模型/sessionId），当前绑定会话用 `→` 标出；文案提示 `/use <序号>` 切回去续聊。
- `/use <n>` 对同一份实时列表按序号切会话，不再局限于本地历史——远程（Web / CLI / 其他客户端）新建的未归档会话可直接跳入续聊。
- 查询失败（网络错误 / 非 2xx）时退回本地 Registry 历史（现有 `sessionsFor` 行为），并在回复里注明「实时列表查询失败，显示本地历史」——结果不丢，老行为降级为兜底而不被删除。
- 列表条目只展示不修改：`/use` 只改本聊天 binding 的 `sessionId`；会话的创建、归档、删除仍归服务端与其他客户端，Bridge 不代劳。
- 本地历史（Registry `history`）的记名职责不变：Run 结束后仍 `noteSession` 落盘，作为查询失败时的兜底来源与审计轨迹。

**Consequences**: 用户在任何一个客户端新建的对话，飞书里 `/sessions` 都能看到并跳入；列表从此与服务端真实状态一致（包括别人正在跑的会话，其 `status` 可展示）。代价：`/sessions` 多一次 owner 路由请求（已有令牌复用，无额外登录态）；标题来自服务端（最长 120 字符、可能含换行），展示前需拍平换行并截断；本地历史里已被归档或删除的会话不再出现在默认列表（这正是「未归档」的语义，`--all` 式全量视图留作后续可选增强）。Registry 的 `history` 从「列表主来源」降为「兜底来源」，`sessionsFor` 与 `HISTORY_LIMIT` 保留供兜底路径使用。

**Considered Options**:
- 服务端列表 + 本地历史合并展示：能把已归档/已删除的旧会话也列出来，但两种来源的语义与可信度不同，混排会让用户对「哪些能跳」产生误解；且用户要的就是「未归档的实时监测」。放弃合并，本地历史只作兜底。
- 轮询推送新会话提醒（如「有新会话创建」主动通知）：用户只要求「能看见、能跳」，不需要打扰式通知。放弃。
- 继续自持列表、由 Bridge 同步服务端：需要额外的同步机制与冲突处理，比每次实时查询更复杂且仍有窗口期。放弃。
