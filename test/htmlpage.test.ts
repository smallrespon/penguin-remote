// htmlpage 测试（ADR-0012）：页面路径提取、死链剥离、富围栏识别、
// a2ui / mermaid → amwh 草稿的转换，以及渲染薄壳（注入假 run，不跑真渲染器）。

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  HTML_PAGE_MAX_BYTES,
  checkPage,
  extractPagePaths,
  hasRichBlocks,
  renderPage,
  stripPageLinks,
  toDraft,
} from "../src/htmlpage.js";

/** 把 a2ui 对象包成回复里的围栏。 */
function a2ui(block: unknown): string {
  return `\`\`\`a2ui\n${JSON.stringify(block)}\n\`\`\``;
}

/** 把 mermaid 源码包成回复里的围栏。 */
function mermaid(body: string): string {
  return `\`\`\`mermaid\n${body}\n\`\`\``;
}

// ---- extractPagePaths ----

test("extractPagePaths：三种形态都认——尖括号链接、file:// 链接、裸绝对路径", () => {
  const text = ["看这里 [页面](</tmp/a.html>)", "还有 [页面](file:///tmp/b.html)", "直接写 /tmp/c.html"].join("\n");
  assert.deepEqual(extractPagePaths(text), ["/tmp/a.html", "/tmp/b.html", "/tmp/c.html"]);
});

test("extractPagePaths：去重且保持出现顺序", () => {
  const text = "[一](/tmp/a.html) [二](/tmp/b.html) [三](</tmp/a.html>) /tmp/c.html /tmp/a.html";
  assert.deepEqual(extractPagePaths(text), ["/tmp/a.html", "/tmp/b.html", "/tmp/c.html"]);
});

test("extractPagePaths：不收相对路径、非 .html 与 .html 后缀不完整的路径", () => {
  const text = "[x](rel/page.html) [y](/tmp/a.htm) [z](/tmp/a.htmlx) ./b.html /tmp/c.md";
  assert.deepEqual(extractPagePaths(text), []);
});

// ---- stripPageLinks ----

test("stripPageLinks：移除指向这些路径的链接，无关链接与正文原样留下", () => {
  const text = [
    "结论如上。",
    "",
    "[打开页面](</tmp/a.html>)",
    "",
    "[同一个](file:///tmp/a.html)",
    "",
    "[无关](https://example.com/y.html)",
    "",
    "裸路径 /tmp/a.html 不是链接，不动它",
  ].join("\n");
  const out = stripPageLinks(text, ["/tmp/a.html"]);
  assert.ok(!out.includes("打开页面"), out);
  assert.ok(!out.includes("同一个"), out);
  assert.ok(out.includes("结论如上。"));
  assert.ok(out.includes("[无关](https://example.com/y.html)"));
  assert.ok(out.includes("裸路径 /tmp/a.html 不是链接，不动它"));
});

test("stripPageLinks：剥链后收敛空白——行尾空白、连续空行、文尾空白", () => {
  const text = "第一段   \n\n\n\n[页面](</tmp/a.html>)\n\n\n\n第二段  ";
  assert.equal(stripPageLinks(text, ["/tmp/a.html"]), "第一段\n\n第二段");
});

test("stripPageLinks：不含这些链接的文本只做空白收敛", () => {
  assert.equal(stripPageLinks("普通段落\n\n\n\n更多", ["/tmp/a.html"]), "普通段落\n\n更多");
  assert.equal(stripPageLinks("普通段落", []), "普通段落");
});

test("stripPageLinks：同构应用保持相等性（outcome 全文与各正文分区）", () => {
  // runner 对 outcome.text 与各正文分区分别剥链：两边原本相等，变换后必须仍然相等，
  // 否则 finalParts 的「流式累积 vs 权威全文」比较会被单侧修改破坏。
  const parts = ["第一段。\n\n[页面](</tmp/a.html>)", "第二段。"];
  const whole = parts.join("\n\n");
  const strippedWhole = stripPageLinks(whole, ["/tmp/a.html"]);
  const strippedParts = parts.map((part) => stripPageLinks(part, ["/tmp/a.html"]));
  assert.equal(strippedWhole, strippedParts.join("\n\n"));
});

// ---- hasRichBlocks ----

