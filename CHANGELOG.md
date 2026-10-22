# 变更记录

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [未发布]

### 文档与 /help 同步（对齐 v1.6 实际行为）

- **`/help` 补进命令清单**：帮助文本与 README 命令表此前都漏了 `/help` 本身，现在它是命令列表第一项（「显示本帮助」）。
- **`/help` 命令摘要与真实行为对齐**：`/sessions` 注明「没设 `/workspace` 的聊天不限定工作区并注明」；`/use` 明确只切 `/sessions` 列表里的会话；`/model` 注明「列出前 30 个可用模型并注明总数」；`/thinking` / `/workspace` 注明「下一新会话生效」；`/status` 补「上次 Run 用量」；`/project` / `/agent` 注明换 Project/Agent 即换对话；末尾补「可带图片，超过 20MB 的图跳过并注明」。
- **README**：命令表补 `/help` 行；`/sessions` 行补粗体序号 `**N.**` 与「当前会话不在列表里时注明去向」；回复示例用例数 295 → 303；「已知限制」里的端到端验证状态刷新为 v1.2–v1.6 均已完成真人验收（原文还写着 v1.2 验收待进行）。
- 测试 303 全绿（`/help` 断言补 `/help` 自身与「当前工作区未归档」「不限定工作区」两个口径），typecheck / build 通过。

## [1.6.0] - 2026-10-22

/sessions 收窄到当前工作区 + 序号两位数修复（ADR-0013）。用户原话（v1.5 验收后的返工）：「我要改的是输入 /sessions 显示当前工作区未归档的对话，你再好好检查一下」「而且要实时获取，而且序号你也命名错了，序号只显示了个位数，不能显示两位数以上的」。

### 变更

- **/sessions 按当前工作区收窄**（ADR-0013）：`SessionClient.listSessions` 新增可选 `workspace` 过滤（服务端列表条目本就带 `workspace` 字段，过滤与已归档过滤同在客户端；不传 = 不限，旧行为逐字等价），条目新增 `workspace` 字段；网关传 `binding.workspace`，回复头部限定工作区时写明「**未归档会话**（工作区 `xxx`，共 N 个）」，空列表文案同样带工作区名；当前会话不在收窄后的全量列表里时（典型：设了 `/workspace` 却正续接着别的工作区的会话，或它已被归档）在回复里注明去向，不让它凭空消失——空列表时同样注明，且不再谎称「发一条消息就开始新的对话」（还绑着旧会话时下一条消息是续接）。`/use` 仍打同一份收窄后的列表。
- **没设 /workspace 的聊天不限定工作区**：服务端对不传 workspace 的新建会话每次现配一个临时工作区（`agents/<agent>/workspaces/tmp-*`），按工作区过滤只会得到空列表；这种聊天继续看全部未归档会话，头部如实注明「未限定工作区」。与 `/status` 的「临时工作区」口径一致。绑定里的空串 / 纯空白按「没设」算。
- **序号改粗体 `**N.**`**：行序号从 markdown 有序列表（`1. `）改为粗体序号——飞书 post 的 `md` 按 CommonMark 渲染，行首 `N. ` 会被当成有序列表、序号交给渲染器重排，两位数以上不可靠；粗体序号在任何渲染器下原样显示，且与 `/use <序号>` 严格一致。
- **路径归一**：新增 `normalizeWorkspacePath`（去尾斜杠、整串斜杠兜底回根目录）：用户手敲 `/workspace /root/x/` 与服务端返回的 `/root/x` 必须能对上，否则过滤永远不命中、列表凭空变空。
- **新增 ADR**：`docs/adr/0013-sessions-current-workspace.md`；PLAN §19、GLOSSARY「工作区（当前工作区）」词条与 README 命令表同步。

### 工程

- 测试 295 → 303 个全绿（新增：工作区过滤 / 不限工作区 / 尾斜杠与根目录归一 / 网关工作区收窄 / 工作区为空提示 / 空提示不谎称新开对话 / 当前会话越界注明 / 排名超 50 不误报），`pnpm typecheck` / `pnpm build` 通过。
- 真机验证（生产代码路径 + 真实服务端探针 + 飞书实发）：私聊（`workspace=/root/zhongjianxuezhanglunwen`）从 73 条全量收窄到该工作区的 3 条并注明当前会话去向；测试群（未设工作区）仍列全部 73 条、展示 50 条并注明「未限定工作区」，`**1.**`–`**50.**` 两位数序号正常。
- 子代理评审（Standards + Spec）后落实整改：空列表文案不再谎称「发消息就开新对话」、去向注明不猜原因（归档也会触发）、`workspace: ""` 按未设处理、`//` 路径归一兜底、CHANGELOG 测试计数更正。

