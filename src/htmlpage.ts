// HTML 页交付（ADR-0012）：远程回复里的富内容变成飞书聊天里的单文件 HTML。
//
// 两层分工：
// - 纯函数（extractPagePaths / stripPageLinks / hasRichBlocks / toDraft）：页面引用的识别、
//   死链剥离、a2ui 与 mermaid → answer-me-with-html 草稿的转换。全部可离线单测。
// - 薄 IO 壳（checkPage / renderPage）：碰文件系统与子进程的地方，子进程执行方式与临时路径
//   都可注入，测试不跑真实渲染器、也不往磁盘写东西。
//
// 渲染器不 vendor 进仓库（ADR-0012）：由 answer-me-with-html 插件分发，Bridge 只按配置路径调。

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runCommand } from "./proc.js";

/** 飞书文件消息的量级上限：超过这个量级的页面不上传（上传会失败，也超出「一页」的体感）。 */
export const HTML_PAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 草稿标题的截断长度。 */
const TITLE_LIMIT = 30;

/** 渲染产物的 stderr 摘录长度：够看清原因，又不把整页刷进日志。 */
const STDERR_EXCERPT = 500;

// ---- 页面路径提取 ----

/**
 * 定稿文本里的三类页面引用，一条正则同时认，避免同一个链接被认两遍：
 * markdown 链接（`[label](</abs/path.html>)`，尖括号可选）、`file://` URL、裸绝对路径。
 * 后两种只在不是链接时才会出现——链接整体被第一种形态吃掉。
 */
const PAGE_TOKEN_RE =
  /\[[^\]]*\]\(\s*(?:<([^<>]*)>|([^\s)]*))[^)]*\)|file:\/\/[^\s"'`)\]<>]*\.html\b|(?<![\w./$-])\/[^\s"'`)\]<>]*\.html\b/gi;

/** 链接目标 → 可校验的绝对路径；相对路径与非 .html 一律不收（返回 null）。 */
function normalizeTarget(target: string): string | null {
  let path = target.trim();
  if (path.startsWith("file://")) path = path.slice("file://".length);
  if (!path.startsWith("/")) return null;
  if (!path.toLowerCase().endsWith(".html")) return null;
  return path;
}

/** 提取定稿文本里的 HTML 页面绝对路径：去重，保持出现顺序。 */
export function extractPagePaths(text: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const match of text.matchAll(PAGE_TOKEN_RE)) {
    const path = normalizeTarget(match[1] ?? match[2] ?? match[0] ?? "");
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 剥链后的空白收敛：行尾空白清掉、3+ 连续换行折叠成一个空行、去掉文尾空白。 */
function collapseBlank(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}

/**
 * 把指向这些路径的 markdown 链接整体移除（尖括号与 file:// 两种形态都算），再收敛空白。
 * 只剥链接：正文里提到的裸路径不是链接，飞书里点不动但也读得懂，不动它。
 */
export function stripPageLinks(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return collapseBlank(text);
  const targets = new Set<string>();
  for (const path of paths) {
    targets.add(path);
    targets.add(`file://${path}`);
  }
  const alternatives = [...targets].map(escapeRegExp).join("|");
  const linkRe = new RegExp(`\\[[^\\]]*\\]\\(\\s*(?:<(?:${alternatives})>|(?:${alternatives}))[^)]*\\)`, "g");
  return collapseBlank(text.replace(linkRe, ""));
}

/** 一页候选的校验结果；ok 为 false 时 reason 说明为什么跳过。 */
export interface PageCheck {
  path: string;
  ok: boolean;
  reason?: string;
}

/**
 * 一页能不能转发：存在、是文件、扩展名为 .html、不超过飞书文件消息量级上限。
 * 只做判断，不删任何东西。
 */
export async function checkPage(path: string): Promise<PageCheck> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return { path, ok: false, reason: "文件不存在" };
  }
  if (!info.isFile()) return { path, ok: false, reason: "不是普通文件" };
  if (!path.toLowerCase().endsWith(".html")) return { path, ok: false, reason: "扩展名不是 .html" };
  if (info.size > HTML_PAGE_MAX_BYTES) {
    return { path, ok: false, reason: `超过 ${HTML_PAGE_MAX_BYTES} 字节上限` };
  }
  return { path, ok: true };
}