test("hasRichBlocks：认出 a2ui 与 mermaid 围栏（含 info string），普通围栏不算", () => {
  assert.equal(hasRichBlocks("前面\n\n```a2ui\n{}\n```"), true);
  assert.equal(hasRichBlocks("```a2ui json\n{}\n```"), true);
  assert.equal(hasRichBlocks("```mermaid\nflowchart TD\n```"), true);
  assert.equal(hasRichBlocks("```bash\nls\n```"), false);
  assert.equal(hasRichBlocks("正文里提到 ```a2ui 两个字"), false);
});

// ---- toDraft：a2ui ----

test("toDraft：frontmatter 固定，标题取正文首个非空行", () => {
  const draft = toDraft("# 架构说明\n\n一段正文。");
  assert.ok(draft.startsWith("---\ntemplate: doc\ntheme: auto\ntitle: 架构说明\n---\n"), draft);
  assert.ok(draft.includes("一段正文。"));
});

test("toDraft：标题去掉 markdown 记号并截断到 30 字，没有正文时退回「回复页面」", () => {
  assert.ok(toDraft(`## ${"很".repeat(50)}\n\n正文`).includes(`title: ${"很".repeat(30)}…`));
  assert.ok(toDraft("> **引用标题**\n\n正文").includes("title: 引用标题"));
  assert.ok(toDraft(a2ui({ type: "callout", tone: "note", text: "x" })).includes("title: 回复页面"));
});

test("toDraft：a2ui choice → ask 围栏，recommended 用星号，无描述只有标签", () => {
  const draft = toDraft(
    ["选一个方案", "", a2ui({
      type: "choice",
      question: "用哪个缓存？",
      options: [
        { label: "Redis", description: "重启不丢数据", recommended: true },
        { label: "Memcached", description: "更简单" },
        { label: "无缓存" },
      ],
    })].join("\n\n"),
  );
  assert.ok(draft.includes("```ask\n用哪个缓存？\n* Redis | 重启不丢数据\n- Memcached | 更简单\n- 无缓存\n```"), draft);
});

test("toDraft：ask 不在面板内时补一个 ## 标题（amwh 的 ask 是面板专属组件）", () => {
  const draft = toDraft(a2ui({ type: "choice", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }));
  assert.ok(draft.includes("## 请选择\n\n```ask"), draft);
  // 已经在面板里就不再补
  const inPanel = toDraft(["## 决策", "", a2ui({ type: "choice", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] })].join("\n\n"));
  assert.equal(inPanel.split("## ").length - 1, 1, inPanel);
});

test("toDraft：标签与描述里的竖线换成全角竖线，question 里的换行压成空格", () => {
  const draft = toDraft(
    a2ui({
      type: "choice",
      question: "第一行\n第二行",
      options: [{ label: "A|B", description: "甲|乙", recommended: true }],
    }),
  );
  assert.ok(draft.includes("第一行 第二行"), draft);
  assert.ok(draft.includes("* A／B | 甲／乙"), draft);
});

test("toDraft：a2ui form → GFM 表格", () => {
  const draft = toDraft(
    a2ui({
      type: "form",
      fields: [
        { id: "name", label: "项目名", kind: "text", required: true },
        { id: "env", label: "环境", kind: "single", options: [{ label: "dev" }, { label: "prod" }] },
        { id: "note", label: "备注", kind: "text", placeholder: "随便写" },
      ],
    }),
  );
  assert.ok(draft.includes("| 字段 | 类型 | 必填 | 选项/说明 |"));
  assert.ok(draft.includes("| 项目名 | text | 是 |  |"), draft);
  assert.ok(draft.includes("| 环境 | single |  | dev、prod |"), draft);
  assert.ok(draft.includes("| 备注 | text |  | 随便写 |"), draft);
});

test("toDraft：a2ui steps → 编号步骤，warning 在步骤前、note 在步骤后、code 进围栏", () => {
  const draft = toDraft(
    a2ui({
      type: "steps",
      steps: [
        { text: "关阀门", warning: "先泄压", caution: "戴护具", code: "echo hi", lang: "bash", note: "确认无残余压力" },
        { text: "拆泵" },
      ],
    }),
  );
  assert.ok(draft.includes("**1. 关阀门**"), draft);
  assert.ok(draft.includes("> ⚠️ 先泄压"), draft);
  assert.ok(draft.includes("```bash\necho hi\n```"), draft);
  assert.ok(draft.includes("> ℹ️ 确认无残余压力"), draft);
  assert.ok(draft.includes("**2. 拆泵**"), draft);
  assert.ok(draft.indexOf("> ⚠️ 先泄压") < draft.indexOf("**1. 关阀门**"));
  assert.ok(draft.indexOf("**1. 关阀门**") < draft.indexOf("> ℹ️ 确认无残余压力"));
});

