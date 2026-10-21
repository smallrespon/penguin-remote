# 档位隔离改用「按聊天存 binding + 建会话时下发」，传输整体切到会话 API

Bridge 不再创建任何 Agent，一律使用配置里的默认 Agent；/model /thinking /workspace 改为按聊天存放在 binding（`state/bindings.json`），仅在新建会话时随会话下发，聊天之间零污染。同时整个 Run 路径从 AMSP 切到 PenguinHarness 的会话 API（`penguin chat` 同款：`POST /api/projects/:p/agents/:a/sessions` 建会话 → SSE 订阅 → `POST /api/sessions/:id/tasks` 驱动），因为服务端对 AMSP 会话按规则归档，而会话 API 建的是普通会话，不归档。用户明确要求：不能创建 Agent、换 workspace 不能换 Agent、每个聊天的配置互相独立、对话创建走 chat 路径且不归档。

**Status**: accepted (2026-10-21)，supersedes ADR-0002 的「懒建专属 Agent」部分

**Considered Options**:
- 保留 AMSP、建会话后立刻 unarchive：改动最小，但档位依然没有逐次覆盖参数，按聊天隔离仍要靠建 Agent，与「不能创建 Agent」直接冲突，放弃。
- 档位继续写共享默认 Agent 的 API 设置：两个聊天立即互相污染，正是用户明确否决的，放弃。

**Consequences**: Bridge 不再持有任何 per-agent key（owner 令牌一种凭据走天下，注销 AMSP key 铸造与 429 重试逻辑）；档位改为「下一新会话生效」的字面语义——已建会话保持创建时的设置，/use 切回旧会话同理；换 Project 时重置 model/thinking（模型是项目级的，workspace 保留）；`source: api` 会话按规则归档的服务端行为仍在，只是 Bridge 不再生产它们。