## [1.5.0] - 2026-10-22

步骤分组折叠 + /sessions 全量 + HTML 页交付（ADR-0010 / ADR-0011 / ADR-0012）。用户原话：「思考和工具调用等等能被折叠在一起形如图片所示，运行完毕那两步可以被折叠」「我要支持的 /sessions 能展示当前工作区未归档的所有对话，然后 use 支持跳换到那次对话」「要支持对 a2ui 的 ui 图的渲染在飞书中，或者找类似的解决方法，或者可以用 answermewithhtml 找办法」。

### 变更

- **步骤分组折叠**（ADR-0010）：连续的思考与工具调用分区合并为一个默认收起的 `collapsible_panel`，标题「🧰 运行完毕 · N 步 · X.Xs」（流式「🧰 运行中… · N 步」；定稿有步未闭合时只标「🧰 N 步」——拿不到终态不谎报完毕）；组内每步一个嵌套折叠面板（工具「🔧 名称 · 状态 · 耗时 · `参数`」、思考沿用 ADR-0007 标题），正文与提示行打断分组。`tool_call` / `tool_result` 事件补 `at` 时间戳（omni.ts 从 OmniMessage.timestamp 带出），组耗时与步耗时都按事件时间戳真实计算。超 20KB 预算时**整组丢弃**（靠中间的优先）并标注真实省略的分区数。单步不成组。文本兜底路径不变。
- **/sessions 全量**（ADR-0011）：`listSessions` 去掉 10 条截断，返回当前 Project/Agent 下全部未归档会话（仍按 `lastActiveAt` 倒序）；展示层截断到 50 条，头部注明「共 N 个未归档会话」，超 50 注明「显示最近 50 个，更早的会话未列出、暂不可 `/use` 跳转」；`/use` 序号口径不变。本地 Registry 兜底保持 `HISTORY_LIMIT=10`，头部用「本地历史会话」口径，不冒充全量。
- **HTML 页交付**（ADR-0012）：Run 定稿后从定稿文本提取 `.html` 绝对路径链接（amwh 尾链 / `file://` URL / `-o` 自定义路径），校验存在、是文件、扩展名、大小 ≤ 20MB 后，经 `im files create` 拿 file_key → `im +messages-send --msg-type file` 发文件消息；被转发的链接在定稿前剥掉（对 `outcome.text` 与流式正文分区同构应用，`finalParts` 比较口径不被破坏）。配置 `AMWH_RENDER_SCRIPT` 指向 answer-me-with-html 渲染器时，含 ` ```a2ui ` / ` ```mermaid ` 围栏且无自产页面的回复自动渲染成单文件 HTML 一并发出：a2ui → ask（`*` 标推荐项）/ 表格 / 编号列表 / callout / kv 映射，mermaid 仅保守转换可无损解析的简单 flowchart / sequenceDiagram，其余保留代码围栏（宁可留源码，不产出错图）。渲染器不 vendor 进仓库，由 `@ported/answer-me-with-html` 插件分发。提取不到 / 校验不过 / 发送失败都只记日志，不影响卡片定稿。
- **新增 ADR**：`docs/adr/0010-step-grouping.md`、`docs/adr/0011-sessions-full-list.md`、`docs/adr/0012-html-page-delivery.md`；PLAN §18 与 GLOSSARY「步骤分组 / HTML 页」词条同步。

### 评审整改

- **兜底列表头部口径诚实化**：`/sessions` 兜底路径头部从「未归档会话」改为「本地历史会话」——本地 Registry 历史不保证未归档，两来源词汇区分落到头部（v1.4 评审整改只区分了空列表文案）。
- **README 与代码对齐**：`/sessions` 行改「全部未归档 + 50 条截断」口径；回复示例与两处描述改步骤分组形态。
- **ADR 勘误**：ADR-0012 的 callout tone 映射按 amwh 实际四档（info/ok/warn/err）改写；剥链范围限定为链接形态（正文裸路径原样保留，文件消息已把内容带进聊天）。
- **消重**：`escapeRegExp` 收敛到 `src/text.ts` 单一实现（原 feishu / htmlpage / test 三份拷贝）；组耗时与步耗时统一为 `spanLabel`（`thoughtPanelTitle` 不再可能出现 `NaNs` / 负耗时）；`sessionListFor` 两分支共用 `capEntries` 截断；删除无人使用的 `RenderPageOptions.nodeBin`；`discardArtifact` 的 `ours` 改名 `weOwnParentDir`。
- **PLAN §8 目录树补齐**缺失的 9 个源文件（budget/card/htmlpage/images/logger/proc/runlog/tiers/text）。

