# 档位切换用 Owner 动态模式 + 按聊天懒建专属 Agent

换模型 / 思考程度 / 工作区采用 owner 动态模式：Bridge 用 `penguin auth token` 自铸 owner 会话，调 `PUT /api/projects/:p/agents/:a/api` 动态改当前绑定 Agent 的 API 设置，改完美下次新会话生效；首次在某聊天里改档位时，懒建一个 `feishu_<chatId 哈希>` 专属 Agent 并为它铸 key，之后该聊天的档位切换只动自己的 Agent。根源约束：model / thinkingLevel / workspace 是 Agent 级设置，run 请求不能逐次覆盖，且全局生效——不隔离的话两个聊天共用同一 Agent 会互相干扰。

**Status**: superseded by ADR-0005 (2026-10-21)——owner 动态模式本身保留（列 Project/Agent/模型仍走 owner 路由），但「按聊天懒建专属 Agent」已废除：Bridge 不再创建 Agent，档位改为按聊天存 binding、建会话时下发。

**Considered Options**:
- Profile 池：人工预建几个配好档位的 Agent，纯 key 认证、零人类凭据；但档位组合不自由、切换粒度粗。记录在案，日后想收敛凭据可回退。
- keyless 模式：不推荐，放弃认证等于放弃访问控制。

**Consequences**: Bridge 持有owner 会话令牌（只驻内存、过期前重铸、不落盘不进日志）；Agent 数量随聊天增长，需命名规范 + 按 lastUsedAt 回收的约定。
