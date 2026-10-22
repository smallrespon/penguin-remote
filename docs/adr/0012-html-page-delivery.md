# HTML 页交付：answer-me-with-html 路线

远程 Agent 用 answer-me-with-html 技能把复杂回复渲染成一页离线 HTML 时，Bridge 把页面文件送进飞书聊天（文件消息）；另外可选地把含 a2ui / mermaid 围栏的回复自动渲染成 HTML 页一并发出。动因是用户原话：「要支持对 a2ui 的 ui 图的渲染在飞书中，或者找类似的解决方法，或者可以用 answermewithhtml 找办法」——飞书卡片渲染不了 mermaid 图与 a2ui 组件块，而 answer-me-with-html 的技能约定正是「模型写草稿、CLi 渲染成单文件离线 HTML、回复末尾带页面路径」，Bridge 作为「宿主」把文件递交给用户即可。

**Status**: accepted (2026-10-22)

**背景（均已实测）**：用户已把 answer-me-with-html 打成 PenguinHarness 插件（`@ported/answer-me-with-html`，本机已装入 default_agent 的技能目录，内含 `scripts/am.mjs`）。该 CLI 是纯 JS 单文件（约 945KB，MIT，Node ≥20，运行时 4 个 npm 依赖已由其 esbuild 打包收拢），`am render -` 从 stdin 读扩展 Markdown 草稿、`-o` 出单文件 HTML，实测渲染约 0.4–1s，产物离线可开（CSP `default-src 'none'`，无 CDN）。**amwh 不渲染 mermaid / a2ui 围栏**（一律降级为代码块）——要成图必须转成它的 flow / sequence / ask / callout / kv / table 等组件语法。飞书侧：bot 有 `im:resource` scope，`im files create` 上传 HTML 成功（已探针），文件消息随卡片之后到达。

**决策**：

- **转发 agent 产出的页面（默认开启，无需配置）**：Run 定稿后，从定稿文本提取绝对路径的 `.html` 页面链接（技能约定的 `[/abs/path.html](</abs/path.html>)` 尾链、`file://` URL、`-o` 自定义路径都覆盖）；校验存在、是文件、扩展名为 `.html`、大小 ≤ 20MB（飞书文件消息量级）后，经 Channel 适配器发文件消息（`im files create` 拿 file_key → `im +messages-send --msg-type file`）。提取不到 / 校验不过 / 发送失败都只记日志，不影响卡片定稿——结果不丢是老原则。
- **剥死链**：被转发的页面**链接**在定稿文本里剥掉（飞书里点不动的本地链接没有意义）——只剥链接形态（markdown 链接 / `file://` URL）；正文里提到的裸绝对路径不是链接，原样保留（文件消息已把内容带进聊天，路径留着可溯源）。剥除对 `outcome.text` 与流式正文分区**同构**应用，保证 `finalParts` 的「流式累积 vs outcome 权威全文」比较不被单侧修改破坏（同构变换保持相等性）。
- **富内容自动渲染（opt-in）**：配置项 `AMWH_RENDER_SCRIPT` 指向渲染器（本机 `.env` 指向插件技能内的 `am.mjs`）；未配置 = 关闭。开启且定稿文本含 ` ```a2ui ` 或 ` ```mermaid ` 围栏、且没有已转发页面时，Bridge 把回复转换成 amwh 草稿后渲染成 HTML，走同一条文件消息通道发出。转换是纯函数、可离线测试；渲染失败（CLI 报错 / 超时 / 产物不存在）只记日志。
- **a2ui → amwh 组件映射**：`choice` → `ask`（`*` 标记推荐项）；`form` → 表格（字段/类型/选项/必填）；`steps` → 编号列表（warning/caution 置于步骤前、note 置于后、code 进代码围栏）；`callout` → `callout`（tone 映射 note→info、tip→ok、caution→warn、warning→err——amwh 只认 info|ok|warn|err 四档）；`metrics` → 表格；`weather`/`clock`/`countdown` → `kv`。未知类型 / 解析失败 → 原样保留代码围栏（不猜、不炸）。
- **mermaid 保守转换**：仅转换可无损解析的简单形态——flowchart/graph 的 `A[标签] --> B{标签}` / `A -- 说明 --> B` 简单边（节点标签须为无空格的简单token，否则整体留代码围栏）、sequenceDiagram 的简单消息行；出现子图 / 样式 / classDef / participant 别名等一概不转，保留 ` ```mermaid ` 代码围栏。**宁可留源码，不产出错图**。
- **不 vendor 渲染器**：渲染器由插件分发与升级，Bridge 只按配置路径调用——不在仓库里塞 945KB 第三方产物，也不与插件版本打架。代价：未配置 `AMWH_RENDER_SCRIPT` 的部署没有自动渲染（转发页面始终可用）。
- **a2ui 交互性丢失是固有边界**：choice/form 的「页面上选择 → 复制回传」回路在飞书文件里断裂，HTML 页是静态展示；README 明示。

**Consequences**: 复杂回复在飞书里有两条腿——卡片（正文 + 步骤分组，自包含）与 HTML 文件（富排版、可缩放、离线可转发的完整页面）。Bridge 新增一个可选配置项与一个纯函数模块；HTML 内容与卡片同源，不引入新的脱敏面（卡片文本本来就不脱敏，脱敏发生在工具参数与思考的渲染路径）。文件消息在卡片之后到达，顺序稳定。自动渲染每次多一次子进程调用（约 1s），只在含富围栏且配置了渲染器时发生。

**Considered Options**:
- vendor am.mjs 进仓库：Bridge 自包含、SEA 也能带；但仓库塞入 945KB 第三方产物，升级要手动同步，且与用户已建插件双轨维护。放弃（用户已入插件市场）。
- 要求远程 Agent 改输出格式（直接写 amwh 草稿）：Agent 是异构的（可切 `/agent`），把 Bridge 的正确性绑在 Agent 的行为习惯上不可靠； Bridge 侧映射对任意 Agent 一视同仁。放弃，仅作为「Agent 主动产出页面」的自然增强保留（转发机制覆盖）。
- mermaid 全量转换：flow 组件不支持 mermaid 的节点 ID 写法，语法面太大，错画的图比代码围栏更糟。放弃，只做保守子集。
- a2ui choice/form 在飞书里做成交互卡片按钮（card.action.trigger）：ADR-0006 已把审批卡片列为 v2，交互回路（回调 → 回传 Agent）整套缺失；静态展示先行。放弃。