### 工程

- 测试 237 → 295 个全绿，`pnpm typecheck` / `pnpm build` 通过。
- 双轴评审（Standards + Spec，固定点 v1.4 合并点 `fd8d66b`）后落实上述整改。
- 真机验收通过：分组折叠卡（「🧰 运行完毕 · 2 步 · 17.5s」，组内思考/工具嵌套面板、正文打断分组）；`/sessions` 72 个未归档会话截断展示 50 条并注明总数；mermaid + a2ui 回复自动渲染成 `page.html` 文件消息端到端送达（下载验证：流程图与带「建议」标记的选择面板均正确渲染），临时产物发后即删。
- SEA 单文件二进制本次构建成功（`releases/penguin-remote-linux-x64`，118MB；无配置 fail-fast、有配置正常启动并优雅退出，均已冒烟验证）。

## [1.4.0] - 2026-10-22

会话列表实时化 + 飞书图片入站（ADR-0008 / ADR-0009）。用户原话：「我发现你换对话时不能实时监测当前工作区未归档的对话，这样的话我也不能直接跳转到在远程新添加的对话」「llm-homework 这个工作区的最新的对话发送不了图片」

### 变更

- **会话列表实时化**（ADR-0008）：`/sessions` 与 `/use` 改查服务端 `GET /api/projects/:p/agents/:a/sessions`——当前 Project/Agent 下未归档会话，按最近活跃倒序前 10 条；在 Web 界面 / CLI / 其他客户端远程新建的对话也能直接看见并跳入。查询失败（网络错误 / 非 2xx）时退回 Registry 本地历史，并在回复首行注明「⚠️ 实时列表查询失败，显示本地历史」。本地历史从「列表主来源」降为「兜底来源 + 审计轨迹」。
- **图片入站**（ADR-0009）：入站消息里的 `![Image](img_key)` 占位符在解码时提取为图片 key 并从文本移除（`message_type` 白名单扩到含 `image`；纯图片消息合法）。Channel 适配器新增 `downloadImage`（lark-cli `im +messages-resources-download`，临时文件即用即删）；`src/images.ts` 按魔数嗅探 mime、拼 base64 data URL。`startTask` 入参扩展为「字符串或 part 数组」，有图片时投 `[{type:"text"},…{type:"image_url",imageUrl}]`——服务端契约：type 是 `image_url`、字段名是驼峰 `imageUrl`。
- **边界**：只发图片不带文字时只投 image parts（不注入占位文本）；超过服务端 20MB inline 上限或嗅探不出 mime 的图片跳过，并在输入文本里注明；文件 / 音频 / 视频类消息仍不响应；data URL 不落 `runs.jsonl`、不进日志。
- **新增 ADR**：`docs/adr/0008-live-session-list.md`、`docs/adr/0009-feishu-image-input.md`；PLAN §4.3 / §5 / §17 与 GLOSSARY 同步。

### 评审整改

- **临时文件清理按实际落盘路径**：`downloadImage` 的清理从「只删请求路径」改为「删信封回报的 `saved_path` + 兜底删请求路径」——lark-cli 可能补扩展名，只删 `--output` 会给不一致时留下残留。
- **占位符正则收敛单一出处**：`IMAGE_PLACEHOLDER` 与提取逻辑从 `channels/feishu.ts` 移到 `src/images.ts`（GLOSSARY 领域概念的单一出处），gateway 的标题清洗改导入 `stripImagePlaceholders`，消除两处重复定义。
- **空列表文案区分来源**：实时列表为空提示「当前 Project/Agent 下没有未归档的会话」，本地兜底为空才提示「还没有历史会话」——避免混淆两个词汇。
- **标题函数统一**：`flattenTitle(title, emptyLabel)` 同时服务会话行与本地历史标题；兜底注明提取为 `withFallbackNote`。
- **纯图片消息占位符形状实测修正**：真机验收发现 lark-cli 对纯图片（`message_type=image`）消息渲染成 `[Image: img_key]`（带冒号），而非富文本内嵌的 `![Image](img_key)`——旧正则漏掉这种形状，纯图片消息的 key 提取不到。`IMAGE_PLACEHOLDER` 改为双形状匹配（`matchAll` 双组取值），GLOSSARY 与 ADR-0009 同步记录两种形状，各补测试。修后纯图片消息真机复测通过（模型正确读到图内表格，输入文本干净）。

