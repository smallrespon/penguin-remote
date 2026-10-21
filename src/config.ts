// 配置加载与校验（fail-fast）

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface BridgeConfig {
  /** AMSP 基址，如 http://localhost/api/amsp/v1（同机必须用 localhost，127.0.0.1 会 401）。 */
  amspBaseUrl: string;
  /** owner 级路由基址，由 amspBaseUrl 推导，如 http://localhost/api。 */
  ownerApiBaseUrl: string;
  penguinBin: string;
  larkBin: string;
  /** 运行时状态目录。 */
  stateDir: string;
  defaultProjectId: string;
  defaultAgentId: string;
  /** 允许对话的 chat_id / open_id；空数组 = 开放访问。 */
  allowlist: string[];
  logLevel: LogLevel;
  ownerTokenTtlSeconds: number;
  ownerTokenRefreshMarginSeconds: number;
  previewThrottleMs: number;
  previewThrottleChars: number;
  previewMaxChars: number;
  /** 默认 Agent 的 AMSP key 兜底（env 注入，不落盘）；缺省时由 Bridge 按需自铸。 */
  amspApiKey: string | null;
}

/** 配置缺失或非法：消息列出全部问题，启动即失败。 */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`配置无效（${problems.length} 项）：\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const AMSP_PATH_SUFFIX = "/api/amsp/v1";

function intField(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    problems.push(`${name} 必须是正整数（收到 "${raw}"）`);
    return fallback;
  }
  return value;
}

/** 从环境变量加载配置；任何必需项缺失或非法时抛出 ConfigError，列出全部问题。 */
export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const problems: string[] = [];

  const amspBaseUrlRaw = env.AMSP_BASE_URL?.trim() ?? "";
  if (amspBaseUrlRaw === "") {
    problems.push("缺少 AMSP_BASE_URL（PenguinHarness AMSP 基址，如 http://localhost/api/amsp/v1）");
  }
  let amspBaseUrl = "";
  let ownerApiBaseUrl = "";
  if (amspBaseUrlRaw !== "") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(amspBaseUrlRaw);
    } catch {
      problems.push(`AMSP_BASE_URL 不是合法 URL："${amspBaseUrlRaw}"`);
    }
    if (parsed !== null) {
      const path = parsed.pathname.replace(/\/+$/, "");
      if (path !== AMSP_PATH_SUFFIX) {
        problems.push(`AMSP_BASE_URL 路径须以 ${AMSP_PATH_SUFFIX} 结尾（收到 "${path}"）`);
      }
      amspBaseUrl = `${parsed.origin}${path}`;
      ownerApiBaseUrl = `${parsed.origin}/api`;
    }
  }

  const projectId = env.DEFAULT_PROJECT_ID?.trim() ?? "";
  if (projectId === "") {
    problems.push("缺少 DEFAULT_PROJECT_ID（默认 Project id）");
  } else if (!ID_PATTERN.test(projectId)) {
    problems.push(`DEFAULT_PROJECT_ID 含非法字符："${projectId}"`);
  }

  const agentId = env.DEFAULT_AGENT_ID?.trim() ?? "";
  if (agentId === "") {
    problems.push("缺少 DEFAULT_AGENT_ID（默认 Agent id）");
  } else if (!ID_PATTERN.test(agentId)) {
    problems.push(`DEFAULT_AGENT_ID 含非法字符："${agentId}"`);
  }

  const stateDir = env.STATE_DIR?.trim() || "state";

  const allowlist = (env.ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const logLevelRaw = env.LOG_LEVEL?.trim() || "info";
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    problems.push(`LOG_LEVEL 须为 ${LOG_LEVELS.join(" / ")}（收到 "${logLevelRaw}"）`);
  }

  const ttl = intField(env, "OWNER_TOKEN_TTL_SECONDS", 3600, problems);
  const margin = intField(env, "OWNER_TOKEN_REFRESH_MARGIN_SECONDS", 300, problems);
  if (ttl <= margin) {
    problems.push("OWNER_TOKEN_TTL_SECONDS 必须大于 OWNER_TOKEN_REFRESH_MARGIN_SECONDS");
  }

  const throttleMs = intField(env, "PREVIEW_THROTTLE_MS", 1500, problems);
  const throttleChars = intField(env, "PREVIEW_THROTTLE_CHARS", 300, problems);
  const maxChars = intField(env, "PREVIEW_MAX_CHARS", 3500, problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    amspBaseUrl,
    ownerApiBaseUrl,
    penguinBin: env.PENGUIN_BIN?.trim() || "penguin",
    larkBin: env.LARK_CLI_BIN?.trim() || "lark-cli",
    stateDir,
    defaultProjectId: projectId,
    defaultAgentId: agentId,
    allowlist,
    logLevel: logLevelRaw as LogLevel,
    ownerTokenTtlSeconds: ttl,
    ownerTokenRefreshMarginSeconds: margin,
    previewThrottleMs: throttleMs,
    previewThrottleChars: throttleChars,
    previewMaxChars: maxChars,
    amspApiKey: env.AMSP_API_KEY?.trim() || null,
  };
}
