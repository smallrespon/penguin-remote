# ZCode Agent 回复渲染结构调研

- 调研日期：2026-10-21
- 仓库：https://github.com/zai-org/ZCode （Apache-2.0）
- 本文包含该项目的源码摘录，许可文本与来源说明见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。
- 获取方式：`git clone --depth 1` 成功（非逐文件拉取）
- Commit：`3c5b227649371507ddc4eb46ac5133afe6db1cab`（2026-10-20 14:23:05 +0800，提交信息 "chore: sync ZCode source"）
- 版本：仓库根 `package.json` version = `3.16.2`；`apps/zcode-cli/package.json` version = `0.17.0`。浅克隆无 tag，故以 package.json 为准。

下文所有 `路径:行号` 均相对于 ZCode 仓库根目录，基于上述 commit。TUI 源码位于
`apps/zcode-cli/packages/tui/src/`（下称 TUI），Web 源码位于 `packages/ui/src/`（下称 Web）。

---

## 1. 总体架构：一次回复 = 有序 parts 列表

TUI 把一条消息建模为「角色 + parts 数组」，parts 按到达顺序排列，这是整个渲染结构的地基：

`apps/zcode-cli/packages/tui/src/app-model.ts:20-30`

```ts
export type Message = {
  content: string;
  id?: string;
  parts?: TranscriptPart[];
  role: "agent" | "system" | "timeline" | "user";
  streamProjected?: boolean;
  streaming?: boolean;
  timeline?: TimelineMessage;
};
export type TranscriptPart = TextTranscriptPart | ThoughtTranscriptPart | ToolTranscriptPart;
```

三类 part（`app-model.ts:46-71`）：

- `TextTranscriptPart`：正文，`{ text, format?: "markdown" | "plain" }`
- `ThoughtTranscriptPart`：思考，`{ text, status: "thinking" | "thought", contentCharCount }`
- `ToolTranscriptPart`：工具调用，`{ toolName, toolCallId, status, title?, detailLines[], output?, resultDisplay?, error? }`

渲染入口 `MessageRow` 按 parts 顺序分发（`app-transcript-components.tsx:146-183`）：`part.type === "tool"` → `ToolTranscriptPartView`；`part.type === "thought"` → `ThoughtTranscriptPartView`；其余文本 part → `MarkdownText`（markdown）或纯色 `text`。**「思考 / 工具 / 正文」不是三个独立区块，而是同一个有序流里的不同 part 类型**，工具调用可以夹在两段正文之间。

事件来源分两路，最终汇入同一 parts 模型：

- 流式：`app-model-streaming.ts:22-43` 处理 `reasoning_start / reasoning_delta / reasoning_end`；`app-transcript-stream.ts:57-95` 把 delta 追加/完结到 thought part；工具走 `app-tool-transcript.ts:28-101` 的 `ToolCallScheduled/Started/Progress/Result/Error`。
- 历史恢复：`app-submit.ts:88-121` 的 `restoreTranscriptPart` 把持久化 parts 重建为同一结构（thought 一律以 `status: "thought"` 复活）。

---

## 2. 各部分由谁渲染

| 部分 | TUI 组件/函数 | Web 组件 |
|---|---|---|
| 思考 | `ThoughtTranscriptPartView`（`app-thought-components.tsx:16-30`） | `ReasoningRowView`（`v4/ConversationRowView.tsx:1774-1806`）→ `Reasoning/ReasoningTrigger/ReasoningContent`（`components/ai-elements/reasoning.tsx`，衍生自 vercel ai-elements） |
| 工具调用 | `ToolTranscriptPartView`（`app-tool-components.tsx:19-80`），输入投影 `buildToolTranscriptProjection`（`app-tool-transcript.ts:107-138`） | `ToolCallBlock`（`ToolCallBlocks.tsx`）+ 每工具定制 renderer（`ToolCallBlocks/renderers/*.tsx`） |
| 工具结果 | 同上：`resultDisplay` + `output`（`app-tool-components.tsx:48-77`、`82-105`） | `renderers/ExecuteOutput.tsx`、`renderers/EditInlineDiffContent.tsx` 等 |
| 正文 | `MarkdownText`（`app-markdown.tsx:30-53`） | 同 turn 内 markdown 组件（`ConversationTurnRow`） |

