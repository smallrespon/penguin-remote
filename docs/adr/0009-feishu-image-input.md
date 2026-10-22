# 飞书图片入站：下载并随任务投递

飞书入站消息里的图片（含富文本消息内嵌图片）要被真正送进 Agent：Bridge 用 bot 身份把图片二进制下载下来，base64 成 data URL，作为 `image_url` part 与文本一起投递到会话 API。动因是用户原话：「llm-homework 这个工作区的最新的对话发送不了图片」——此前图片只是以 `![Image](img_key)` 占位文本的形式发给了 Agent，模型看不到图。

**Status**: accepted (2026-10-22)

**背景（两端能力事实，均已实测）**：lark-cli 的 `event consume` 把消息 content 预渲染为可读文本，图片统一渲染为 `![Image](img_xxx)` 占位符（其文档明示「Image messages appear as placeholders such as `![Image](img_xxx)`」）；二进制要用 `lark-cli im +messages-resources-download --message-id <om_xxx> --file-key <img_xxx> --type image` 下载（bot 身份可行，输出落在允许目录内，实测 57KB 作业图下载成功）。PenguinHarness 会话 API 的 `POST /api/sessions/:id/tasks` 接受 `input` 数组，除 `{type:"text"}` 外还接受 `{type:"image_url", imageUrl}`——http(s) URL 或 base64 data URL（服务端 inline 上限 20MB）；实测同一会话里 text + image_url 两个 part 一起投递成功，模型正确读出了图里的「注意力权重矩阵」表格内容。

**决策**：

- 解码即提取：`decodeMessageEvent` 从预渲染文本中提取 `!?\[Image\]\(([^)\s]+)\)` 匹配出的图片 key，收进 `IncomingMessage.images`，并把占位符从文本中移除（Agent 收到的是干净文本，不是占位符）；`message_type` 白名单从 text/post 扩到含 `image`（纯图片消息的渲染同样带占位符）。文本为空但有图片 = 合法消息（按用户拍板：只投递图片，不注入占位文本）。
- 下载经 Channel 适配器：接口新增 `downloadImage(messageId, fileKey)`，由 Feishu 适配器用 `im +messages-resources-download` 落临时文件（`os.tmpdir()` 下唯一文件名）、读字节、删临时文件后返回二进制；临时文件即用即删，失败也清理。
- 转换在纯函数模块 `src/images.ts`：按魔数嗅探 mime（JPEG/PNG/GIF/WebP），拼 `data:<mime>;base64,...` data URL；字节数超过服务端 20MB inline 上限的图片**跳过**，并在输入文本里注明「（有图片超过 20MB 上限，未发送）」——按用户拍板的降级策略，不因单张大图让整个任务失败；嗅探不出 mime 的同样跳过并注明。
- 投递即拼装：`RunSpec` 增加 `images: string[]`（data URL 数组）；`SessionClient.startTask` 的入参从纯字符串扩为「字符串或 part 数组」——有图片时发 `[{type:"text"},…{type:"image_url"}]`，无图片时行为与现在逐字一致（单 text part）。纯图片消息（文本为空）只投 image_url parts。
- 范围只限图片：文件（file）、音频、视频类消息维持不响应；回复方向（Agent → 飞书）的图片输出不在本次范围。

**Consequences**: 用户在飞书里发图片（带文字或不带）即可让模型看图，llm-homework 这类「拍题」场景可直接用。代价与边界：`IncomingMessage`/`ChannelAdapter`/`RunSpec`/`startTask` 签名扩展（测试替身同步更新）；多张图会放大请求体（base64 约 +33%），受服务端 20MB/图与整体 body 上限约束，超限图按上述策略跳过；data URL 在内存中经手，不写 `runs.jsonl`、不进日志（与思考全文同级的保密口径）；图片 key 只在下载瞬间出现在 lark-cli 参数里，参数经 `runCommand` 走脱敏日志。

**Considered Options**:
- 把图片先落到工作区目录、只在文本里给模型路径：模型侧读不读、何时读不可控，且工作区可能只读；data URL 是服务端文档化的 inline 路径，实测模型确实看了图。放弃。
- 让 Agent 侧拿图片 key 自己调飞书 API：Bridge 才是持有飞书身份的一方，Agent 没有飞书凭据。放弃。
- 大图转用 `file` attachment part（服务端也支持）：语义从「看图」变成「附件」，模型用法不同；且 20MB 以下的常见图片走 inline 更直接。留作后续可选增强，本期不做。
