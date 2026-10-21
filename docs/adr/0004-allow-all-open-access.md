# 审批 allow-all + 访问开放（无 allowlist）

Agent 审批模式设为 allow-all，工具调用直接执行，不弹审批卡片（审批卡片链路降为 v2 可选）；访问范围定为「任何能与机器人对话的人」，不设 allowlist——用户已确认接受这个暴露面。代价：能被机器人接收的消息 = 全权限驱动 Agent，访问控制只剩群聊 @ 闸门一道。配套措施：`/help` 常驻风险提示、README 显眼处写明暴露面、`runs.jsonl` 留审计轨迹、allowlist 代码保留为配置项（默认空 = 开放）。

**Status**: accepted (2026-10-21)

**Consequences**: 高危操作没有人工闸门，靠流式预览展示 tool_call/tool_result（截断）提供可见性；同机部署 + server 回环监听控制远端暴露面。