---

## 3. 视觉分隔手法（TUI）

没有区块标题横幅、没有 emoji 图标，分隔完全靠「折叠标记 + 颜色 + 缩进 + 边距」：

**思考块**（`app-thought-components.tsx:32-79`）：一行可点击标签，折叠标记 `+`/`-`，颜色随状态切换（流式 accent、完成 muted），上下各空 1 行；展开后才渲染正文，muted 色、word wrap。

```tsx
const COLLAPSED_MARKER = "+";            // :13
const EXPANDED_MARKER = "-";             // :14
// :62
style: { fg: part.status === "thinking" ? palette.accent : palette.muted },
`${marker} ${label}`
```

标签文案来自 i18n：中文「思考中...」/「思考」（`apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts:308-311`），英文 "Thinking..."/"Thought"（`apps/zcode-cli/packages/i18n/src/locales/en-US.ts:311-314`）。

**工具块**（`app-tool-components.tsx:40-78`）：标题行（成功绿/失败红/运行蓝/待定黄，见 `colorForStatus` `:107-112`）→ 输入详情行（2 空格缩进、muted）→ 结果标题/diff 行（2 空格缩进）→ `output:` 标签 + 输出行（4 空格缩进）→ 错误行（danger 色）。块间用 `marginTop: 1` 分隔，不用分隔线。

**正文**：直接走 markdown 渲染（`conceal: true` 隐藏 markdown 记号本身），与思考/工具之间仅靠 margin 区分。

**用户消息**：整行换背景色 + 上下各 1 行 padding，且**不显示 speaker 标签**——设计文档 `apps/zcode-cli/docs/design/v2/tui-transcript-message-rows.md` 明确「speaker labels were visually noisy」，并规定「Do not add a configuration flag or environment variable」。代码注释同见 `app-transcript-components.tsx:113`。

**唯一的分隔线**出现在 compact timeline 行（上下文压缩提示），用居中的短横线包裹标签（`app-transcript-components.tsx:220-252`）：`${line}${center}${line}`，即 `-------- 正在压缩上下文 --------` 这种形态。

**配色**集中在主题表（`theme/defaults.ts:6-62`，dark/light 两套），组件只引用语义键 `palette.accent/muted/success/danger/warning/userMessageBackground`（映射见 `theme/legacy-palette.ts:17-31`）。

---

## 4. 流式 vs 定稿的区别

**TUI**：

- 思考：流式与定稿用同一个组件、同样默认折叠，唯一区别是 `status`（`thinking` → `thought`）带来的标签文案与颜色变化（`app-thought-components.tsx:62`、`app-transcript-stream.ts:160-176` 的 `completeActiveThoughtPart`）。**完成后不会自动展开**；展开状态下文本随 delta 实时增长。
- 正文：`MarkdownText` 接收 `streaming` 标志并透传给 opentui 的 markdown/code 组件（`app-markdown.tsx:44-53`、调用处 `app-transcript-components.tsx:136-141`）。
- 工具：pending（warning 黄）→ running（accent 蓝）→ completed（success 绿）/ failed（danger 红），只换色不换结构。

**Web**（差异更大）：

- 流式且收起时，trigger 上会显示**思考内容最后一行非空文本**作为单行滚动摘要，横向自动跟随最新 token 并加两侧渐隐 mask（`reasoning.tsx:255-266` 的 `resolveReasoningStreamingSummary`、`:301-327` 的 ResizeObserver 跟随、`:271-283` 的 mask）。
- 完成后显示「思考 · Ns」耗时（`reasoning.tsx:129-158` 计时器；`:335-359` 文案分支）。
- **默认收起是刻意设计**：`v4/ConversationRowView.tsx:1782-1786` 注释说明「流式 reasoning 默认展开会持续挤压工具和正文空间；现在 streaming/complete 都默认收起」。`autoCollapseKey`（`reasoning.tsx:66-76`）保证思考段结束时自动收起，但用户手动操作过的不覆盖。
- 展开内容区：`max-h-60` 可滚动、默认吸底跟随、左侧导线缩进（`reasoning.tsx:547-550`）；为防流式卡顿，**展开的思考按纯文本 `whitespace-pre-wrap` 渲染，不过 markdown**（`:561-566` 注释明说）。