test("toDraft：a2ui callout 四种 tone 映射，缺标题时不写标题", () => {
  const withTitle = (tone: string): string =>
    toDraft(a2ui({ type: "callout", tone, title: "标题", text: "正文" }));
  assert.ok(withTitle("note").includes("```callout info 标题\n正文\n```"));
  assert.ok(withTitle("tip").includes("```callout ok 标题\n正文\n```"));
  assert.ok(withTitle("caution").includes("```callout warn 标题\n正文\n```"));
  assert.ok(withTitle("warning").includes("```callout err 标题\n正文\n```"));
  const noTitle = toDraft(a2ui({ type: "callout", tone: "note", text: "正文" }));
  assert.ok(noTitle.includes("```callout info\n正文\n```"), noTitle);
});

test("toDraft：a2ui metrics → GFM 表格，数值拼上前缀与单位", () => {
  const draft = toDraft(
    a2ui({
      type: "metrics",
      items: [
        { label: "CPU", value: 42, unit: "%", detail: "当前负载" },
        { label: "内存", value: 3.2, prefix: "约 ", unit: "GB" },
      ],
    }),
  );
  assert.ok(draft.includes("| 指标 | 数值 | 说明 |"));
  assert.ok(draft.includes("| CPU | 42% | 当前负载 |"), draft);
  assert.ok(draft.includes("| 内存 | 约 3.2GB |  |"), draft);
});

test("toDraft：a2ui weather → kv 两列，只写有值的字段", () => {
  const draft = toDraft(
    a2ui({
      type: "weather",
      place: "北京",
      condition: "晴",
      temp: 23,
      unit: "C",
      humidity: "40%",
      asOf: "2026-10-22T10:00+08:00",
    }),
  );
  assert.ok(draft.includes("```kv cols=2"), draft);
  assert.ok(draft.includes("地点: 北京"));
  assert.ok(draft.includes("天气: 晴"));
  assert.ok(draft.includes("温度: 23℃"));
  assert.ok(draft.includes("湿度: 40%"));
  assert.ok(draft.includes("时间: 2026-10-22T10:00+08:00"));
  assert.ok(!draft.includes("最高:"), draft);
});

test("toDraft：a2ui clock / countdown → kv", () => {
  const clock = toDraft(a2ui({ type: "clock", zones: [{ zone: "Asia/Shanghai", label: "北京" }, { zone: "UTC" }] }));
  assert.ok(clock.includes("北京: Asia/Shanghai"), clock);
  assert.ok(clock.includes("UTC: UTC"), clock);
  const countdown = toDraft(
    a2ui({ type: "countdown", label: "发版", to: "2026-11-01T10:00+08:00", doneLabel: "已发版", showTarget: true }),
  );
  assert.ok(countdown.includes("事项: 发版"), countdown);
  assert.ok(countdown.includes("目标时刻: 2026-11-01T10:00+08:00"));
  assert.ok(countdown.includes("完成文案: 已发版"));
  assert.ok(countdown.includes("显示目标: 是"));
});

test("toDraft：未知类型与坏 JSON 原样保留 a2ui 围栏", () => {
  const unknown = a2ui({ type: "gauge", value: 1 });
  assert.ok(toDraft(`说明\n\n${unknown}`).includes(unknown));
  const broken = "```a2ui json\n{ 坏 json }\n```";
  assert.ok(toDraft(`说明\n\n${broken}`).includes(broken));
});

test("toDraft：散文、表格与普通围栏原样透传", () => {
  const text = ["# 标题", "", "一段说明。", "", "| 列 | 值 |", "| --- | --- |", "| a | 1 |", "", "```bash", "ls -l", "```"].join("\n");
  const draft = toDraft(text);
  assert.ok(draft.includes("一段说明。"));
  assert.ok(draft.includes("| 列 | 值 |"));
  assert.ok(draft.includes("```bash\nls -l\n```"));
});

// ---- toDraft：mermaid ----