// ---- 富内容识别 ----

/** 文本里有没有 amwh 不渲染、只有转成组件才看得好的围栏（a2ui / mermaid，可带 info string）。 */
const RICH_FENCE_RE = /^[ \t]*`{3,}(?:a2ui|mermaid)(?:[ \t]+[^\n]*)?$/im;

export function hasRichBlocks(text: string): boolean {
  return RICH_FENCE_RE.test(text);
}

// ---- 草稿生成 ----

interface ProseBlock {
  kind: "prose";
  text: string;
}

interface FenceBlock {
  kind: "fence";
  /** 围栏 info string 的首个词（`a2ui` / `mermaid` / `bash` …）。 */
  lang: string;
  /** 围栏体（不含首尾围栏行）。 */
  body: string;
  /** 原始文本（含围栏行），原样保留时用。 */
  raw: string;
}

type Block = ProseBlock | FenceBlock;

/** 按围栏切分文本：围栏内外分开，围栏内不再找围栏。 */
function splitBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];
  let open: { fence: string; lang: string; body: string[]; raw: string[] } | null = null;

  const flushProse = (): void => {
    if (prose.length === 0) return;
    blocks.push({ kind: "prose", text: prose.join("\n") });
    prose = [];
  };

  for (const line of lines) {
    if (open === null) {
      const opener = /^[ \t]*(`{3,})(.*)$/.exec(line);
      if (opener !== null) {
        flushProse();
        open = { fence: opener[1] ?? "```", lang: (opener[2] ?? "").trim().split(/\s+/)[0] ?? "", body: [], raw: [line] };
      } else {
        prose.push(line);
      }
      continue;
    }
    open.raw.push(line);
    const closer = /^[ \t]*(`+)[ \t]*$/.exec(line);
    if (closer !== null && (closer[1] ?? "").length >= open.fence.length) {
      blocks.push({ kind: "fence", lang: open.lang, body: open.body.join("\n"), raw: open.raw.join("\n") });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  flushProse();
  // 没闭合的围栏也当围栏交出去：调用方按「原样保留」处理，amwh 自己也只认闭合围栏。
  if (open !== null) {
    blocks.push({ kind: "fence", lang: open.lang, body: open.body.join("\n"), raw: open.raw.join("\n") });
  }
  return blocks;
}

/** amwh 的面板标题：`## ` 开头的小标题（面板）。 */
const PANEL_HEADING_RE = /^[ \t]*##[ \t]+\S/m;

/** 草稿标题：正文首个非空行，去掉 markdown 记号后截断；没有正文就给个通用标题。 */
function draftTitle(text: string): string {
  // 只看正文分区：围栏里的第一行是 JSON / 图表头，拿它当标题只会得到一堆乱码。
  for (const block of splitBlocks(text)) {
    if (block.kind !== "prose") continue;
    for (const raw of block.text.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("```")) continue;
      const plain = line
        .replace(/^#{1,6}[ \t]+/, "")
        .replace(/^>[ \t]*/, "")
        .replace(/^[-*+][ \t]+/, "")
        .replace(/^\d+[.)][ \t]+/, "")
        .replace(/[*_`~]/g, "")
        .trim();
      const title = plain === "" ? line : plain;
      return title.length <= TITLE_LIMIT ? title : `${title.slice(0, TITLE_LIMIT)}…`;
    }
  }
  return "回复页面";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : str(value);
}

/** 表格单元格里不能出现竖线，否则会把表格撑破。 */
function cell(text: string): string {
  return text.replace(/\|/g, "／").replace(/\n/g, " ");
}

/** 代码围栏：内容自带 ``` 时把围栏加长，否则代码块会被提前合上（与 render.ts 的 fenceFor 同一理由）。 */
function fenced(code: string, lang: string): string {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${code}\n${ticks}`;
}

/**
 * 回复 Markdown → amwh 草稿：加 frontmatter，普通内容原样透传，
 * a2ui / mermaid 围栏按下面的映射换成 amwh 组件；转不了一律原样保留围栏。
 */
export function toDraft(text: string): string {
  const head = ["---", "template: doc", "theme: auto", `title: ${draftTitle(text)}`, "---", ""].join("\n");
  const body = convertBlocks(text);
  return body === "" ? head : `${head}${body}`;
}

function convertBlocks(text: string): string {
  const out: string[] = [];
  // amwh 的 ask 是「面板专属」组件：不在 ## 标题之下整页渲染直接失败（实测）。
  // 回复里的 a2ui choice 常常是收尾块、前面没有任何小标题，所以这里要记住「进过面板没有」。
  let inPanel = false;
  for (const block of splitBlocks(text)) {
    if (block.kind === "prose") {
      // 两个围栏之间那段只有空行的「正文」没有内容，拼进去只会多出几个空行
      if (block.text.trim() !== "") out.push(block.text);
      if (PANEL_HEADING_RE.test(block.text)) inPanel = true;
      continue;
    }
    const converted =
      block.lang === "a2ui" ? convertA2ui(block.body) : block.lang === "mermaid" ? convertMermaid(block.body) : null;
    if (converted === null) {
      out.push(block.raw);
      continue;
    }
    // 不在面板里的 ask 补一个面板标题：否则整页渲染失败，用户什么都看不到。
    if (block.lang === "a2ui" && converted.startsWith("```ask") && !inPanel) {
      out.push(`## 请选择\n\n${converted}`);
      inPanel = true;
      continue;
    }
    out.push(converted);
  }
  // 块与块之间统一空一行：原文本里围栏前可能没有空行，直接拼在一起不是合法 markdown。
  return out.map((chunk) => chunk.replace(/\s+$/, "")).join("\n\n");
}

/** a2ui JSON → amwh 片段；解析失败、类型不认识或字段不够用都返回 null（原样保留围栏）。 */
function convertA2ui(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const block = asRecord(parsed);
  if (block === null) return null;
  switch (str(block.type)) {
    case "choice":
      return choiceToAsk(block);
    case "form":
      return formToTable(block);
    case "steps":
      return stepsToBlocks(block);
    case "callout":
      return calloutToCallout(block);
    case "metrics":
      return metricsToTable(block);
    case "weather":
      return weatherToKv(block);
    case "clock":
      return clockToKv(block);
    case "countdown":
      return countdownToKv(block);
    default:
      return null;
  }
}

/** choice → ask：第一行是问题，每个选项一行，recommended 用 `* ` 前缀。 */
function choiceToAsk(block: Record<string, unknown>): string | null {
  const question = str(block.question).replace(/\s+/g, " ").trim();
  const options = Array.isArray(block.options) ? block.options : [];
  const lines: string[] = [];
  for (const raw of options) {
    const option = asRecord(raw);
    if (option === null) continue;
    const label = str(option.label).replace(/\|/g, "／").trim();
    if (label === "") continue;
    const description = str(option.description).replace(/\|/g, "／").trim();
    lines.push(description === "" ? `${option.recommended === true ? "*" : "-"} ${label}` : `${option.recommended === true ? "*" : "-"} ${label} | ${description}`);
  }
  if (question === "" || lines.length === 0) return null;
  return ["```ask", question, ...lines, "```"].join("\n");
}

/** form → GFM 表格：一行一个字段，类型、必填、选项/说明各一列。 */
function formToTable(block: Record<string, unknown>): string | null {
  const fields = Array.isArray(block.fields) ? block.fields : [];
  const rows: string[] = [];
  for (const raw of fields) {
    const field = asRecord(raw);
    if (field === null) continue;
    const label = str(field.label) || str(field.id);
    if (label === "") continue;
    const options = Array.isArray(field.options) ? field.options : [];
    const labels = options
      .map((option) => str(asRecord(option)?.label))
      .filter((text) => text !== "");
    const detail = labels.length > 0 ? labels.join("、") : str(field.placeholder);
    rows.push(`| ${cell(label)} | ${cell(str(field.kind))} | ${field.required === true ? "是" : ""} | ${cell(detail)} |`);
  }
  if (rows.length === 0) return null;
  return ["| 字段 | 类型 | 必填 | 选项/说明 |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/** steps → 编号步骤：warning/caution 在步骤前，note 在步骤后，code 进代码围栏。 */
function stepsToBlocks(block: Record<string, unknown>): string | null {
  const steps = Array.isArray(block.steps) ? block.steps : [];
  const chunks: string[] = [];
  let index = 0;
  for (const raw of steps) {
    const step = asRecord(raw);
    if (step === null) continue;
    index += 1;
    const parts: string[] = [];
    const warning = str(step.warning) || str(step.caution);
    if (warning !== "") parts.push(`> ⚠️ ${warning}`);
    const text = str(step.text);
    parts.push(text === "" ? `**${index}.**` : `**${index}. ${text}**`);
    const note = str(step.note);
    if (note !== "") parts.push(`> ℹ️ ${note}`);
    const code = str(step.code);
    if (code !== "") parts.push(fenced(code, str(step.lang)));
    chunks.push(parts.join("\n\n"));
  }
  if (chunks.length === 0) return null;
  return chunks.join("\n\n");
}

/** a2ui 的 tone → amwh callout 的色调。 */
const CALLOUT_TONES: Record<string, string> = { note: "info", tip: "ok", caution: "warn", warning: "err" };

/** callout → callout：tone 映射，标题缺省时不写。 */
function calloutToCallout(block: Record<string, unknown>): string | null {
  const tone = CALLOUT_TONES[str(block.tone)] ?? "info";
  const title = str(block.title).replace(/\s+/g, " ").trim();
  const text = str(block.text);
  // 标题和正文都空：amwh 会直接报错，这种围栏给不出东西，原样留着更诚实。
  if (title === "" && text === "") return null;
  // tone 与标题都写在围栏首行（amwh 的语法是 ```callout <tone> [title]），正文在下行。
  const head = title === "" ? `\`\`\`callout ${tone}` : `\`\`\`callout ${tone} ${title}`;
  const lines = [head];
  if (text !== "") lines.push(text);
  lines.push("```");
  return lines.join("\n");
}

/** metrics → GFM 表格：数值拼上前缀与单位，detail 进说明列。 */
function metricsToTable(block: Record<string, unknown>): string | null {
  const items = Array.isArray(block.items) ? block.items : [];
  const rows: string[] = [];
  for (const raw of items) {
    const item = asRecord(raw);
    if (item === null) continue;
    const label = str(item.label);
    if (label === "") continue;
    const value = `${str(item.prefix)}${numberText(item.value)}${str(item.unit)}`;
    rows.push(`| ${cell(label)} | ${cell(value)} | ${cell(str(item.detail))} |`);
  }
  if (rows.length === 0) return null;
  return ["| 指标 | 数值 | 说明 |", "| --- | --- | --- |", ...rows].join("\n");
}

/** 温度单位的写法：a2ui 给 C/F，页面上写成度数符号更好读。 */
const TEMP_UNITS: Record<string, string> = { C: "℃", F: "℉" };

function tempText(value: unknown, unit: unknown): string {
  const text = numberText(value);
  if (text === "") return "";
  return `${text}${TEMP_UNITS[str(unit)] ?? str(unit)}`;
}

/** weather → kv：两列网格，只有取到值的字段才写。 */
function weatherToKv(block: Record<string, unknown>): string | null {
  const rows: Array<[string, string]> = [];
  const push = (label: string, value: unknown): void => {
    const text = numberText(value).trim();
    if (text !== "") rows.push([label, text]);
  };
  push("地点", block.place);
  push("天气", block.condition);
  push("温度", tempText(block.temp, block.unit));
  push("最高", block.high);
  push("最低", block.low);
  push("体感", block.feelsLike);
  push("湿度", block.humidity);
  const wind = [numberText(block.windSpeed), str(block.windUnit), str(block.windDirection)]
    .filter((part) => part !== "")
    .join(" ");
  if (wind !== "") rows.push(["风速", wind]);
  push("概况", block.summary);
  push("时间", block.asOf);
  push("来源", block.source);
  return kvBlock(rows);
}

/** clock → kv：每个时区一行「标签: 时区名」。 */
function clockToKv(block: Record<string, unknown>): string | null {
  const zones = Array.isArray(block.zones) ? block.zones : [];
  const rows: Array<[string, string]> = [];
  for (const raw of zones) {
    const zone = asRecord(raw);
    if (zone === null) continue;
    const name = str(zone.zone);
    if (name === "") continue;
    rows.push([str(zone.label) || name, name]);
  }
  return kvBlock(rows);
}

/** countdown → kv：标签、目标时刻、完成后的文案、是否显示目标。 */
function countdownToKv(block: Record<string, unknown>): string | null {
  const rows: Array<[string, string]> = [];
  const label = str(block.label);
  if (label !== "") rows.push(["事项", label]);
  const to = str(block.to);
  if (to !== "") rows.push(["目标时刻", to]);
  const doneLabel = str(block.doneLabel);
  if (doneLabel !== "") rows.push(["完成文案", doneLabel]);
  if (typeof block.showTarget === "boolean") rows.push(["显示目标", block.showTarget ? "是" : "否"]);
  return kvBlock(rows);
}

function kvBlock(rows: readonly (readonly [string, string])[]): string | null {
  if (rows.length === 0) return null;
  return ["```kv cols=2", ...rows.map(([key, value]) => `${key}: ${value}`), "```"].join("\n");
}

// ---- mermaid 保守转换 ----

/**
 * mermaid → amwh 组件。只转换能无损映射的简单形态，任何不满足一律返回 null
 * （保留 ```mermaid 源码围栏）——宁可留源码，不产出错图。
 */
function convertMermaid(body: string): string | null {
  const lines = body.split("\n");
  const header = (lines[0] ?? "").trim();
  const flowchart = /^(?:flowchart|graph)\b[ \t]*(TD|TB|LR|RL)?[ \t]*$/i.exec(header);
  if (flowchart !== null) return convertFlowchart(lines.slice(1), flowchart[1]);
  if (/^sequenceDiagram[ \t]*$/i.test(header)) return convertSequence(lines.slice(1));
  return null;
}

/** mermaid 方向 → amwh 方向；amwh 只认 TB|LR|BT|RL（`TD` 不在列，写 TB 是同一个方向）。 */
const FLOW_DIRECTIONS: Record<string, string> = { TD: "TB", TB: "TB", LR: "LR", RL: "RL" };

/** mermaid 节点源码：裸 ID，或 ID + `[]` / `()` / `{}` / `[()]` 之一。 */
const NODE_SRC = String.raw`[A-Za-z0-9_]+(?:\[\([^)\]\/]*\)\]|\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?`;

/** mermaid 边：认得出的就这五种，其余（子图、classDef、style…）一律整图放弃。 */
const EDGE_LINE_RE = new RegExp(
  `^(${NODE_SRC})[ \\t]*(-->|-\.->|---|--[ \\t]*[^\\s|]+[ \\t]*-->|-->[ \\t]*\\|[^|]*\\|)[ \\t]*(${NODE_SRC})$`,
);

const NODE_PARTS_RE = /^([A-Za-z0-9_]+)(?:\[\(([^)\]\/]*)\)\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})?$/;

/** 节点源码 → amwh 节点名（amwh 按节点名认节点，所以名字必须唯一）。 */
function nodeName(src: string): { id: string; label: string; name: string } | null {
  const parts = NODE_PARTS_RE.exec(src);
  if (parts === null) return null;
  const id = parts[1] ?? "";
  const round = parts[2];
  const rect = parts[3];
  const paren = parts[4];
  const diamond = parts[5];
  if (round !== undefined) return { id, label: round, name: `[(${round})]` };
  if (rect !== undefined) return { id, label: rect, name: rect };
  if (paren !== undefined) return { id, label: paren, name: `(${paren})` };
  // 菱形：amwh 的问号菱形写成 `{词?}`；标签自带问号时不重复加，否则补一个。
  if (diamond !== undefined) {
    return { id, label: diamond, name: diamond.includes("?") ? `{${diamond}}` : `{${diamond}?}` };
  }
  return { id, label: "", name: id };
}

/**
 * 标签安不安全：空白与 `|` 会把 amwh 的节点名/边标签解析带跑；
 * 括号则可能被 amwh 的 mermaid-ID 检查当成「像节点 ID 写法」而直接报错。
 */
function labelIsSafe(label: string): boolean {
  return !/[\s|(){}[\]]/.test(label);
}

function convertFlowchart(lines: readonly string[], direction: string | undefined): string | null {
  const edges: string[] = [];
  /** 节点 ID → 首次声明（名字 + 标签）；同一个 ID 再次出现必须是同一个节点。 */
  const byId = new Map<string, { name: string; label: string }>();
  /** 已占用的节点名：两个不同 ID 用同一个名字，amwh 会把它们画成一个节点。 */
  const names = new Set<string>();

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) continue;
    const match = EDGE_LINE_RE.exec(line);
    if (match === null) return null;
    const from = nodeName(match[1] ?? "");
    const to = nodeName(match[3] ?? "");
    const separator = match[2] ?? "";
    if (from === null || to === null) return null;
    if (!labelIsSafe(from.label) || !labelIsSafe(to.label)) return null;

    const label = edgeLabel(separator);
    if (label !== null && !labelIsSafe(label)) return null;

    for (const node of [from, to]) {
      const known = byId.get(node.id);
      if (known !== undefined) {
        // 同一个 ID 再次出现：不带标签就是引用已声明的节点（mermaid 的常见写法 `B{条件}` 之后
        // 又写 `B --> C`），沿用首次声明的名字；带了不同标签则是重复声明，mermaid 自己都会
        // 报错，整图放弃更稳妥。
        if (node.label !== "" && node.label !== known.label) return null;
        continue;
      }
      if (names.has(node.name)) return null;
      names.add(node.name);
      byId.set(node.id, { name: node.name, label: node.label });
    }
    // 实线（`-->` 起头）→ `->`，虚线 / 点线（`---`、`-.->`、`-- 标签 -->`）→ `-->`。
    const arrow = separator.startsWith("-->") ? "->" : "-->";
    const fromName = byId.get(from.id)?.name ?? from.name;
    const toName = byId.get(to.id)?.name ?? to.name;
    edges.push(label === null || label === "" ? `${fromName} ${arrow} ${toName}` : `${fromName} ${arrow} ${toName}: ${label}`);
  }
  if (edges.length === 0) return null;
  const flowDirection = FLOW_DIRECTIONS[(direction ?? "TD").toUpperCase()] ?? "TB";
  return [`\`\`\`flow ${flowDirection}`, ...edges, "```"].join("\n");
}

/** 边分隔符 → 边标签；没有标签返回 null。 */
function edgeLabel(separator: string): string | null {
  const piped = /^-->[ \t]*\|([^|]*)\|$/.exec(separator);
  if (piped !== null) return piped[1] ?? "";
  const worded = /^--[ \t]*(.+?)[ \t]*-->$/.exec(separator);
  if (worded !== null) return worded[1] ?? "";
  return null;
}

/** sequenceDiagram → sequence：只认简单消息行，其余（participant/note/loop/alt…）整图放弃。 */
function convertSequence(lines: readonly string[]): string | null {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) continue;
    // 参与者名不限于 ASCII：mermaid 的 participant 可以是任意不含空白与冒号的串。
    const match = /^(\S+?)[ \t]*(->>|-->>)[ \t]*(\S+?)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (match === null) return null;
    const arrow = match[2] === "->>" ? "->" : "-->";
    out.push(`${match[1]} ${arrow} ${match[3]}: ${match[4] ?? ""}`);
  }
  if (out.length === 0) return null;
  return ["```sequence", ...out, "```"].join("\n");
}