---

## 5. 展示多少 & 截断策略

**思考内容**：TUI 展开显示**全文**（`part.text.trim()`，`app-thought-components.tsx:74`），不截断；`contentCharCount` 只记录、**不在 TUI 展示**（全仓仅 `app-model.ts:54`、`app-transcript-stream.ts:137/142`、`app-submit.ts:98` 出现，无渲染引用）。默认折叠 = 只显示一行标签。Web 同样是全文、可滚动。

**工具调用行**：每类工具定制投影（`app-tool-transcript.ts:107-138`），信息量刻意收敛：

- Read/Edit：路径收进标题 `Read <path>` / `Edit <path>`（`:255-267`、`:280-294`，注释说明旧版把路径挤占真正变更内容）
- Bash：`command / cwd / argv / timeout / background / env`（`:241-253`）
- Grep/Glob/WebFetch/Agent/Skill/TodoWrite：各有摘要行；TodoWrite 显示 `todos: N` + in_progress 预览（`:309-318`）
- 未知工具：通用 `key: value` 列表（`:329-336`）

截断与脱敏常量（`app-tool-transcript.ts:9-12`、`:372-393`）：

```ts
const MAX_DETAIL_LINES = 4;
const MAX_DETAIL_WIDTH = 100;
const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization|credential|cookie/i;
const LARGE_TEXT_KEYS = new Set(["content", "old_string", "new_string"]);
```

- 详情行：≤4 行、每行 ≤100 显示单元（`compactLines` `:372-377`，`truncateDisplay` 按终端字符宽裁剪，CJK 记 2 宽，见 `app-terminal-width.ts:6-19`、`:65-83`）
- 敏感字段值 → `[redacted]`；大文本字段 → `[N chars]`；数组 → `[N items]`；对象 → `{N keys}`（`:379-389`）
- 工具原始 output：≤8 行，每行宽 = 终端宽 - 4，超出追加 `[truncated N lines]`（`app-tool-components.tsx:8`、`:125-133`）
- diff 结果：≤12 行、每行 ≤100 宽，超出时末行替换为 `... diff truncated` meta 行（`app-tool-diff-display.ts:9-10`、`:32-37`、`:61-67`）；窄屏只保留一列行号

Web 侧 bash 输出上限是 5 行高（`max-h-[5lh]`，`ToolCallBlocks/renderers/ExecuteOutput.tsx:31`），吸底跟随、用户上滚则冻结（`:12-40`）。

---

## 6. Web 客户端的差异（附带）

- 组装单位是「turn」：`v4/ConversationTurnGroup.tsx:389-483` 把工具行、reasoning 行、正文行按 `gap-4` 等距排列；历史段可整体折叠（`AssistantHistoryStatus`，`:634-721`）。
- 连续工具调用会**分组**：explore / terminal 分组默认开、changes 分组默认关（`v4/conversationAssistantWorkItems.ts:56-59`），把一串调用合成一张组卡。
- 每个工具有独立 renderer（`ToolCallBlocks/renderers/`：ExecuteCommand、EditInlineDiffContent、agent、cua、ask-question 等），摘要行是「图标 + 类型标签 + 主文本 + 次文本 + 状态节点」结构（`ToolCallBlocks/ToolSummaryRow.tsx`）。
- 思考用 `BrainIcon` + 右侧 `ChevronRight` 旋转指示折叠态（`reasoning.tsx:375`、`:407-414`）。

---

## 7. 可配置项

- **TUI：没有**任何控制回复渲染的 env / 配置。设计文档明文规定不加配置项（`apps/zcode-cli/docs/design/v2/tui-transcript-message-rows.md` "Do not add a configuration flag or environment variable"）；全仓 `ZCODE_*` 环境变量均与渲染无关（`ZCODE_MODEL_REASONING_SEPARATOR` 只是模型输出里分隔思考与正文的字符串，用于解析，见 `apps/zcode-cli/packages/core/src/tool/handlers/model-reference.ts:149`）。
- **Web**：`messageStreamShowReasoning`（默认 true，隐藏每轮后续 reasoning）、`messageStreamShowTodos`（默认 false）、`toolGroupingExploreEnabled / toolGroupingTerminalEnabled / toolGroupingChangesEnabled`（默认 true/true/false）。定义见 `packages/shared/src/validationAppSettings.ts:534-536`，默认值注入见 `packages/ui/src/v4/SessionPane.tsx:2031-2035`。