### 工程

- 测试 197 → 237 个全绿，`pnpm typecheck` / `pnpm build` 通过。
- 双轴评审（Standards + Spec，固定点 v1.3 合并点 `6abff9a`）后落实上述整改。

## [1.3.0] - 未发布

Run 回复卡片里「思考」分区从一行标签改为默认收起的折叠面板，工具折叠面板标题补上运行状态标识（ADR-0007，逆转 ADR-0006「思考不存全文、不进面板」）。用户原话：「再修改一下，我发现你的回复中有部分思考和工具可以折叠，标识好像是运行完毕，主要在正文之间，这个能不能做」

### 变更

- **思考进折叠面板**：思考分区改为默认收起的 `collapsible_panel`，面板内是完整思考全文——先 `redact()` 脱敏再按每面板 2000 字上限头尾对半砍、中间标注省略字数，围栏代码块保真（思考文本可能含 markdown 记号与 ```，直接渲染会撑破卡片）；预览与定稿都默认收起，预览期面板同样放累积全文（同一 2000 字上限），随节流 patch 增长。
- **折叠块状态标识**：标题带「运行中… / 运行完毕」。思考标题「🧠 思考 · 运行中… · N 字」（流式）/「🧠 思考 · 运行完毕 · N 字 · X.Xs」（定稿，耗时按事件时间戳真实计算）；工具标题「🔧 名称 · 运行完毕 · 参数」（收到 output）/「🔧 名称 · 运行中… · 参数」（未收到 output），状态紧跟工具名，与思考标题「名称 · 状态 · 详情」语序一致。
- **预算优先丢思考面板**：超预算时先把思考面板当丢弃首选（靠中间的优先），保住工具轨迹与正文答案；思考丢光仍超预算，再按现有规则从中间丢其他分区。文本兜底路径的预算口径不变（`render.ts` 的 `fitMiddleDropping` 原样保留）。
- **定稿未闭合的思考不标状态**：定稿时仍未闭合的思考段（始终没等到 `thinking.done`）标题不带状态词，沿用「🧠 思考 · N 字」——拿不到终态，不谎报「完毕」。
- **文本兜底路径不变**：思考在文本消息里仍是一行标签（文本消息没有折叠载体），「运行完毕」等状态词只出现在卡片路径。
- **ADR-0007**：新增 `docs/adr/0007-thinking-panel-state.md`，记录对 ADR-0006 的逆转——「避免刷屏」由折叠机制本身满足（收起态只占标题一行），而用户明确要「可以折叠、点开能看」。

### 工程

- 测试 190 → 197 个全绿，`pnpm typecheck` / `pnpm build` 通过。
- 新增 `docs/adr/0007-thinking-panel-state.md`。

## [1.2.0] - 2026-10-22

Run 回复从文本消息改为飞书交互卡片（ADR-0006）：工具调用收进可折叠面板，预览与定稿经 `im messages patch` 更新同一张卡。用户原话：「工具调用和思考过程可以折叠吗，像 zcode 一样，工具调用太长了。」

### 变更

- **回复承载换交互卡片**（Card 2.0）：占位消息、流式预览、定稿全部改为卡片，三态共用同一张卡；实测 patch 没有文本消息那种单条 20 次的编辑上限（连打 27 次全过），长任务不再换新消息续接预览。
- **工具调用折叠面板**：每个工具调用渲染为一个默认收起的 `collapsible_panel`，标题行「🔧 名称 · 截断参数」，点开展示参数与 output（保留末尾 8 行、每行 ≤100 字符，超出显式标注「已截断，共 N 行」）。
- **状态 header 与用量页脚**：header 只放状态文案（🦐 思考中… / 🦐 执行中… / ⏳ 请稍候 / ✅ 完成 / ❌ 未正常完成）；定稿页脚 = 分割线 + 用量行，文案与旧文本版一致。
- **思考保持一行标签**：「🧠 思考 · N 字 · X.Xs」（12px notation 字号），不存全文、不进面板；正文永远展开，审批与压缩提示保持普通行。
- **预算与降级**：超限沿用「中间省略 N 个分区」，另加约 20KB 预算防撞 patch 的 30KB 内容上限与单卡 200 元素上限；卡片路径 patch 失败即放弃预览，定稿仍新发一张卡片（结果不丢），只有卡片发送也失败才退回原有文本降级链路（文本渲染路径保留为兜底，不删除）。
- **边界不变**：`/status`、`/help` 及命令级的忙提示、错误提示等非 Run 消息仍是文本消息，不走卡片；`tool_call_output` 事件不带错误字段，单工具失败无视觉标记，Run 级失败照旧整体呈现。

### 评审整改

- **忙提示不再留僵尸卡**：Run 中撞上会话忙（409）时，占位卡片直接 patch 成「⏳ 请稍候」卡（蓝色 header + 忙提示文本），不再对卡片消息发文本 edit；命令响应里的忙提示（Lane 忙）仍是文本消息。
- **Run 级失败用错误卡呈现**：会话准备失败 / 断流失败时，占位卡 patch 成红色「❌ 未正常完成」错误卡，body 为脱敏后的错误文本。
- **卡片路径取消换消息续接**：预览 patch 失败即放弃预览，定稿仍会新发一张卡片，结果不丢；「patch 失败换新消息续接」只属于文本兜底路径（对应飞书文本消息单条 20 次编辑上限）。
- **渲染口径同源**：卡片与文本两条路径共用同一批回复分区与同一套预算装配口径（约 20KB 预算、超限先整块丢弃中间分区、展不开再段内截断），只是载体不同。

## [1.1.0] - 2026-10-21

不建 Agent + 会话走 chat 路径（ADR-0005，supersede ADR-0002 的专属 Agent 决策）。用户原话：「不能创建 agent，默认用默认 agent；每个配置都是单独的，不能互相影响；对话的创建用 chat 命令，用 chat 我想要不归档的。」

### 变更

- **传输层换会话 API**：AMSP + per-agent key → owner 令牌当 cookie 的会话 API（`penguin chat` 同款路径：建会话 → SSE 订阅 → `POST tasks` 投递）。新建会话 `source: "user"`，不再被服务端按规则归档，`penguin session ls` 直接可见。删 `src/penguin/amsp.ts` 与 `@prismshadow/amsp` 依赖（运行时零依赖）。
- **档位按聊天隔离**：`/model`、`/thinking`、`/workspace` 写进各聊天自己的 binding，建新会话时下发（model 以 `provider`+`modelId` 成对下发；thinkingLevel 建后 PATCH 钉上）；Bridge 不再创建任何 Agent，也不再改任何 Agent 的设置。换 Project 时模型/思考随项目重置，workspace 保留。
- **Bridge 自有事件模型**：新增 `src/run-event.ts`（RunEvent 联合）与 `src/penguin/omni.ts`（OmniMessage → RunEvent 纯函数翻译 + RunTracker），终局优先级 / 用量合计 / 正文拼接语义复刻原 AMSP 客户端。
- **`/agent` 保留**：只切现有 Agent，绝不创建。
- **清理**：删 `src/penguin/agents.ts`、`state/agents.json`、`.env` 的 `AMSP_API_KEY`/`AMSP_BASE_URL`（改为 `OWNER_API_BASE_URL`）；加载时把 `feishu_*` 绑定迁回默认 Agent（那些会话经会话 API 实测不可达，引用置空，历史记录按归属自然过滤）。
- **断流处置**：SSE 断流不会让服务端停止任务，显式 abort 避免僵尸任务占会话；409（会话忙）除外。

### 工程

- 新增 `test/registry.test.ts`（原无 registry 单测）；omni / sessions / runner / gateway / render 测试全部改走假会话 API。测试 148 个全绿，`pnpm typecheck` / `pnpm build` 通过。

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

### 发布产物

- `penguin-remote-linux-x64.gz`：**单文件可执行程序**（Node SEA）——Node 运行时与全部依赖编译进同一个 ELF，目标机无需 Node/pnpm，`gunzip && chmod +x && ./penguin-remote-linux-x64` 即用。仅支持 linux-x64，其他平台用 `bash scripts/build-sea.sh` 在目标机自建。
- `penguin-remote-1.0.0.tar.gz`：构建产物 `dist/src/` + 生产依赖（hoisted `node_modules/`）+ 部署文件，解压即用（需要 Node 24）。重新打包：`bash scripts/package.sh`。
- 不发布 npm 包；源码安装方式见 README「部署」。

### 已知限制

- 审批卡片闭环未做（v2 可选，见 PLAN.md §4.2）；allow-all 模式下服务端不发起审批。
- 429 退避逻辑有单测覆盖，未在真实触发场景下验证。
- 同机部署；跨机部署需自行加固（PLAN.md §7）。

[1.0.0]: https://github.com/smallrespon/penguin-remote/releases/tag/v1.0.0