// ---- 渲染 ----

/** 渲染器子进程：与 proc.runCommand 同形（env 供 AM_HOME / AM_NO_UPDATE_CHECK 用）。 */
export type RenderRun = (
  bin: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number; env?: Record<string, string | undefined> },
) => Promise<{ status: number | null; stdout: string; stderr: string }>;

export interface RenderPageOptions {
  /** answer-me-with-html 渲染器脚本（am.mjs）的路径。 */
  script: string;
  /** node 可执行文件；默认当前进程的 node。 */
  nodeBin?: string;
  /** 注入用：渲染器子进程的执行方式。 */
  run?: RenderRun;
  /** 注入用：产物路径的生成方式。 */
  tempPath?: () => Promise<string>;
  /** 渲染超时（毫秒）。 */
  timeoutMs?: number;
}

/** 默认产物路径：一次性临时目录下的 page.html。 */
async function defaultTempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "penguin-remote-page-"));
  return join(dir, "page.html");
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * 草稿 → 单文件 HTML 的路径。渲染成功（exit 0 且产物存在且非空）才返回；
 * 失败抛错并带上 stderr 摘录。渲染用的 AM_HOME 是临时目录，用完就删——
 * amwh 会把更新检查的状态写进自己的 home，不该污染用户的技能目录。
 */