test("toDraft：简单 mermaid flowchart → flow 围栏（含形状、标签边、点线、虚线）", () => {
  const body = [
    "flowchart TD",
    "  A[开始] --> B{是否通过?}",
    "  B -->|是| C[(归档)]",
    "  B -- 否 --> D",
    "  C -.-> D",
    "  C --- D",
    "%% 注释",
  ].join("\n");
  const draft = toDraft(mermaid(body));
  assert.ok(
    draft.includes(
      [
        "```flow TB",
        "开始 -> {是否通过?}",
        "{是否通过?} -> [(归档)]: 是",
        "{是否通过?} --> D: 否",
        "[(归档)] --> D",
        "[(归档)] --> D",
        "```",
      ].join("\n"),
    ),
    draft,
  );
});

test("toDraft：mermaid 方向 LR / 无方向都能映射", () => {
  assert.ok(toDraft(mermaid("graph LR\n  A --> B")).includes("```flow LR\nA -> B\n```"));
  assert.ok(toDraft(mermaid("flowchart\n  A --> B")).includes("```flow TB\nA -> B\n```"));
});

test("toDraft：mermaid 标签含空白、子图、classDef、style 一律放弃转换，保留源码围栏", () => {
  const bodies = [
    "flowchart TD\n  A[开始 处理] --> B",
    "flowchart TD\n  subgraph one\n    A --> B\n  end",
    "flowchart TD\n  A --> B\n  classDef red fill:#f00",
    "flowchart TD\n  A[开始] --> B\n  style A fill:#f00",
    "flowchart TD\n  A[甲] --> B[甲]",
  ];
  for (const body of bodies) {
    assert.ok(toDraft(mermaid(body)).includes(mermaid(body)), body);
  }
});

test("toDraft：简单 mermaid sequenceDiagram → sequence 围栏", () => {
  const body = ["sequenceDiagram", "  客户端->>服务端: 请求", "  服务端-->>客户端: 响应", "%% 备注"].join("\n");
  const draft = toDraft(mermaid(body));
  assert.ok(draft.includes("```sequence\n客户端 -> 服务端: 请求\n服务端 --> 客户端: 响应\n```"), draft);
});

test("toDraft：sequenceDiagram 出现 participant / note / alt 时放弃转换", () => {
  const bodies = [
    "sequenceDiagram\n  participant 客户端\n  客户端->>服务端: 请求",
    "sequenceDiagram\n  note over 客户端: 备注\n  客户端->>服务端: 请求",
    "sequenceDiagram\n  alt 成功\n    客户端->>服务端: 请求\n  end",
  ];
  for (const body of bodies) {
    assert.ok(toDraft(mermaid(body)).includes(mermaid(body)), body);
  }
});

test("toDraft：其它 mermaid 类型（stateDiagram / classDiagram / gantt…）保留源码围栏", () => {
  for (const header of [
    "stateDiagram-v2",
    "classDiagram",
    "erDiagram",
    "gantt",
    "pie",
    "mindmap",
    "timeline",
    "gitGraph",
    "quadrantChart",
    "xychart-beta",
    "requirementDiagram",
    "C4Context",
  ]) {
    assert.ok(toDraft(mermaid(`${header}\n  A --> B`)).includes(mermaid(`${header}\n  A --> B`)), header);
  }
});

// ---- checkPage ----