---

## 8. 对 penguin_remote 的可借鉴点

现状对照（`src/render.ts`）：思考只累计字符数显示「🧠 思考中…（N 字）」；工具调用一行 `🔧 调用 \`name\``；工具输出 `└ ...` 截 200 字；正文直接拼接；无折叠概念、无工具参数展示。

适合照搬：

1. **parts 有序模型**（对应 `app-model.ts:20-30`）：`PreviewState` 目前把 text/thinking/tools/outputs 分成四个平行数组，丢失了「工具调用夹在两段正文之间」的顺序。改成单一有序 parts 数组后，`renderPreview` 顺序输出即可还原真实时序，这是最核心的一处借鉴。
2. **思考「标签 + 计数/可展开」而非全文**：ZCode 折叠态只显示一行「思考中.../思考」（`app-thought-components.tsx:62-64`）。飞书消息不可折叠交互，但可以流式期显示「🧠 思考中…（N 字）」、定稿后保留同样一行，**不必把思考全文贴进消息**——避免刷屏。若要给全文，可用飞书折叠块或只发摘要。
3. **工具行做成「标题 + 参数摘要」**：学 `buildToolTranscriptProjection`（`app-tool-transcript.ts:107-138`）按工具定制，例如 `Read src/foo.ts`、`Bash: pnpm test`，比 `🔧 调用 \`read\`` 信息量高一个量级；详情行 ≤4 行、每行 ≤100 字符的收敛策略也适合直接搬。
4. **脱敏与摘要化**：`SENSITIVE_KEY_PATTERN` → `[redacted]`、大文本 → `[N chars]`（`app-tool-transcript.ts:379-389`）可直接复用，防止密钥/长输出冲进飞书消息。
5. **流式/定稿的状态色与文案切换**：流式「思考中...」→ 定稿「思考」；工具 pending→running→completed/failed 用不同 emoji 或措辞（黄蓝绿红对应 ⏳/🔄/✅/❌）。
6. **截断显式标注**：ZCode 的 `[truncated N lines]` / `... diff truncated` 比静默截断更好，飞书里可写成「…（已截断，共 N 行）」。
7. **diff 渲染**：Edit/Write 结果展示结构化 diff（行号 + 增删着色，`app-tool-diff-display.ts`），飞书消息支持 markdown 代码块，可用 ```diff 围栏表达增删行。

受飞书限制需调整：

1. **没有交互折叠**：ZCode 的 `+`/`-` 点击展开、Web 的 Collapsible 都无法直接搬到飞书文本消息。替代：流式预览只给标签行，定稿消息如需全文可折叠块（飞书卡片 collapsible element）或分条发送；「展开」只能靠二次交互（如回复/按钮回调），成本高于收益，建议默认只呈现摘要级信息。
2. **没有持续动画**：流式单行摘要的横向滚动跟随、吸底、渐隐 mask 在飞书里不存在；只能靠节流编辑整条消息（现有 `shouldFlush` 机制），思考行保持静态文案即可。
3. **没有主题色系统**：TUI 的 accent/muted/success/danger 语义色在飞书里只能用 emoji 和文字语义替代，不要依赖颜色。
4. **「运行时长」展示**：Web 的「思考 · Ns」（`reasoning.tsx:335-359`）可以低成本照搬——定稿后把耗时写进标签行。
5. **分组（explore/terminal 组卡）**：Web 把连续工具调用合成一张卡节省垂直空间；飞书消息同样怕长，可把同一次 Run 内连续同类型工具调用合并为一行「🔧 Read × 3：a.ts, b.ts, c.ts」，但要注意消息编辑频控，合并宜在定稿消息做，流式预览保持逐行。
6. **配置项**：ZCode TUI 刻意不加配置；penguin_remote 若加「是否展示思考/工具详情」开关，建议放在现有 settings 体系而不是新 env，默认值参考 ZCode（思考开、详情收敛）。