export async function renderPage(draft: string, options: RenderPageOptions): Promise<string> {
  const run = options.run ?? runCommand;
  const tempPath = options.tempPath ?? defaultTempPath;
  const outPath = await tempPath();
  // 默认 tempPath 会建一个一次性目录；渲染没成功时这个目录也得收掉，
  // 否则每次失败都在 /tmp 留一个空目录。注入的 tempPath 可能是调用方自己的地盘，不动。
  const ownsTempDir = options.tempPath === undefined && dirname(dirname(outPath)) === tmpdir();
  const home = await mkdtemp(join(tmpdir(), "penguin-remote-amwh-"));
  let produced = false;
  try {
    const result = await run(options.nodeBin ?? process.execPath, [
      options.script,
      "render",
      "-",
      "-o",
      outPath,
      "--no-open",
    ], {
      input: draft,
      timeoutMs: options.timeoutMs ?? 30_000,
      env: { ...process.env, AM_NO_UPDATE_CHECK: "1", AM_HOME: home },
    });
    produced = result.status === 0 && (await isNonEmptyFile(outPath));
    if (!produced) {
      const reason = result.stderr.trim() || result.stdout.trim();
      throw new Error(`HTML 页渲染失败（exit=${result.status}）：${reason.slice(0, STDERR_EXCERPT)}`);
    }
    return outPath;
  } finally {
    await rm(home, { recursive: true, force: true });
    if (!produced && ownsTempDir) {
      try {
        await rm(dirname(outPath), { recursive: true, force: true });
      } catch {
        // 删不掉不影响结果：它本来就是要丢的临时目录
      }
    }
  }
}