test("checkPage：合规页面 ok，缺失 / 目录 / 非 html / 超上限都给出原因", async () => {
  const dir = await mkdtemp(join(tmpdir(), "htmlpage-test-"));
  try {
    const page = join(dir, "page.html");
    await writeFile(page, "<html></html>");
    assert.deepEqual(await checkPage(page), { path: page, ok: true });
    assert.deepEqual(await checkPage(join(dir, "missing.html")), {
      path: join(dir, "missing.html"),
      ok: false,
      reason: "文件不存在",
    });
    assert.deepEqual(await checkPage(dir), { path: dir, ok: false, reason: "不是普通文件" });
    const txt = join(dir, "a.txt");
    await writeFile(txt, "x");
    assert.equal((await checkPage(txt)).reason, "扩展名不是 .html");

    const huge = join(dir, "huge.html");
    await writeFile(huge, Buffer.alloc(HTML_PAGE_MAX_BYTES + 1));
    assert.match((await checkPage(huge)).reason ?? "", /超过/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- renderPage ----

type RenderCall = { args: string[]; input: string; env: Record<string, string | undefined> | undefined };

/** 记录型假渲染器：按 handler 决定退出码与输出。 */
function fakeRun(
  handler: (args: string[], opts: { input?: string; env?: Record<string, string | undefined> }) => RunResultLike | Error,
): { run: Parameters<typeof renderPage>[1]["run"]; calls: RenderCall[] } {
  const calls: RenderCall[] = [];
  const run = async (
    _bin: string,
    args: string[],
    opts: { input?: string; timeoutMs?: number; env?: Record<string, string | undefined> },
  ) => {
    calls.push({ args, input: opts.input ?? "", env: opts.env });
    const result = handler(args, opts);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run: run as Parameters<typeof renderPage>[1]["run"], calls };
}

interface RunResultLike {
  status: number;
  stdout: string;
  stderr: string;
}

test("renderPage：渲染成功返回产物路径，子进程参数、stdin 与环境齐备", async () => {
  const dir = await mkdtemp(join(tmpdir(), "htmlpage-test-"));
  const out = join(dir, "page.html");
  await writeFile(out, "<html></html>");
  const fake = fakeRun(() => ({ status: 0, stdout: "", stderr: "" }));
  try {
    assert.equal(await renderPage("草稿", { script: "/opt/am.mjs", run: fake.run, tempPath: async () => out }), out);
    assert.deepEqual(fake.calls[0]?.args, ["/opt/am.mjs", "render", "-", "-o", out, "--no-open"]);
    assert.equal(fake.calls[0]?.input, "草稿");
    assert.equal(fake.calls[0]?.env?.AM_NO_UPDATE_CHECK, "1");
    const home = fake.calls[0]?.env?.AM_HOME;
    assert.ok(typeof home === "string" && home !== "", "AM_HOME 必须指向一个临时目录");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderPage：渲染器非 0 退出时抛错并带上 stderr 摘录", async () => {
  const fake = fakeRun(() => ({ status: 1, stdout: "", stderr: "✗ L10 [ask] ask belongs in a panel" }));
  await assert.rejects(
    () => renderPage("草稿", { script: "/opt/am.mjs", run: fake.run, tempPath: async () => "/tmp/no-such-page.html" }),
    /HTML 页渲染失败（exit=1）：✗ L10 \[ask\] ask belongs in a panel/,
  );
});

test("renderPage：产物不存在时抛错", async () => {
  const fake = fakeRun(() => ({ status: 0, stdout: "", stderr: "" }));
  await assert.rejects(
    () => renderPage("草稿", { script: "/opt/am.mjs", run: fake.run, tempPath: async () => "/tmp/no-such-page.html" }),
    /HTML 页渲染失败/,
  );
});

test("renderPage：渲染失败时，默认临时目录也一并清理（不在 /tmp 留空目录）", async () => {
  const before = new Set(await readdir(tmpdir()).then((names) => names.filter((n) => n.startsWith("penguin-remote-page-"))));
  const fake = fakeRun(() => ({ status: 1, stdout: "", stderr: "boom" }));
  await assert.rejects(() => renderPage("草稿", { script: "/opt/am.mjs", run: fake.run }), /boom/);
  const after = await readdir(tmpdir());
  const leaked = after.filter((n) => n.startsWith("penguin-remote-page-") && !before.has(n));
  assert.deepEqual(leaked, [], "失败也不该留下临时目录");
});

test("renderPage：临时 AM_HOME 用完删除（成功与失败都删）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "htmlpage-test-"));
  const out = join(dir, "page.html");
  await writeFile(out, "<html></html>");
  const homes: string[] = [];
  const record = (opts: { env?: Record<string, string | undefined> }): void => {
    const home = opts.env?.AM_HOME;
    if (typeof home === "string") homes.push(home);
  };
  try {
    const ok = fakeRun((_args, opts) => {
      record(opts);
      return { status: 0, stdout: "", stderr: "" };
    });
    await renderPage("草稿", { script: "/opt/am.mjs", run: ok.run, tempPath: async () => out });
    assert.equal(homes.length, 1);
    assert.equal(existsSync(homes[0] ?? ""), false, "成功后临时 AM_HOME 应被删除");

    const bad = fakeRun((_args, opts) => {
      record(opts);
      return { status: 1, stdout: "", stderr: "boom" };
    });
    await assert.rejects(() => renderPage("草稿", { script: "/opt/am.mjs", run: bad.run, tempPath: async () => out }), /boom/);
    assert.equal(homes.length, 2);
    assert.equal(existsSync(homes[1] ?? ""), false, "失败后临时 AM_HOME 也应被删除");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
