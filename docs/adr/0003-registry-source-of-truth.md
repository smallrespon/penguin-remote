# Registry 是会话绑定的单一事实来源

每个聊天的绑定（project/agent/session/skill）与历史会话列表由 Bridge 自己的 Registry（`state/bindings.json`，原子写）持久化，不从服务端反查。AMSP 公网路由只能按 id 查单个会话，列不了「某聊天用过哪些会话」；OpenClaw 式「Gateway 是单一事实来源」在这里同样成立。`/use` 切回旧会话、重启后恢复绑定，都只认 Registry。

**Status**: accepted (2026-10-21)

**Consequences**: bindings.json 丢了等于丢历史（可接受：session 在服务端仍在，只是列表没了）；密钥不进 state 文件，Agent key 只存进程内存 map，重启后按 keyId 重铸。
