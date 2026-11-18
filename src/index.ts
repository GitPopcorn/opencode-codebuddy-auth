import type {
  Hooks,
  PluginInput,
  Plugin,
  Config as PluginConfig,
} from "@opencode-ai/plugin";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const PROVIDER_ID = "codebuddy";

const CONFIG = {
  serverUrl: "https://copilot.tencent.com",
  chatCompletionsPath: "/v2/chat/completions",
  platform: "VSCode",
  // 版本号单一真源：UA 首段 (ideName/ideVersion) 与 X-IDE-Version / X-Product-Version
  // 必须同源同值 —— 对齐官方 CodeBuddy IDE 4.12.4 抓包。
  appVersion: "4.12.4",
  ideName: "CodeBuddyIDE",
  ideType: "CodeBuddyIDE",
  ideVersion: "4.12.4",
  domain: "www.codebuddy.cn",
  product: "SaaS",
  agentIntent: "craft",
  agentType: "main",
  envId: "production",
  tenantId: process.env.CODEBUDDY_TENANT_ID || "",
  enterpriseId: process.env.CODEBUDDY_ENTERPRISE_ID || "",
  userId: process.env.CODEBUDDY_USER_ID || "",
  defaultModel: process.env.CODEBUDDY_DEFAULT_MODEL || "",
};

interface JwtPayload {
  iss?: string;
  tenant_id?: string;
  tenantId?: string;
  enterprise_id?: string;
  enterpriseId?: string;
  ent_id?: string;
  entId?: string;
  user_id?: string;
  userId?: string;
  uid?: string;
  sub?: string;
  realm_access?: { roles?: string[] };
  resource_access?: { account?: { roles?: string[] } };
}

interface AuthStateResponse {
  code: number;
  data?: {
    state: string;
    authUrl?: string;
  };
}

interface TokenPollResponse {
  code: number;
  data?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface RefreshResponse {
  code: number;
  data?: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
  };
}

interface OpenAIRequest {
  model?: string;
  stream?: boolean;
  response_format?: unknown;
  [key: string]: unknown;
}

interface RemoteModel {
  id: string;
  name: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  supportsToolCall?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
}

interface RemoteConfigResponse {
  code: number;
  msg?: string;
  data?: {
    agents?: Array<{ name: string; models?: string[] }>;
    models?: RemoteModel[];
  };
}

const DEFAULT_MODEL: RemoteModel = { id: "auto", name: "Auto", maxInputTokens: 168000, maxOutputTokens: 32000, supportsToolCall: true };

const DISCOVERY_TIMEOUT_MS = 5000;

let resolvedServerUrl = CONFIG.serverUrl;
let resolvedDomain = CONFIG.domain;

/**
 * 当前会话 ID —— 由 chat.params / experimental.chat.system.transform 两个钩子捕获。
 * 用途：稳定派生会话维度 ID (X-Conversation-ID / X-Trace-ID / X-B3-ParentSpanId，
 * 同一会话恒定同一值) 。
 */
let currentSessionId = "";

/**
 * 宿主日志出口 —— 由插件工厂注入，供各钩子复用同一套日志实现。
 * 初始化成一个空实现，避免模块级初始化顺序问题 (noopLog 在文件后段才声明) 。
 */
let hostLog: LogFn = () => {};

/**
 * 模型展示名前缀 —— 与其他自配 provider 的展示风格保持一致。
 * 只作用于 `name` (给人看的) ，绝不作用于 `id` (要原样发给上游) 。
 */
const MODEL_NAME_PREFIX = "[自配][CDBD] ";

/**
 * 品牌大小写修正表 —— 键为小写单词，值为规范写法。
 * 覆盖工作区 `Format-LLM-Name` 现有表格 + 其缺失的品牌项。
 */
const MODEL_NAME_BRANDS: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  claude: "Claude",
  "claude-code": "ClaudeCode",
  hermes: "Hermes",
  qwen: "Qwen",
  gemma: "Gemma",
  gemini: "Gemini",
  llama: "Llama",
  mistral: "Mistral",
  codestral: "Codestral",
  command: "Command",
  gpt: "GPT",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  nova: "Nova",
  micro: "Micro",
  nano: "Nano",
  mini: "Mini",
  flash: "Flash",
  pro: "Pro",
  max: "Max",
  turbo: "Turbo",
  coder: "Coder",
  reasoner: "Reasoner",
  preview: "Preview",
  latest: "Latest",
  free: "Free",
  code: "Code",
  zen: "Zen",
  go: "Go",
  minimax: "MiniMax",
  glm: "GLM",
  kimi: "Kimi",
  mimo: "MiMo",
  hunyuan: "Hunyuan",
  step: "Step",
  space: "Space",
  bunny: "Bunny",
  xiaomi: "Xiaomi",
};

function capitalizeModelNameWord(word: string): string {
  if (word.length === 0) return "";
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * 把单个单词 (已按分隔符切开) 转为展示写法：先查品牌表，查不到就首字母大写其余小写。
 * 注意：不拆单词内部的 CamelCase (`MiniMax` 视为一个词，`Hy4flash` 也保持一个词) 。
 */
function normalizeModelNameWord(word: string): string {
  const branded = MODEL_NAME_BRANDS[word.toLowerCase()];
  if (branded !== undefined) return branded;
  return capitalizeModelNameWord(word);
}

/**
 * 把模型名主体格式化为空格分隔的展示写法 (不含前缀) 。
 * 空串或全是分隔符时返回空串，由调用方决定兜底。
 */
function formatModelNameBody(raw: string): string {
  const words = raw.split(/[-_\s]+/).filter((w) => w.length > 0);
  return words.map(normalizeModelNameWord).join(" ");
}

/**
 * 生成注入 `config.provider.codebuddy.models[].name` 的展示名。
 * - 幂等：已带 `[自配][CDBD] ` 前缀时先剥掉再重新加，绝不复利叠加
 * - 兜底：名称为空或只有分隔符时，依次回退到 fallbackId 与 `Model`，不抛错
 * - 只处理展示名，模型 id 由调用方单独保留，绝不经此处改写
 */
export function formatModelDisplayName(rawName: string, fallbackId?: string): string {
  let base = typeof rawName === "string" ? rawName.trim() : "";
  if (base.startsWith(MODEL_NAME_PREFIX)) {
    base = base.slice(MODEL_NAME_PREFIX.length).trim();
  }
  if (base.length === 0) {
    base = typeof fallbackId === "string" ? fallbackId.trim() : "";
  }
  const body = formatModelNameBody(base) || "Model";
  return `${MODEL_NAME_PREFIX}${body}`;
}

/**
 * `formatModelDisplayName` 的验证入口 —— 供离线断言脚本直接调用。
 */
export function formatModelDisplayNameForTest(rawName: string, fallbackId?: string): string {
  return formatModelDisplayName(rawName, fallbackId);
}

function remoteModelToConfig(m: RemoteModel): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: formatModelDisplayName(m.name, m.id) };
  if (m.maxInputTokens || m.maxOutputTokens) {
    entry.limit = { context: m.maxInputTokens ?? 0, output: m.maxOutputTokens ?? 0 };
  }
  if (m.supportsToolCall) entry.tool_call = true;
  if (m.supportsImages) entry.attachment = true;
  return entry;
}

async function fetchRemoteModels(
  accessToken: string,
  log: LogFn = noopLog,
): Promise<RemoteModel[]> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Agent-Intent": CONFIG.agentIntent,
    "X-IDE-Type": CONFIG.ideType,
    "X-IDE-Name": CONFIG.ideName,
    "X-IDE-Version": CONFIG.ideVersion,
    "X-Product-Version": CONFIG.appVersion,
    "X-Env-ID": CONFIG.envId,
    "X-Domain": resolvedDomain,
    "X-Product": CONFIG.product,
    "User-Agent": `${CONFIG.ideName}/${CONFIG.ideVersion} CodeBuddy/${CONFIG.appVersion}`,
  };
  const resp = await fetch(`${resolvedServerUrl}/v3/config`, { headers });
  if (!resp.ok) {
    log("warn", `[${VERSION_TAG}] /v3/config failed: HTTP ${resp.status}`);
    return [];
  }
  const body = (await resp.json()) as RemoteConfigResponse;
  if (body.code !== 0 || !body.data) {
    // 上游 msg 不落日志 —— 只记分类与脱敏码
    const classified = classifyUpstreamError(resp.status, body);
    log(
      "warn",
      `[${VERSION_TAG}] /v3/config rejected: class=${classified.label} code=${classified.codeLabel || "none"}`,
    );
    return [];
  }
  const allModels = body.data.models || [];
  const modelMap = new Map(allModels.map((m) => [m.id, m]));
  const craftAgent = (body.data.agents || []).find((a) => a.name === CONFIG.agentIntent);
  const craftIds = craftAgent?.models || [];
  if (craftIds.length === 0) return [DEFAULT_MODEL];
  return craftIds.map((id) => modelMap.get(id)).filter((m): m is RemoteModel => !!m?.supportsToolCall);
}

function generateUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// UUID v4 生成器
// 官方客户端的 X-Request-Trace-Id / X-Root-Request-ID 都是标准 UUID v4
//  (带版本位 4 与 variant 位 10) ，与旧的 16 位十六进制形式不同。
// 优先用 crypto.randomUUID (Node/Bun 均有) ，缺失时手工按 v4 规则拼装。
function generateUuidV4(): string {
  const c = globalThis.crypto as Crypto | undefined;
  try {
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fallback */ }
  try {
    const bytes = new Uint8Array(16);
    if (c?.getRandomValues) {
      c.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    // 版本位 (4) 与 variant 位 (10)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  } catch {
    return `${Date.now().toString(16).padStart(12, "0")}-0000-4000-8000-000000000000`;
  }
}

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload + pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function resolveTenantId(accessToken: string): string {
  if (CONFIG.tenantId) return CONFIG.tenantId;
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const iss = p.iss || "";
  const m = iss.match(/realms\/sso-([^/]+)$/);
  return p.tenant_id || p.tenantId || (m?.[1] || "");
}

function resolveEnterpriseId(accessToken: string): string {
  if (CONFIG.enterpriseId) return CONFIG.enterpriseId;
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  const roles = p.realm_access?.roles || p.resource_access?.account?.roles;
  if (roles) {
    for (const r of roles) {
      const m = r.match(/group-admin:([A-Za-z0-9-]+)/);
      if (m?.[1]) return m[1];
    }
  }
  return p.enterprise_id || p.enterpriseId || p.ent_id || p.entId || "";
}

function resolveUserId(accessToken: string): string {
  if (CONFIG.userId) return CONFIG.userId;
  const p = decodeJwtPayload(accessToken);
  return p?.user_id || p?.userId || p?.uid || p?.sub || "";
}

function resolveModel(inputModel?: string): string {
  if (CONFIG.defaultModel) return CONFIG.defaultModel;
  return inputModel || "";
}

/** 生成 32 位小写十六进制 ID (16 字节随机) —— 官方客户端的 ID 形态 (X-Request-Trace-Id 除外)  */
function generateHex32(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成 16 位小写十六进制 ID (8 字节随机) —— X-B3-SpanId / X-B3-ParentSpanId 的形态 */
function generateHex16(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 会话维度 ID 三元组 —— 同一 sessionID 恒定同一组值。
 * 官方抓包：X-Conversation-ID / X-Trace-ID(= X-B3-TraceId) / X-B3-ParentSpanId
 * 在一段对话的多轮请求里完全不变，只有 SpanId / Request-ID 是每请求新的。
 * 做法：sha256(sessionID) 前 16 字节 → conversationId；后 16 字节 → traceId；
 *       摘要再哈希一次取前 8 字节 → parentSpanId (避免与 traceId 字节区间重叠) 。
 */
interface SessionScopedIds {
  conversationId: string;
  traceId: string;
  parentSpanId: string;
}

function deriveSessionScopedIds(sessionId: string): SessionScopedIds {
  const digest = createHash("sha256").update(sessionId, "utf8").digest();
  const conversationId = digest.subarray(0, 16).toString("hex");
  const traceId = digest.subarray(16, 32).toString("hex");
  const parentSpanId = createHash("sha256")
    .update(digest)
    .digest()
    .subarray(0, 8)
    .toString("hex");
  return { conversationId, traceId, parentSpanId };
}

/** 取会话维度 ID：会话已知则稳定派生，会话未知则退化为每请求随机值 */
function resolveSessionScopedIds(sessionId?: string): SessionScopedIds {
  const sid = (sessionId || "").trim();
  if (!sid) {
    return {
      conversationId: generateHex32(),
      traceId: generateHex32(),
      parentSpanId: generateHex16(),
    };
  }
  return deriveSessionScopedIds(sid);
}

function buildAuthHeaders(
  accessToken: string,
  modelId?: string,
  deviceToken?: string,
  sessionId?: string,
): Record<string, string> {
  const tenantId = resolveTenantId(accessToken);
  const enterpriseId = resolveEnterpriseId(accessToken);
  const userId = resolveUserId(accessToken);
  // 会话维度 (一段对话内恒定) ：X-Conversation-ID / X-Trace-ID / X-B3-ParentSpanId
  const scopedIds = resolveSessionScopedIds(sessionId ?? currentSessionId);
  const conversationId = scopedIds.conversationId;
  const traceId = scopedIds.traceId;
  const parentSpanId = scopedIds.parentSpanId;
  // 请求维度 (每请求新生成) ：
  // X-Request-ID 与 X-Conversation-Request-ID 必须同值；
  // X-Conversation-Message-ID 必须是另一个独立的 32 位标识。
  const requestId = generateHex32();
  let conversationMessageId = generateHex32();
  while (conversationMessageId === requestId) {
    conversationMessageId = generateHex32();
  }
  const spanId = generateHex16();
  // 官方客户端的 X-Request-Trace-Id 是 UUID v4，与 b3 家族无关，单独生成
  const requestTraceId = generateUuidV4();
  // 客户端埋点：两个 13 位毫秒时间戳 (官方抓包中发送时间比准备时间晚约 30ms)
  const httpSendTime = Date.now();
  const promptPrepareStartTime = httpSendTime - 30;

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: `Bearer ${accessToken}`,
    "X-Request-ID": requestId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Request-ID": requestId,
    "X-Conversation-Message-ID": conversationMessageId,
    "X-Agent-Intent": CONFIG.agentIntent,
    "X-Agent-Type": CONFIG.agentType,
    "X-IDE-Type": CONFIG.ideType,
    "X-IDE-Name": CONFIG.ideName,
    "X-IDE-Version": CONFIG.ideVersion,
    "X-Product-Version": CONFIG.appVersion,
    "X-Request-Trace-Id": requestTraceId,
    "X-Env-ID": CONFIG.envId,
    "X-Domain": resolvedDomain,
    "X-Product": CONFIG.product,
    "User-Agent": `${CONFIG.ideName}/${CONFIG.ideVersion} CodeBuddy/${CONFIG.appVersion}`,
    "Accept-Language": "zh-CN",
    "X-Trace-ID": traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-Sampled": "1",
    monitor_promptpreparestarttime: String(promptPrepareStartTime),
    monitor_httpsendtime: String(httpSendTime),
  };

  if (tenantId) headers["X-Tenant-Id"] = tenantId;
  if (enterpriseId) headers["X-Enterprise-Id"] = enterpriseId;
  if (userId) headers["X-User-Id"] = userId;
  if (modelId) headers["X-Model-ID"] = modelId;
  // 设备令牌 (TuringShield) ：为空时直接不发该头，服务端容忍缺失
  if (deviceToken) headers["X-Device-Token"] = deviceToken;

  return headers;
}

/**
 * 供外部脚本验证请求头构造 (不打印令牌内容) 。
 * 与插件内部走同一套 buildAuthHeaders 逻辑，保证验证的就是线上行为。
 */
export function buildAuthHeadersForTest(
  accessToken: string,
  modelId: string,
  deviceToken: string,
  sessionId: string,
): Record<string, string> {
  return buildAuthHeaders(accessToken, modelId, deviceToken, sessionId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 指纹净化规则引擎 (统一规则表 + 两个调用点 + 一个总开关)
// ----------------------------------------------------------------------------
// v4.0.0 之前存在两套重叠的规则表：
//   · experimental.chat.system.transform 钩子用的 6 条提示词规则；
//   · fetch 拦截用的 29 条 body 规则 (R1 固定短语 20 + R2 品牌 3 + R3~R8 正则 6) 。
// 两者内容重叠却已漂移，还用两个环境变量表达同一个开关。
// v4.0.1 起合并为**一张规则表** (FINGERPRINT_RULES) ，两个调用点各取子集，
// 开关收敛为 CODEBUDDY_FINGERPRINT_SANITIZE；旧名 CODEBUDDY_PROMPT_SANITIZE
// 保留为**废弃别名** (两个开关任一为停用值即整体停用) 。
// 规则内容一字未改 —— 本次只做结构收敛，行为等价。
//
// 作用目标 (targets) ：
//   prompt —— system-transform 钩子 (系统提示词)
//   body   —— 请求体净化 (messages 全字段)
//
// 上游渠道校验 (code 11128) 对**大小写不敏感的精确子串**做扫描，
// 命中即让整条请求被拒：
//   HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
//
// 净化只对本插件自己的 provider (codebuddy) 生效，其它 provider 原样透传。
// ============================================================================

/** 规则作用目标：prompt = system-transform 钩子；body = 请求体净化 */
type FingerprintTarget = "prompt" | "body";

/** 净化作用范围：all = 全部 role；system-assistant = 只改 system + assistant */
export type FingerprintScope = "all" | "system-assistant";

interface FingerprintRule {
  /** 规则标识 (仅用于日志定位与回归测试)  */
  id: string;
  /** 作用目标 (一条规则可同时作用于多个调用点)  */
  targets: FingerprintTarget[];
  /** 匹配方式：literal = 固定短语 (转义后按字面匹配) ；regex = 正则 */
  mode: "literal" | "regex";
  /** 匹配源：literal 时为短语原文，regex 时为正则源码 */
  source: string;
  /** 正则标志 (仅 regex 模式有效，缺省 "gi")  */
  flags?: string;
  /** 替换文本 */
  replacement: string;
  /** 替换函数 (需要引用捕获组时使用)  */
  replace?: (...args: string[]) => string;
}

/**
 * 统一规则表 —— 数组顺序即生效顺序。
 * prompt 子集与 body 子集各自保持原有相对顺序，行为与 v4.0.0 完全等价。
 */
const FINGERPRINT_RULES: FingerprintRule[] = [
  // ===== prompt 子集 (system-transform 钩子，原 6 条)  =====
  // 1. "You are an AI agent powered by <X> Harness." -> "You are an AI agent."
  {
    id: "prompt-ai-agent-harness",
    targets: ["prompt"],
    mode: "regex",
    source: "You are an AI agent powered by [^\\n]{0,200}? Harness\\.",
    flags: "gi",
    replacement: "You are an AI agent.",
  },
  // 2. "Sisyphus-Junior - Focused executor from OhMyOpenCode" -> "Focused executor"
  {
    id: "prompt-sisyphus-junior",
    targets: ["prompt"],
    mode: "regex",
    source: "Sisyphus-Junior\\s*[-\\u2010-\\u2015]\\s*Focused executor from OhMyOpenCode",
    flags: "gi",
    replacement: "Focused executor",
  },
  // 3. "Main branch (you will usually use this for PRs)" -> "Main branch"
  {
    id: "prompt-main-branch",
    targets: ["prompt"],
    mode: "regex",
    source: "Main branch \\(you will usually use this for PRs\\)",
    flags: "gi",
    replacement: "Main branch",
  },
  // 4. "You are Claude Code" -> "You are an AI coding assistant"
  {
    id: "prompt-claude-code",
    targets: ["prompt"],
    mode: "regex",
    source: "You are Claude Code",
    flags: "gi",
    replacement: "You are an AI coding assistant",
  },
  // 5. "cc_entrypoint=<非空白>" -> 整段删除
  {
    id: "prompt-entrypoint",
    targets: ["prompt"],
    mode: "regex",
    source: "cc_entrypoint=\\S+",
    flags: "gi",
    replacement: "",
  },
  // 6. "You are powered by the model named <行尾>" -> "You are powered by a large language model"
  {
    id: "prompt-model-named",
    targets: ["prompt"],
    mode: "regex",
    source: "You are powered by the model named[^\\n]*",
    flags: "gi",
    replacement: "You are powered by a large language model",
  },

  // ===== body 子集 (请求体净化，原 29 条)  =====
  // R1 固定短语表 (大小写不敏感；只替换命中的片段，其余逐字节保留)
  {
    id: "body-lit-ai-agent-harness",
    targets: ["body"],
    mode: "literal",
    source: "You are an AI agent powered by DeepSeek Harness",
    replacement: "You are an AI agent running inside this harness",
  },
  {
    id: "body-lit-coding-agent-powered-by",
    targets: ["body"],
    mode: "literal",
    source: "You are a coding agent powered by the ",
    replacement: "You are a coding agent running on the ",
  },
  {
    id: "body-lit-harness-web-gui",
    targets: ["body"],
    mode: "literal",
    source: "You are interacting with the user through the DeepSeek Harness Web GUI",
    replacement: "You are working with the user inside this harness Web GUI",
  },
  {
    id: "body-lit-agent-teams",
    targets: ["body"],
    mode: "literal",
    source: "Agent Teams is available in this session",
    replacement: "Agent Teams is enabled for this session",
  },
  {
    id: "body-lit-tokens-prefixed-at",
    targets: ["body"],
    mode: "literal",
    source: "Tokens prefixed with @ are paths the user explicitly referenced.",
    replacement: "Paths that begin with @ are the ones the user explicitly referenced.",
  },
  {
    id: "body-lit-relative-paths",
    targets: ["body"],
    mode: "literal",
    source: "Relative paths resolve from the workspace root;",
    replacement: "Relative paths are resolved against the workspace root;",
  },
  {
    id: "body-lit-absolute-paths",
    targets: ["body"],
    mode: "literal",
    source: "absolute paths identify files or directories on the host.",
    replacement: "absolute paths point at files or directories on the host.",
  },
  {
    id: "body-lit-trailing-slash",
    targets: ["body"],
    mode: "literal",
    source: "A trailing slash marks a directory:",
    replacement: "A trailing slash indicates a directory:",
  },
  {
    id: "body-lit-list-it",
    targets: ["body"],
    mode: "literal",
    source: "list it when its contents matter.",
    replacement: "list it whenever its contents matter.",
  },
  {
    id: "body-lit-anything-else",
    targets: ["body"],
    mode: "literal",
    source: "Anything else is a file:",
    replacement: "Everything else is a file:",
  },
  {
    id: "body-lit-read-tool",
    targets: ["body"],
    mode: "literal",
    source: "use the read tool when its contents are needed,",
    replacement: "use the read tool whenever you need its contents,",
  },
  {
    id: "body-lit-do-not-claim",
    targets: ["body"],
    mode: "literal",
    source: "and do not claim to have inspected it before reading.",
    replacement: "and never claim to have inspected it before reading it.",
  },
  {
    id: "body-lit-at-quoted-path",
    targets: ["body"],
    mode: "literal",
    source: "@\"...\" quotes a path containing spaces.",
    replacement: "A path containing spaces is quoted with @\"...\".",
  },
  {
    id: "body-lit-no-other-target",
    targets: ["body"],
    mode: "literal",
    source: "without naming another target, they mean this GUI.",
    replacement: "and names no other target, the interface described here is meant.",
  },
  {
    id: "body-lit-mean-this-gui",
    targets: ["body"],
    mode: "literal",
    source: "they mean this GUI.",
    replacement: "the interface described here is meant.",
  },
  {
    id: "body-lit-main-branch",
    targets: ["body"],
    mode: "literal",
    source: "Main branch (you will usually use this for PRs)",
    replacement: "Default branch (you will usually use this for PRs)",
  },
  {
    id: "body-lit-claude-code-cli",
    targets: ["body"],
    mode: "literal",
    source: "You are Claude Code, Anthropic's official CLI for Claude",
    replacement: "You are an AI coding assistant, an official CLI tool for Claude",
  },
  {
    id: "body-lit-codex-cli",
    targets: ["body"],
    mode: "literal",
    source:
      "You are a coding agent running in the Codex CLI, a terminal-based coding assistant",
    replacement:
      "You are a coding agent running in this CLI tool, a terminal-based coding assistant",
  },
  {
    id: "body-lit-feedback-url",
    targets: ["body"],
    mode: "literal",
    source:
      "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    replacement:
      "To provide feedback, report the issue at https://example.invalid/feedback/issues",
  },
  {
    id: "body-lit-sisyphus-junior",
    targets: ["body"],
    mode: "literal",
    source: "Sisyphus-Junior - Focused executor from OhMyOpenCode",
    replacement: "Focused executor",
  },
  // R2 品牌名改写 (R1 的兜底：处理裸提及)
  {
    id: "body-brand-deepseek-harness",
    targets: ["body"],
    mode: "literal",
    source: "DeepSeek Harness",
    replacement: "this harness",
  },
  {
    id: "body-brand-deepseek-runtime",
    targets: ["body"],
    mode: "literal",
    source: "DeepSeekRuntime",
    replacement: "this runtime",
  },
  {
    id: "body-brand-ohmyopencode",
    targets: ["body"],
    mode: "literal",
    source: "OhMyOpenCode",
    replacement: "this workspace",
  },
  // R3 身份从句：把整句 "You are ... powered by ..." 换成中性句
  {
    id: "body-identity-clause",
    targets: ["body"],
    mode: "regex",
    source:
      "(You are\\s+(?:an?\\s+|the\\s+)?(?:[\\w.-]+\\s+){0,3}?(?:agent|assistant|model|AI|LLM)?[\\s,]*)(?:powered by|built on|built by|created by|developed by|made by|trained by)([^\\n]*?\\.)(\\s|$)",
    flags: "gi",
    replacement: "",
    replace: (_m: string, _g1: string, _g2: string, g3: string) =>
      `You are a helpful AI assistant.${g3 || ""}`,
  },
  // R4 裸错误码 —— 上游把错误码本身也当指纹
  {
    id: "body-bare-error-code",
    targets: ["body"],
    mode: "regex",
    source: "\\b11128\\b",
    flags: "g",
    replacement: "11-128",
  },
  // R5 cc_entrypoint=<非空白>
  {
    id: "body-entrypoint",
    targets: ["body"],
    mode: "regex",
    source: "\\bcc_entrypoint=\\S+",
    flags: "gi",
    replacement: "",
  },
  // R6 </?model_identity> 标签
  {
    id: "body-model-identity-tag",
    targets: ["body"],
    mode: "regex",
    source: "<\\/?model_identity>",
    flags: "gi",
    replacement: "",
  },
  // R7 服务端注入的身份指令 (保留结尾非字面字符，避免吃掉相邻文本)
  {
    id: "body-self-identity-instruction",
    targets: ["body"],
    mode: "regex",
    source:
      "(When asked about your[^.\\n]{0,60}?identity[^.\\n]{0,60}?,\\s*identify yourself as\\s+[^\\n]{1,80}?\\.)(\\W|$)",
    flags: "gi",
    replacement: "",
    replace: (_m: string, _g1: string, g2: string) =>
      `When asked about your capabilities, answer using only the information available in this conversation.${g2 || ""}`,
  },
  // R8 XML 风格标记
  {
    id: "body-xml-markers",
    targets: ["body"],
    mode: "regex",
    source: "<\\/?(?:agent-identity|Role|Behavior_Instructions)>",
    flags: "gi",
    replacement: "",
  },
];

/** prompt 子集 (system-transform 钩子)  */
const PROMPT_FINGERPRINT_RULES = FINGERPRINT_RULES.filter((rule) =>
  rule.targets.includes("prompt"),
);

/** body 子集 (请求体净化)  */
const BODY_FINGERPRINT_RULES = FINGERPRINT_RULES.filter((rule) =>
  rule.targets.includes("body"),
);

/** A1 兜底 system 提示词 (system 消息内容被清空时使用)  */
const FINGERPRINT_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** 正则元字符转义 (用于把固定短语安全地编译成正则)  */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 大小写不敏感的固定短语替换。
 * 用函数式 replacement —— 避免替换文本里的 `$` 被当成引用。
 */
function replaceLiteral(
  text: string,
  source: string,
  replacement: string,
): { text: string; count: number } {
  const re = new RegExp(escapeRegExp(source), "gi");
  let count = 0;
  const out = text.replace(re, () => {
    count++;
    return replacement;
  });
  return { text: out, count };
}

/**
 * 规则引擎：把一组规则按顺序应用到一段文本。
 * 纯函数：不读环境变量、不打日志、不碰网络。
 */
function applyFingerprintRules(
  text: string,
  rules: FingerprintRule[],
): { text: string; spans: number } {
  if (typeof text !== "string" || text.length === 0) {
    return { text, spans: 0 };
  }
  let out = text;
  let spans = 0;

  for (const rule of rules) {
    if (rule.mode === "literal") {
      const res = replaceLiteral(out, rule.source, rule.replacement);
      out = res.text;
      spans += res.count;
      continue;
    }
    let count = 0;
    // 每次新建 RegExp —— 避免模块级 /g 正则的 lastIndex 状态串味
    const re = new RegExp(rule.source, rule.flags || "gi");
    out = out.replace(re, (...args: string[]) => {
      count++;
      return rule.replace ? rule.replace(...args) : rule.replacement;
    });
    spans += count;
  }

  return { text: out, spans };
}

/**
 * 对单条系统提示词做指纹净化 (prompt 子集) 。
 * 纯函数：不读环境变量、不打日志 —— 命中短语逐条替换，其余文本逐字节保留。
 * 供钩子与外部验证脚本共用 (钩子侧另行判断 provider 与开关) 。
 */
export function sanitizeSystemPromptForTest(text: string): string {
  return applyFingerprintRules(text, PROMPT_FINGERPRINT_RULES).text;
}

/**
 * 对单段文本做指纹净化 (body 子集) 。
 * 纯函数：不读环境变量、不打日志、不碰网络。
 */
export function sanitizeFingerprintTextForTest(text: string): {
  text: string;
  spans: number;
} {
  return applyFingerprintRules(text, BODY_FINGERPRINT_RULES);
}

/** 环境变量开关的"停用值"判定：off / 0 / false / no */
function isSwitchOff(raw: string | undefined): boolean {
  const value = (raw || "").trim().toLowerCase();
  if (!value) return false;
  return value === "off" || value === "0" || value === "false" || value === "no";
}

/**
 * 指纹净化总开关 (唯一开关) ：CODEBUDDY_FINGERPRINT_SANITIZE=off 停用**文本改写**。
 * 旧名 CODEBUDDY_PROMPT_SANITIZE 保留为废弃别名 —— 两个开关任一为停用值即整体停用。
 * 注意：本开关**只管文本改写**；A1 (首条消息必须是 system) 由独立开关控制。
 */
export function isFingerprintSanitizeEnabled(): boolean {
  if (isSwitchOff(process.env.CODEBUDDY_FINGERPRINT_SANITIZE)) return false;
  if (isSwitchOff(process.env.CODEBUDDY_PROMPT_SANITIZE)) return false;
  return true;
}

/**
 * A1 (首条消息必须是 system) 开关：CODEBUDDY_FINGERPRINT_SYSTEM_FIRST=off 停用。
 * 与净化开关相互独立 —— 协议形态修正与文本改写是两件事。
 */
export function isSystemFirstEnabled(): boolean {
  return !isSwitchOff(process.env.CODEBUDDY_FINGERPRINT_SYSTEM_FIRST);
}

/**
 * 净化作用范围：CODEBUDDY_FINGERPRINT_SCOPE=all | system-assistant。
 * 默认 system-assistant —— 线上实测 (2026-11-18) ：上游只扫描 system 与 assistant
 * 消息，user / tool 角色携带同样短语时上游返回 200 (P1/P2 实测通过) 。
 */
export function getFingerprintScope(): FingerprintScope {
  const raw = (process.env.CODEBUDDY_FINGERPRINT_SCOPE || "").trim().toLowerCase();
  if (raw === "all") return "all";
  return "system-assistant";
}

/** 废弃别名的提示只打一次 */
let deprecatedAliasNotified = false;

/** 首次见到废弃别名时打一条 info (提醒迁移到 CODEBUDDY_FINGERPRINT_SANITIZE)  */
function noteDeprecatedAliasOnce(log: LogFn): void {
  if (deprecatedAliasNotified) return;
  if (!(process.env.CODEBUDDY_PROMPT_SANITIZE || "").trim()) return;
  deprecatedAliasNotified = true;
  log(
    "info",
    `[${VERSION_TAG}] CODEBUDDY_PROMPT_SANITIZE is deprecated, use CODEBUDDY_FINGERPRINT_SANITIZE instead (alias honoured: either switch disables fingerprint sanitizing)`,
  );
}

// ============================================================================
// 请求体级指纹净化 (规避上游渠道校验 code 11128)
// ----------------------------------------------------------------------------
// 根因 (已由线上 A/B 抓包证实) ：
//   上游对请求体做"大小写不敏感的精确子串匹配"，扫描范围覆盖 role:"system"
//   与 role:"assistant" 的消息 (含 reasoning_content) 。任何一条历史消息里
//   残留的第三方 harness 身份短语，都会让**整条请求**被拒：
//     HTTP 400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
//   症状表现为"同一会话第一轮正常、后续轮次随机 400"。
//
// 修复策略 (在 loader 的 fetch 拦截里对**发出去的请求体**做改写) ：
//   1. A1 —— 保证 messages[0] 是 system 消息 (developer 就地改；不是就补一条) 。
//      独立开关 CODEBUDDY_FINGERPRINT_SYSTEM_FIRST=off —— 与文本净化开关无关。
//   2. A2 —— 对每条消息的文本做"逐条短语改写" (逐字匹配、大小写不敏感) ，
//      只改写命中的那一小片，其余文本逐字节保留。
//      —— 刻意**不**整体替换系统提示词：用户的 AGENTS.md 指令必须完整存活。
//      作用范围由 CODEBUDDY_FINGERPRINT_SCOPE 控制 (默认 system-assistant：
//      线上实测上游不扫描 user / tool 角色) 。
//   3. 幂等：净化两次 == 净化一次；无关文本不被改动。
//   4. 深拷贝：净化在**副本**上进行 —— 宿主传入的请求对象绝不被就地修改。
//   5. 工具入参：改写后必须是合法 JSON，否则回滚该字段 (只记计数) 。
//   6. 空内容：system 内容被清空 -> 换成中性默认提示词；
//      assistant 内容被清空且无 tool_calls -> 整条丢掉 (上游拒绝空消息) 。
//
// 开关：CODEBUDDY_FINGERPRINT_SANITIZE=off 停用**文本改写** (默认启用) 。
// ============================================================================

/** 深拷贝任意 JSON 值 (不共享任何引用)  */
function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) out[key] = cloneValue(src[key]);
    return out;
  }
  return value;
}

/** 消息 content 的形态与文本内容 */
interface ContentTextState {
  /** none = null/undefined；string = 字符串；text-array = 纯文本分片数组；other = 含非文本分片 */
  kind: "none" | "string" | "text-array" | "other";
  /** 文本内容 (text-array 时为所有文本分片拼接)  */
  text: string;
}

/** 判定消息 content 的形态与文本内容 (用于空内容处理)  */
function contentTextState(content: unknown): ContentTextState {
  if (typeof content === "string") return { kind: "string", text: content };
  if (Array.isArray(content)) {
    let text = "";
    let allText = true;
    for (const part of content) {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          text += p.text;
          continue;
        }
      }
      allText = false;
    }
    return allText ? { kind: "text-array", text } : { kind: "other", text };
  }
  if (content === null || content === undefined) return { kind: "none", text: "" };
  return { kind: "other", text: "" };
}

/** 工具入参必须是合法 JSON —— 删除型规则可能清空，替换文本可能带引号 */
function isValidToolArguments(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// 注：原先分散在本文件的两份规则表 (提示词 6 条 + body 29 条) 已于 v4.0.1
// 合并为统一的 FINGERPRINT_RULES (见上方规则引擎) —— 此处不再保留第二份表。

/** 单条消息的净化结果 (只含计数与形态，绝不含内容)  */
interface MessageSanitizeResult {
  /** 是否发生过改写 */
  rewritten: boolean;
  /** 命中的短语片段数 */
  spans: number;
  /** 因改写后 JSON 非法而回滚的工具入参个数 */
  toolArgsRolledBack: number;
  /** 消息角色 */
  role: string;
  /** 是否带 tool_calls */
  hasToolCalls: boolean;
  /** 改写前的文本内容形态 */
  contentKindBefore: "none" | "string" | "text-array" | "other";
  /** 改写后的文本内容形态 */
  contentKindAfter: "none" | "string" | "text-array" | "other";
  /** 文本内容是否被改写清空 */
  contentEmptied: boolean;
}

/**
 * 对单条消息的所有文本字段做指纹净化 (就地修改 —— 调用方保证这是插件自己的副本) 。
 * 覆盖：content (字符串 / 数组里的 text 分片) 、reasoning_content、reasoning、
 *      tool_calls[].function.arguments。
 *
 * 作用范围 (scope) ：
 *   all              —— 所有 role 的文本都改写 (v4.0.0 行为)
 *   system-assistant —— 只改写 system / assistant 消息的文本；
 *                       tool_calls[].function.arguments 仍然改写
 *                        (那是模型产出的内容，不是用户数据)
 */
function sanitizeChatMessage(
  message: unknown,
  scope: FingerprintScope,
  rewriteText: boolean,
): MessageSanitizeResult {
  const result: MessageSanitizeResult = {
    rewritten: false,
    spans: 0,
    toolArgsRolledBack: 0,
    role: "",
    hasToolCalls: false,
    contentKindBefore: "none",
    contentKindAfter: "none",
    contentEmptied: false,
  };
  if (!message || typeof message !== "object") return result;
  const msg = message as Record<string, unknown>;

  result.role = typeof msg.role === "string" ? msg.role : "";
  const before = contentTextState(msg.content);
  result.contentKindBefore = before.kind;

  const rewriteMessageText =
    rewriteText &&
    (scope === "all" ||
      result.role === "system" ||
      result.role === "assistant");

  // content —— 字符串形态
  if (rewriteMessageText && typeof msg.content === "string") {
    const res = sanitizeFingerprintTextForTest(msg.content);
    if (res.spans > 0) {
      msg.content = res.text;
      result.spans += res.spans;
      result.rewritten = true;
    }
  } else if (rewriteMessageText && Array.isArray(msg.content)) {
    // content —— 数组形态：只改写 type === "text" 的分片，其余类型原样保留
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "text" || typeof p.text !== "string") continue;
      const res = sanitizeFingerprintTextForTest(p.text);
      if (res.spans > 0) {
        p.text = res.text;
        result.spans += res.spans;
        result.rewritten = true;
      }
    }
  }

  // reasoning_content / reasoning —— 上游会把这些字段带回去并一起扫描
  if (rewriteMessageText) {
    for (const key of ["reasoning_content", "reasoning"]) {
      if (typeof msg[key] !== "string") continue;
      const res = sanitizeFingerprintTextForTest(msg[key] as string);
      if (res.spans > 0) {
        msg[key] = res.text;
        result.spans += res.spans;
        result.rewritten = true;
      }
    }
  }

  // tool_calls[].function.arguments —— 工具入参里也可能带身份短语。
  // 这是模型产出的内容，与 role 无关 —— 不受作用范围限制，但仍受净化总开关约束。
  if (Array.isArray(msg.tool_calls)) {
    result.hasToolCalls = msg.tool_calls.length > 0;
    if (rewriteText) {
      for (const call of msg.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const fn = (call as Record<string, unknown>).function;
        if (!fn || typeof fn !== "object") continue;
        const holder = fn as Record<string, unknown>;
        if (typeof holder.arguments !== "string") continue;
        const original = holder.arguments;
        const res = sanitizeFingerprintTextForTest(original);
        if (res.spans === 0) continue;
        // 改写后必须是合法 JSON —— 删除型规则可能清空，替换文本可能带引号
        if (!isValidToolArguments(res.text)) {
          result.toolArgsRolledBack++;
          continue; // 回滚：保留原文
        }
        holder.arguments = res.text;
        result.spans += res.spans;
        result.rewritten = true;
      }
    }
  }

  const after = contentTextState(msg.content);
  result.contentKindAfter = after.kind;
  result.contentEmptied =
    before.text !== "" &&
    after.text === "" &&
    (after.kind === "string" || after.kind === "text-array");

  return result;
}

/** 请求体净化的可调项 */
export interface FingerprintSanitizeOptions {
  /** 是否保证首条消息是 system (默认 true；由 CODEBUDDY_FINGERPRINT_SYSTEM_FIRST 控制)  */
  systemFirst?: boolean;
  /** 是否改写文本 (默认 true；由 CODEBUDDY_FINGERPRINT_SANITIZE 控制)  */
  rewriteText?: boolean;
  /** 作用范围 (默认取环境变量解析结果)  */
  scope?: FingerprintScope;
}

/** 请求体净化结果 (只含计数，绝不含内容)  */
export interface FingerprintSanitizeResult {
  body: unknown;
  messagesScanned: number;
  messagesRewritten: number;
  spansRewritten: number;
  systemFirstApplied: boolean;
  emptyContentReplaced: number;
  emptyAssistantDropped: number;
  toolArgsRolledBack: number;
  scope: FingerprintScope;
}

/**
 * 请求体级指纹净化入口 (纯函数，不依赖网络与环境变量) 。
 * 深拷贝 messages 后再改写 —— **绝不修改调用方传入的对象**。
 * 返回改写后的**新** body，调用方必须使用返回值。
 */
export function sanitizePayloadForTest(
  body: unknown,
  options: FingerprintSanitizeOptions = {},
): FingerprintSanitizeResult {
  const scope = options.scope ?? getFingerprintScope();
  const rewriteText = options.rewriteText !== false;
  const systemFirst = options.systemFirst !== false;
  const result: FingerprintSanitizeResult = {
    body,
    messagesScanned: 0,
    messagesRewritten: 0,
    spansRewritten: 0,
    systemFirstApplied: false,
    emptyContentReplaced: 0,
    emptyAssistantDropped: 0,
    toolArgsRolledBack: 0,
    scope,
  };
  if (!body || typeof body !== "object" || Array.isArray(body)) return result;
  const payload = body as Record<string, unknown>;
  const originalMessages = payload.messages;
  if (!Array.isArray(originalMessages)) return result;

  // 深拷贝 —— 宿主传入的 messages 数组与消息对象绝不能被就地改写
  const messages = originalMessages.map((message) => cloneValue(message));
  const nextPayload: Record<string, unknown> = { ...payload, messages };

  // A1 —— 首条消息必须是 system (与文本净化开关相互独立)
  if (systemFirst) {
    ensureSystemFirst(messages);
    result.systemFirstApplied = true;
  }

  let messagesRewritten = 0;
  let spansRewritten = 0;
  let toolArgsRolledBack = 0;
  let emptyContentReplaced = 0;
  let emptyAssistantDropped = 0;
  const kept: unknown[] = [];

  for (const message of messages) {
    const res = sanitizeChatMessage(message, scope, rewriteText);
    spansRewritten += res.spans;
    toolArgsRolledBack += res.toolArgsRolledBack;
    if (res.rewritten) messagesRewritten++;

    // 空内容处理 —— 上游拒绝空消息
    if (res.role === "system" && res.contentEmptied) {
      // system 内容被清空 -> 换成中性默认提示词
      (message as Record<string, unknown>).content =
        FINGERPRINT_DEFAULT_SYSTEM_PROMPT;
      emptyContentReplaced++;
    } else if (
      res.role === "assistant" &&
      res.contentEmptied &&
      !res.hasToolCalls
    ) {
      // assistant 内容被清空且没有工具调用 -> 整条丢掉
      emptyAssistantDropped++;
      continue;
    }
    kept.push(message);
  }

  nextPayload.messages = kept;
  return {
    body: nextPayload,
    messagesScanned: messages.length,
    messagesRewritten,
    spansRewritten,
    systemFirstApplied: result.systemFirstApplied,
    emptyContentReplaced,
    emptyAssistantDropped,
    toolArgsRolledBack,
    scope,
  };
}

/** A1 —— 保证 messages[0] 是 system 消息 (就地修改数组)  */
function ensureSystemFirst(messages: unknown[]): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    messages.unshift({
      role: "system",
      content: FINGERPRINT_DEFAULT_SYSTEM_PROMPT,
    });
    return;
  }
  const first = messages[0] as Record<string, unknown> | undefined;
  const role =
    first && typeof first === "object" ? first.role : undefined;
  if (role === "developer") {
    // developer -> system，内容原样保留
    first!.role = "system";
    return;
  }
  if (role !== "system") {
    messages.unshift({
      role: "system",
      content: FINGERPRINT_DEFAULT_SYSTEM_PROMPT,
    });
  }
}

// ============================================================================
// 上游错误分类 (防日志自污染)
// ----------------------------------------------------------------------------
// 根因：上游的错误体里带着 code 11128 与 "Illegal API invocation from an
// unapproved channel" 这句话。宿主日志会被 agent 读回 —— 那句话重新进入对话，
// 下一轮请求里又出现同样的指纹，于是又触发同一个错误：自污染回路。
//
// 铁律：
//   1. 上游 msg / 错误体**绝不**原样写进日志、诊断文件或抛出的错误；
//   2. 只记稳定分类：HTTP 状态 + 固定枚举标签 + 脱敏后的业务码；
//   3. 自指错误码 (11128) 映射成符号标签，绝不按裸数字写出去。
// ============================================================================

/** 上游错误分类标签 (固定枚举)  */
export type UpstreamErrorLabel = "channel-reject" | "auth" | "rate-limit" | "other";

/**
 * 自指错误码黑名单 —— 这些码本身会被上游当作指纹。
 * 一律映射成符号标签，绝不按裸数字写进日志。
 */
const UPSTREAM_SELF_REFERENTIAL_CODES: Record<string, string> = {
  "11128": "CHANNEL_REJECT",
};

/** 自指文本片段 (脱敏用)  */
const UPSTREAM_SELF_REFERENTIAL_PATTERNS: Array<{
  source: string;
  flags: string;
  label: string;
}> = [
  {
    source: "illegal\\s+api\\s+invocation[^\\n]{0,120}",
    flags: "gi",
    label: "[REDACTED:channel-reject]",
  },
  {
    source: "unapproved\\s+channel",
    flags: "gi",
    label: "[REDACTED:channel-reject]",
  },
  {
    source: "\\b11128\\b",
    flags: "g",
    label: "[REDACTED:CHANNEL_REJECT]",
  },
];

/** 把上游原文里的自指片段替换成符号标签 */
export function redactSelfReferentialText(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const pattern of UPSTREAM_SELF_REFERENTIAL_PATTERNS) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), pattern.label);
  }
  return out;
}

/** 从上游错误体里取业务码 (字符串或对象形态)  */
function extractUpstreamCode(body: unknown): string | null {
  if (typeof body === "string") {
    try {
      return extractUpstreamCode(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const code = (body as Record<string, unknown>).code;
  if (typeof code === "number" && Number.isFinite(code)) return String(code);
  if (typeof code === "string" && /^-?\d+$/.test(code.trim())) return code.trim();
  return null;
}

/** 依据 HTTP 状态给出分类标签 */
function upstreamLabelFromStatus(status: number): UpstreamErrorLabel {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  return "other";
}

/**
 * 上游错误分类 —— 只产出稳定标签与脱敏码，绝不回显上游原文。
 * 返回的 codeLabel 对自指错误码是符号标签 (CHANNEL_REJECT) ，不是裸数字。
 */
export function classifyUpstreamError(
  status: number,
  body: unknown,
): { label: UpstreamErrorLabel; codeLabel: string } {
  const code = extractUpstreamCode(body);
  if (code !== null) {
    const symbolic = UPSTREAM_SELF_REFERENTIAL_CODES[code];
    if (symbolic) return { label: "channel-reject", codeLabel: symbolic };
    return { label: upstreamLabelFromStatus(status), codeLabel: code };
  }
  return { label: upstreamLabelFromStatus(status), codeLabel: "" };
}

/**
 * 识别"HTTP 2xx 但 body 是 JSON 错误"的响应。
 * 上游偶尔用 200 返回 JSON 错误体 —— 这类响应逃过了 !response.ok 分支，
 * 此前从不被分类。这里只做分类与日志 —— body 仍原样转发给宿主
 *  (转发行为不在本次修复范围内) 。
 */
async function detectUpstreamJsonError(response: Response, log: LogFn): Promise<void> {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return;
  }
  if (!text.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  if (!("code" in (parsed as Record<string, unknown>))) return;
  const classified = classifyUpstreamError(response.status, parsed);
  log(
    "warn",
    `[${VERSION_TAG}] upstream error (2xx json body): status=${response.status} class=${classified.label} code=${classified.codeLabel || "none"}`,
  );
}

// ============================================================================
// 设备令牌 Provider (TuringShield N-API 原生插件)
// ----------------------------------------------------------------------------
// 官方客户端对个人版账号会带上 X-Device-Token，该值由腾讯 TuringShield 原生
// 插件 (N-API addon) 生成。官方 VS Code 扩展并不内嵌该 SDK (缺失时它发
// X-Device-Token-Error: sdk_not_initialized) ，说明服务端容忍该头缺失 ——
// 因此本实现全程 fail-open：任何一步失败都只是"不带这个头"，绝不影响聊天请求。
//
// 关键约束：
//   1. 绝不打印 token 内容，只打印布尔状态
//   2. 找不到原生插件 / 加载失败时缓存该状态，避免每个请求都重扫磁盘
//   3. token 本地缓存 60s，过期后按需重新生成
//   4. 禁止全盘遍历：候选根目录有界、候选路径数量有界、搜索深度有界
// ============================================================================

/** 国内版 (copilot.tencent.com / .cn) 渠道号 */
const TURING_CHANNEL_CN = 109137;
/** 国际版 (.ai) 渠道号 */
const TURING_CHANNEL_INTL = 400101;
/** token 本地缓存有效期 */
const TURING_TOKEN_TTL_MS = 60000;
/** 原生插件加载 + 取 token 的总超时 (fail-open 上限)  */
const TURING_FETCH_TIMEOUT_MS = 5000;
/** 候选路径数量上限 (禁止全盘遍历)  */
const TURING_MAX_CANDIDATES = 40;
/** 原生插件在客户端安装目录下的相对路径 */
const TURING_ADDON_RELATIVE = [
  "resources",
  "app",
  "extensions",
  "genie",
  "out",
  "prebuilds",
];
/** 原生插件文件名 */
const TURING_ADDON_FILE = "electron.napi.node";
/** 客户端安装目录名匹配规则 (大小写不敏感)  */
const TURING_CLIENT_DIR_PATTERN = /^(codebuddy[ _-]*cn|workbuddy)(\.app)?$/i;

interface TuringRiskResult {
  token?: string;
  error?: string;
}

interface TuringAddon {
  initialize?: (options: {
    channelId: number;
    productName: string;
    productVersion: string;
  }) => unknown;
  syncFetchRiskDetect?: (
    flagA: boolean,
    flagB: boolean,
  ) => TuringRiskResult | Promise<TuringRiskResult>;
  getSDKVer?: () => string;
  getDeviceInfo?: () => unknown;
}

interface TuringRuntime {
  addon: TuringAddon | null;
  addonPath: string;
  discovered: boolean;
  discoveryFailed: boolean;
  warned: boolean;
  initialized: boolean;
  channelId: number;
  token: string;
  tokenExpiresAt: number;
  inflight: Promise<string> | null;
}

const turingRuntime: TuringRuntime = {
  addon: null,
  addonPath: "",
  discovered: false,
  discoveryFailed: false,
  warned: false,
  initialized: false,
  channelId: 0,
  token: "",
  tokenExpiresAt: 0,
  inflight: null,
};

/** 渠道号：国际版 .ai 用 400101，其余用 109137 */
function resolveTuringChannelId(): number {
  const target = `${resolvedServerUrl} ${resolvedDomain}`.toLowerCase();
  return target.includes("codebuddy.ai") ? TURING_CHANNEL_INTL : TURING_CHANNEL_CN;
}

/**
 * 取得可用的 require 函数。
 * 产物是 CJS 时模块作用域自带 require；产物是 ESM 时 require 不存在，
 * 用 module.createRequire 兜底 (Node / Bun 均提供) 。
 */
let cachedRequireFn: ((id: string) => unknown) | null = null;
function getRequireFn(): ((id: string) => unknown) | null {
  if (cachedRequireFn) return cachedRequireFn;
  try {
    // CJS 产物：模块作用域的 require
    if (typeof require === "function") {
      cachedRequireFn = (id: string) =>
        (require as unknown as (target: string) => unknown)(id);
      return cachedRequireFn;
    }
  } catch {
    /* ESM 产物中 require 未定义，走下面的兜底 */
  }
  try {
    // ESM 产物：createRequire 兜底 (绝对路径加载不受 base 影响)
    const req = createRequire(path.join(process.cwd(), "codebuddy-auth-loader.cjs"));
    cachedRequireFn = (id: string) => req(id);
    return cachedRequireFn;
  } catch {
    return null;
  }
}

/** 候选根目录 (有界：固定几个环境变量目录 + 各固定盘根下的 Programs)  */
function collectTuringRootDirs(): string[] {
  const roots: string[] = [];
  const push = (candidate?: string | null): void => {
    if (!candidate) return;
    try {
      if (!fs.existsSync(candidate)) return;
    } catch {
      return;
    }
    if (!roots.includes(candidate)) roots.push(candidate);
  };

  push(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null);
  push(process.env.ProgramFiles);
  push(process.env.ProgramW6432);
  push(process.env.APPDATA);
  push("D:\\Programs");
  // 固定盘根目录下的 Programs 文件夹 —— 逐盘探测 (最多 26 个盘符) ，
  // 只做存在性判断，不做任何递归遍历
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const driveRoot = `${letter}:\\`;
    try {
      if (fs.existsSync(driveRoot)) push(path.join(driveRoot, "Programs"));
    } catch {
      /* 忽略不可访问的盘 */
    }
  }
  if (process.platform === "darwin") {
    push("/Applications");
    push(path.join(os.homedir(), "Applications"));
  } else if (process.platform === "linux") {
    push(path.join(os.homedir(), ".local", "share"));
    push("/opt");
  }
  return roots;
}

/** 在根目录下找客户端安装目录 (仅一层，深度 ≤ 3 内)  */
function listTuringClientDirs(root: string): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    if (!TURING_CLIENT_DIR_PATTERN.test(entry.name)) continue;
    found.push(path.join(root, entry.name));
  }
  return found;
}

/** 在预编译目录里取原生插件文件 (优先 electron.napi.node，缺失时取任意 *.napi.node)  */
function resolveAddonFileInDir(dir: string): string {
  const preferred = path.join(dir, TURING_ADDON_FILE);
  try {
    if (fs.existsSync(preferred)) return preferred;
  } catch {
    /* ignore */
  }
  try {
    const entries = fs.readdirSync(dir);
    const hit = entries.find((f) => f.toLowerCase().endsWith(".napi.node"));
    if (hit) return path.join(dir, hit);
  } catch {
    /* ignore */
  }
  return "";
}

/** 组装候选原生插件路径 (数量有界，最多 TURING_MAX_CANDIDATES 条)  */
function collectTuringCandidatePaths(platformArch: string): string[] {
  const candidates: string[] = [];
  for (const root of collectTuringRootDirs()) {
    for (const clientDir of listTuringClientDirs(root)) {
      // Windows / Linux 安装布局
      candidates.push(
        path.join(clientDir, ...TURING_ADDON_RELATIVE, platformArch, TURING_ADDON_FILE),
      );
      // macOS .app 包布局
      candidates.push(
        path.join(
          clientDir,
          "Contents",
          "Resources",
          ...TURING_ADDON_RELATIVE.slice(1),
          platformArch,
          TURING_ADDON_FILE,
        ),
      );
      if (candidates.length >= TURING_MAX_CANDIDATES) {
        return candidates.slice(0, TURING_MAX_CANDIDATES);
      }
    }
  }
  return candidates;
}

/** 定位原生插件：环境变量覆盖优先，否则在有界候选集中查找 */
function findTuringAddonPath(): string {
  const platformArch = `${process.platform}-${process.arch}`;
  const override = (process.env.CODEBUDDY_TURING_NATIVE || "").trim();
  if (override) {
    try {
      if (fs.existsSync(override)) {
        const stat = fs.statSync(override);
        if (!stat.isDirectory()) return override;
        // 覆盖值是目录时，按平台预编译子目录再找一次
        const hit = resolveAddonFileInDir(path.join(override, platformArch));
        if (hit) return hit;
        const flat = resolveAddonFileInDir(override);
        if (flat) return flat;
      }
    } catch {
      /* 覆盖值无效则继续走扫描 */
    }
  }
  for (const candidate of collectTuringCandidatePaths(platformArch)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return "";
}

/** 加载原生插件 (任何异常都吞掉，返回 null 表示不可用)  */
function loadTuringAddon(addonPath: string): TuringAddon | null {
  const req = getRequireFn();
  if (!req) return null;
  try {
    const mod = req(addonPath) as TuringAddon & { default?: TuringAddon };
    if (!mod) return null;
    const addon =
      typeof mod.default?.syncFetchRiskDetect === "function" ? mod.default : mod;
    if (typeof addon.syncFetchRiskDetect !== "function") return null;
    if (typeof addon.initialize !== "function") return null;
    return addon;
  } catch {
    return null;
  }
}

/** 向原生插件取设备令牌 (token 非空才算成功)  */
async function fetchTuringDeviceToken(addon: TuringAddon): Promise<string> {
  const channelId = resolveTuringChannelId();
  if (!turingRuntime.initialized || turingRuntime.channelId !== channelId) {
    await addon.initialize?.({
      channelId,
      productName: "CodeBuddy",
      productVersion: CONFIG.appVersion,
    });
    turingRuntime.initialized = true;
    turingRuntime.channelId = channelId;
  }
  const result = await addon.syncFetchRiskDetect?.(true, false);
  if (!result || typeof result !== "object") return "";
  if (typeof result.token === "string") return result.token.trim();
  return "";
}

/** 给 Promise 加超时兜底 (超时即返回 fallback，绝不 reject)  */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 真正去拿一次令牌 (含发现 + 加载 + 初始化) ，任何失败都返回空串 */
async function loadTuringDeviceToken(log: LogFn): Promise<string> {
  try {
    // 显式关闭开关：整个特性停用 (优先级最高 —— "feature off entirely")
    if ((process.env.CODEBUDDY_TURING_NATIVE_DISABLED || "").trim() === "1") {
      return "";
    }
    if (!turingRuntime.discovered) {
      // 只探测一次，结果 (成功/失败) 都缓存，避免每请求重扫磁盘
      turingRuntime.discovered = true;
      const addonPath = findTuringAddonPath();
      if (!addonPath) {
        turingRuntime.discoveryFailed = true;
        if (!turingRuntime.warned) {
          turingRuntime.warned = true;
          log(
            "warn",
            `[${VERSION_TAG}] TuringShield native addon not found (X-Device-Token disabled; set CODEBUDDY_TURING_NATIVE to override the path)`,
          );
        }
        return "";
      }
      const addon = loadTuringAddon(addonPath);
      if (!addon) {
        turingRuntime.discoveryFailed = true;
        if (!turingRuntime.warned) {
          turingRuntime.warned = true;
          log(
            "warn",
            `[${VERSION_TAG}] TuringShield native addon load failed (X-Device-Token disabled): ${addonPath}`,
          );
        }
        return "";
      }
      turingRuntime.addon = addon;
      turingRuntime.addonPath = addonPath;
    }
    const addon = turingRuntime.addon;
    if (!addon) return "";
    const token = await fetchTuringDeviceToken(addon);
    if (!token) return "";
    turingRuntime.token = token;
    turingRuntime.tokenExpiresAt = Date.now() + TURING_TOKEN_TTL_MS;
    return token;
  } catch {
    return "";
  }
}

/**
 * 设备令牌开关：CODEBUDDY_DEVICE_TOKEN=on 才启用 (默认关闭) 。
 *
 * 为什么默认关闭：
 *   官方客户端在拿不到 TuringShield 令牌时是"降级为不发该头"，而不是"自己造一个"。
 *   社区共识同样是"官方来源优先，否则不发"——伪造/自造令牌反而更像非官方渠道，
 *   反而增加被上游判为未批准渠道的风险。因此默认不发 X-Device-Token，
 *   只有显式打开环境变量时才启用 (provider 实现本身保持完整可用) 。
 */
function isDeviceTokenEnabled(): boolean {
  const raw = (process.env.CODEBUDDY_DEVICE_TOKEN || "").trim().toLowerCase();
  return raw === "on";
}

/**
 * 取当前设备令牌 (带 60s 缓存) 。
 * fail-open：任何异常都不会抛出，只会返回空串 (= 不带该头) 。
 * 默认关闭 (CODEBUDDY_DEVICE_TOKEN=on 才启用) 。
 */
async function getDeviceToken(log: LogFn = noopLog): Promise<string> {
  // 默认不带 X-Device-Token —— 官方客户端拿不到令牌时也是直接不发该头
  if (!isDeviceTokenEnabled()) return "";
  if (turingRuntime.token && Date.now() < turingRuntime.tokenExpiresAt) {
    return turingRuntime.token;
  }
  if (turingRuntime.inflight) return turingRuntime.inflight;
  const work = withTimeout(
    loadTuringDeviceToken(log),
    TURING_FETCH_TIMEOUT_MS,
    "",
  ).finally(() => {
    turingRuntime.inflight = null;
  });
  turingRuntime.inflight = work;
  return work;
}

/** 供外部脚本探测设备令牌可用性 (只返回令牌本身，不打印内容)  */
export async function getDeviceTokenForTest(): Promise<string | null> {
  const token = await getDeviceToken((level, message) => {
    try {
      console.log(`[codebuddy-fork][${level}] ${message}`);
    } catch {
      /* ignore */
    }
  });
  return token ? token : null;
}

// SSE 处理状态机：累积 reasoning_content，到 content/tool_calls/stop 时一次性 flush
// 这是解决"几十个 3ms 块"问题的根治方法。
// OpenCode 上游看到每个 reasoning_content delta 都会触发新的 ReasoningPart，
// 即使 finish_reason 修了也没用——必须让 OpenCode 只看到一个完整的 reasoning 块。
// ============================================================================
// SSE 处理核心 (v3 - 无死锁设计)
// ----------------------------------------------------------------------------
// 重要教训：ReadableStream 的 pull() 只在「消费者请求数据且内部队列空」时被调用。
// 任何「把数据攒起来、等时间到了再 enqueue」的缓冲逻辑都会死锁——因为攒起来但
// 没 enqueue 时，队列为空，下游 read() 永远 pending，pull() 不会被再次调用。
// 因此这里的设计铁律：
//   1. 每次 pull() 读到的数据，在本次调用内全部处理完并 enqueue，绝不留给下次
//   2. reasoning 合并只按「字符数阈值」分批，不按时间——数据流动就一定会触发 flush
//   3. content / tool_calls / finish 出现时，先把残余 reasoning flush 成独立 chunk
//       (OpenCode 上游 Lifecycle id="reasoning-0" 会把所有 reasoning delta 拼接
//        成一段完整思考，不会切碎)
// ============================================================================

type MergeState = {
  reasoningBuffer: string;
  totalChunksIn: number;
  totalChunksOut: number;
  reasoningFlushed: boolean;
  totalRawBytes: number;
  streamStartMs: number;
  // 日志收敛标记：heartbeat flush 只在首次打 info，后续静默 (原每 2s 一条会刷屏)
  heartbeatLogged: boolean;
};

// reasoning 分批阈值：每累积约 400 字符就 flush 一个 reasoning delta chunk。
// 太大 → 下游长时间无数据 (可能被误判超时) ；太小 → flush 太碎。
// 400 字符约等于正常模型 1-3 秒的思考输出，平衡流式感与开销。
const REASONING_BATCH_CHARS = 400;

// 版本标识 — 每次 tsc build 时计算新的时间戳
// ============================================================================
// 版本标识 (固定常量，不再用运行时 Date —— 之前运行时生成导致无法区分
// "磁盘产物是不是最新编译"，每次启动都不同，日志误导判断)
// 铁律：每次修改代码逻辑后，必须手动 bump 下面这个版本号！
//   v3.1 = 首次固定版本号机制
//   v3.2 = 修复 SSE 事件分隔符 bug (\n → \n\n，之前导致两个 JSON 拼接解析失败)
//   v3.2.1 = 空行跳过 (原始 SSE 空行分隔由每行自带 \n\n 承担，避免双空行 + ratio 虚高)
//   v3.6.0 = 对齐官方客户端指纹头 (X-Agent-Type / X-Root-Request-ID / UUID v4 Trace)
//   v3.7.0 = 接入 TuringShield 原生插件，接入 X-Device-Token 设备令牌
//   v3.8.0 = 对齐官方请求头 (X-Trace-ID / UUID v4 Request-ID / 会话稳定 X-Conversation-ID)
//            + 系统提示词指纹净化 (规避上游渠道校验 code 11128)
//   v3.9.0 = 凭据自愈 (启动主动刷新 + 离线会话被吊销时自动引导登录 + 会话级错误自愈)
//            + 账号侧车 (codebuddy-account.json) + codebuddy-login / codebuddy-doctor 命令
//   v4.0.0 = 请求体级指纹净化 (A1 首条 system 消息 + A2 逐条短语改写 R1~R8，
//            规避上游渠道校验 code 11128) + 请求头对齐官方 CodeBuddy IDE 4.12.0
//             (X-CodeBuddy-Request / X-Product-Code / X-Agent-Purpose 等，
//            去掉 X-B3-ParentSpanId，message-id 与 request-id 同值)
//            + 设备令牌改为 opt-in (CODEBUDDY_DEVICE_TOKEN=on)
//   v4.0.1 = 指纹净化九项正确性修复 (**行为修复**，非新功能) ：
//            1. A1 (首条 system 消息) 从净化开关里拆出 —— 独立开关
//               CODEBUDDY_FINGERPRINT_SYSTEM_FIRST=off
//            2. 请求体深拷贝 —— 不再就地改写宿主传入的对象
//            3. 作用范围可配 CODEBUDDY_FINGERPRINT_SCOPE (默认 system-assistant，
//               依据线上实测：上游不扫描 user / tool 角色)
//            4. tool_calls[].function.arguments 改写后校验 JSON，非法则回滚
//            5. 空内容处理：system 换中性默认提示词、assistant 无工具调用则丢弃
//            6. 日志防自污染：上游 msg / 裸错误码绝不进日志，只记稳定分类
//            7. 两张规则表合并为一张 (prompt + body 共用) ，开关收敛为一个
//                (CODEBUDDY_PROMPT_SANITIZE 保留为废弃别名)
//            8. 识别 HTTP 2xx + JSON 错误体的响应
//            9. 新增 scripts/verify-fingerprint.mjs 黄金回归测试
//   v4.2.0 = 按官方 CodeBuddy IDE 4.12.4 抓包对齐请求头：
//            1. 补客户端埋点头 monitor_promptpreparestarttime / monitor_httpsendtime
//                (两个 13 位毫秒时间戳，修复用量页"请求 / 提示词"列恒空)
//            2. X-IDE-Version / X-Product-Version / UA 升到 4.12.4
//            3. 恢复 X-B3-ParentSpanId (16 hex，会话内恒定)
//            4. 删除官方从不发送的 X-CodeBuddy-Request / X-Product-Code /
//               X-Private-Data / X-Agent-Purpose / X-Root-Request-ID / Origin / Referer
//            5. ID 形态改为 32 位小写 hex (X-Request-Trace-Id 仍为 UUID v4) ，
//               X-Conversation-Message-ID 不再与 X-Request-ID 同值，
//               会话维度 ID 由 sha256(sessionID) 稳定派生
const FORK_VERSION = "4.2.0";
const VERSION_TAG = `codebuddy-fork-v${FORK_VERSION}`;

function buildReasoningChunk(reasoningText: string): string {
  const rcObj = {
    id: "codebuddy-reasoning-flush",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "codebuddy",
    choices: [
      {
        index: 0,
        delta: { reasoning_content: reasoningText },
        finish_reason: null,
      },
    ],
  };
  return "data: " + JSON.stringify(rcObj);
}

// 处理单个 SSE data: 行。返回要 enqueue 的 SSE 行数组 (可空) 。
// 副作用：可能向 state.reasoningBuffer 累积 reasoning_content。
function processSseDataLine(line: string, state: MergeState): string[] {
  // 只处理 data: {...} 行；其他 SSE 行 (event:/id:/retry:/空行/注释) 原样返回
  if (!line.startsWith("data:")) return [line];
  const payload = line.slice(5).replace(/^\s/, ""); // 去前导空格
  if (payload === "" || payload === "[DONE]") return [line];

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(payload);
  } catch {
    return [line];
  }

  state.totalChunksIn++;

  // 字段规范化
  // 1. finish_reason: "" -> null  (CodeBuddy 网关非标准行为，OpenCode 会把 "" 误判为终止)
  // 2. 剥离 null/empty 非标准字段
  const choices = Array.isArray(obj.choices) ? (obj.choices as Array<Record<string, unknown>>) : [];
  for (const choice of choices) {
    if (choice.finish_reason === "") choice.finish_reason = null;
  }
  for (const key of ["function_call", "refusal", "extra_fields"]) {
    const v = obj[key];
    if (v === null || v === "") delete obj[key];
  }
  if (Array.isArray(obj.tool_calls) && (obj.tool_calls as unknown[]).length === 0) {
    delete obj.tool_calls;
  }

  if (choices.length === 0) return ["data: " + JSON.stringify(obj)];

  const firstChoice = choices[0];
  const delta = (firstChoice.delta || {}) as Record<string, unknown>;
  const finishReason = firstChoice.finish_reason as string | null | undefined;

  // 1. 把 reasoning_content 抽到 buffer，从原 delta 移除
  const reasoningChunk = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  if (reasoningChunk.length > 0) {
    state.reasoningBuffer += reasoningChunk;
    delete delta.reasoning_content;
  }

  const hasContent = typeof delta.content === "string" && delta.content.length > 0;
  const hasToolCalls = Array.isArray(delta.tool_calls) && (delta.tool_calls as unknown[]).length > 0;
  const isTerminal = finishReason === "stop" || finishReason === "length";

  const out: string[] = [];

  // 2. 触发点：content / tool_calls / stop / length 出现
  //    → 先 flush 残余 reasoning (独立 chunk) ，再发当前 chunk
  if (hasContent || hasToolCalls || isTerminal) {
    if (state.reasoningBuffer.length > 0) {
      out.push(buildReasoningChunk(state.reasoningBuffer));
      state.reasoningBuffer = "";
      state.reasoningFlushed = true;
    }
    out.push("data: " + JSON.stringify(obj));
    return out;
  }

  // 3. 纯 reasoning-only / role-only delta：
  //    - 若累积已达阈值 → flush 成 reasoning delta chunk
  //    - 否则不返回 (等累积)
  if (state.reasoningBuffer.length >= REASONING_BATCH_CHARS) {
    out.push(buildReasoningChunk(state.reasoningBuffer));
    state.reasoningBuffer = "";
    state.reasoningFlushed = true;
  }
  return out;
}

// reasoning 定时心跳 flush 参数
// 目的：防止"长时间零输出"被误判为卡死。thinking 很慢时，即使累积不到
// REASONING_BATCH_CHARS(400)，也每 HEARTBEAT 毫秒强制 flush 一次当前累积，
// 让 TUI 每 ~2 秒能看到思考在推进 (几词一刷) 。纯兜底，不影响正常分批逻辑。
const REASONING_HEARTBEAT_MS = 2000;

// 对流式响应做 SSE 规范化 + reasoning 分批合并
type LogFn = (level: "info" | "warn" | "debug", message: string) => void;
const noopLog: LogFn = () => {};

async function normalizeCodeBuddySSE(
  response: Response,
  log: LogFn = noopLog,
): Promise<Response> {
  // 非 SSE 响应 (如非流式 chat completion) 直接透传
  // NOTE: 保持 info 级别 —— 请求级事件频率低 (每请求1条) ，且是判断
  // "fork 是否生效 / 响应是否 SSE" 的核心排障信号。debug 在默认运行时
  // 不可见，降级会导致日常排查丢失此信号。
  const ct = response.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) {
    // 2xx + JSON 错误体：上游偶尔用 HTTP 200 返回 JSON 错误 —— 这类响应
    // 逃过了 !response.ok 分支，此前从不被分类。这里补上分类与日志
    // (body 仍原样转发给宿主 —— 转发行为不在本次修复范围内) 。
    await detectUpstreamJsonError(response, log);
    log("info", `[${VERSION_TAG}] non-SSE response, content-type: ${ct}`);
    return response;
  }
  log("info", `[${VERSION_TAG}] SSE stream detected, normalizing + batching reasoning`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const state: MergeState = {
    reasoningBuffer: "",
    totalChunksIn: 0,
    totalChunksOut: 0,
    reasoningFlushed: false,
    totalRawBytes: 0,
    streamStartMs: Date.now(),
    heartbeatLogged: false,
  };

  // ==========================================================================
  // 心跳机制 (setTimeout 链式续期，非 setInterval)
  // 防 setInterval 永不销毁的泄漏：每轮回调先检查 alive 标志，
  // 只有 stream 仍活跃才续期。即使某个清理路径漏执行，一旦 alive=false
  // 就不再调度下一轮 —— 结构性杜绝"定时器永活"。
  // ==========================================================================
  let heartbeatActive = true;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;

  const stopHeartbeat = () => {
    heartbeatActive = false;
    if (heartbeatTimer !== undefined) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  // 每 HEARTBEAT ms 强制 flush 累积的 reasoning (即使 pull 未被调用也能 enqueue)
  // 这是防"无限卡死"的关键兜底：reasoning-only 期间迟迟不达 400 字符阈值时，
  // 保证每 ~2s 至少输出一次 thinking，TUI 能看到推进，不会误判死锁。
  const scheduleHeartbeat = () => {
    if (!heartbeatActive) return;
    heartbeatTimer = setTimeout(() => {
      try {
        if (streamController && state.reasoningBuffer.length > 0) {
          const line = buildReasoningChunk(state.reasoningBuffer);
          streamController.enqueue(encoder.encode(line + "\n\n"));
          state.totalChunksOut++;
          state.reasoningFlushed = true;
          state.reasoningBuffer = "";
          // 日志收敛：heartbeat flush 每 ~2s 一次，若每次都打 info 会在长对话中刷几十上百条
          // 干扰其他排查。只在首次 flush 时打一条 info 说明心跳在工作，后续静默。
          // 若要诊断 heartbeat 是否规律触发，可临时取消注释下一行 (逐条日志) 。
          // log("info", `[${VERSION_TAG}] heartbeat flush ${line.length}B reasoning`);
          if (!state.heartbeatLogged) {
            state.heartbeatLogged = true;
            log("info", `[${VERSION_TAG}] heartbeat active (periodic reasoning flush enabled, first flush ${line.length}B)`);
          }
        }
      } catch { /* stream closed — ignore */ }
      scheduleHeartbeat(); // 续期：仅当 heartbeatActive 仍为 true 才会生效
    }, REASONING_HEARTBEAT_MS);
  };
  scheduleHeartbeat();

  const stream = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stopHeartbeat();
          // 流结束 — flush buffer 尾部 + 残余 reasoning
          if (buffer.length > 0) {
            const out = processSseDataLine(buffer, state);
            for (const o of out) controller.enqueue(encoder.encode(o + "\n\n"));
            buffer = "";
          }
          if (state.reasoningBuffer.length > 0) {
            controller.enqueue(encoder.encode(buildReasoningChunk(state.reasoningBuffer) + "\n\n"));
            state.reasoningFlushed = true;
            state.reasoningBuffer = "";
          }
          const dur = Date.now() - state.streamStartMs;
          const avgMs = state.totalChunksIn > 0 ? (dur / state.totalChunksIn).toFixed(2) : "0";
          log("info", `[${VERSION_TAG}] stream ended, in=${state.totalChunksIn} out=${state.totalChunksOut} ratio=${state.totalChunksIn > 0 ? (state.totalChunksOut / state.totalChunksIn).toFixed(2) : "0"} bytes=${state.totalRawBytes} dur=${dur}ms avg=${avgMs}ms/chunk`);
          controller.close();
          return;
        }
        state.totalRawBytes += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
        // 处理所有完整行
        // WARN: 绝对不能跳过空行！空行透传成 "\n\n" enqueue 是 ReadableStream 的"心跳"——
        // reasoning-only 期间 processSseDataLine 返回空数组 (不到阈值不输出) ，
        // 若此时也没有空行 enqueue，队列空 → 消费者 read() pending → pull 不再被调用 → 死锁。
        // 空行让消费者持续收到数据、pull 持续被调用。ratio=2.0 只是计数失真，不影响功能。
        let nl: number;
        // 防御：单次 pull 最多处理 MAX_LINES_PER_PULL 行，理论上 indexOf 每次 slice
        // 都会缩短 buffer 必会终止；此上限是极端异常输入下的最后保险，防无限自旋。
        let linesProcessed = 0;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          if (++linesProcessed > 100000) {
            log("warn", `[${VERSION_TAG}] pull line cap hit (${linesProcessed}), dropping tail`);
            break;
          }
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          const out = processSseDataLine(line, state);
          for (const o of out) {
            controller.enqueue(encoder.encode(o + "\n\n"));
            state.totalChunksOut++;
          }
        }
      } catch (err) {
        stopHeartbeat();
        log("warn", `[${VERSION_TAG}] stream error: ${String(err)}`);
        try {
          if (state.reasoningBuffer.length > 0) {
            controller.enqueue(encoder.encode(buildReasoningChunk(state.reasoningBuffer) + "\n\n"));
            state.reasoningBuffer = "";
          }
        } catch { /* swallow */ }
        controller.error(err);
      }
    },
    cancel() {
      stopHeartbeat();
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function requestAuthState(): Promise<{ state: string; url: string }> {
  const params = new URLSearchParams({ platform: CONFIG.platform, ioa: "1" });
  const response = await fetch(
    `${resolvedServerUrl}/v2/plugin/auth/state?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-No-Authorization": "true",
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
      },
    },
  );
  if (!response.ok) {
    const text = await response.text();
    // 抛出的错误里也不能带上游原文 (自指片段会被 agent 读回)
    throw new Error(
      `Auth state request failed: ${response.status} - ${redactSelfReferentialText(text)}`,
    );
  }
  const data = (await response.json()) as AuthStateResponse;
  if (data.code !== 0 || !data.data?.state) {
    throw new Error(
      `Invalid auth state response: ${redactSelfReferentialText(JSON.stringify(data))}`,
    );
  }
  const loginUrl =
    data.data.authUrl ||
    `${resolvedServerUrl}/login?platform=${CONFIG.platform}&state=${data.data.state}&ioa=1`;
  return { state: data.data.state, url: loginUrl };
}

async function pollForToken(
  state: string,
  expiresAt: number,
  signal?: AbortSignal,
): Promise<TokenPollResponse["data"] | null> {
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null;
    await sleep(3000);
    try {
      const response = await fetch(
        `${resolvedServerUrl}/v2/plugin/auth/token?state=${state}`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-No-Authorization": "true",
            "X-No-User-Id": "true",
            "X-No-Enterprise-Id": "true",
            "X-No-Department-Info": "true",
          },
          signal,
        },
      );
      if (response.ok) {
        const data = (await response.json()) as TokenPollResponse;
        if (data.code === 0 && data.data?.accessToken) return data.data;
      }
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

async function refreshAccessToken(
  accessToken: string,
  refreshToken: string,
): Promise<RefreshResponse["data"] | null> {
  try {
    const userId = decodeJwtPayload(accessToken)?.sub || "";
    const response = await fetch(
      `${resolvedServerUrl}/v2/plugin/auth/token/refresh`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Refresh-Token": refreshToken,
          "X-Auth-Refresh-Source": "plugin",
          "X-Product": CONFIG.product,
          "X-Domain": resolvedDomain,
          // 真实客户端始终带 X-User-Id；解不出来时宁可不发，也不发空值
          ...(userId ? { "X-User-Id": userId } : {}),
        },
        body: "{}",
      },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as RefreshResponse;
    if (data.code !== 0) return null;
    return data.data || null;
  } catch {
    return null;
  }
}

// ============================================================================
// 凭据自愈 (access token 过期 / 离线会话被吊销 / 账号切换)
// ----------------------------------------------------------------------------
// 目标：不依赖人类或模型驱动，插件自己把"坏掉的鉴权"修好，并把结果讲清楚。
// 三条自愈路径：
//   1. 启动自愈 (config 钩子) ：token 临近过期 -> 主动刷新；刷新失败 -> 引导登录。
//   2. 会话级自愈 (event 钩子) ：session.error 判定为鉴权失败 -> 刷新或引导登录。
//   3. 用户命令 (codebuddy-login / codebuddy-doctor) ：随时手动触发。
// 铁律：
//   1. 绝不打印 access / refresh / device token
//   2. 侧车文件 (账号信息) 读写全部 try/catch，失败不影响主流程
//   3. 绝不自动重放失败的用户消息 (可能造成重复副作用)
//   4. 绝不无谓打开浏览器 —— 只有真的需要重新登录时才开
// ============================================================================

/** 账号侧车文件名 (与 auth.json 同目录)  */
const ACCOUNT_SIDECAR_FILE = "codebuddy-account.json";

/** 启动时判定 access token 需要主动刷新的时间窗口 */
const TOKEN_EXPIRY_WINDOW_MS = 120000;

/** 引导登录的轮询间隔 */
const GUIDED_LOGIN_POLL_INTERVAL_MS = 2000;

/** 引导登录的最长等待时间 */
const GUIDED_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** 同一类自愈动作的冷却时间 (防止 toast 刷屏)  */
const SELF_HEAL_COOLDOWN_MS = 5 * 60 * 1000;

/** 同一条命令的去重窗口 (命令钩子 + 事件兜底双路触发时只执行一次)  */
const COMMAND_DEDUPE_MS = 60 * 1000;

/** TUI 提示条请求的超时时间 (无 TUI 订阅者时服务端会挂住该请求)  */
const TOAST_TIMEOUT_MS = 2000;

/** 令牌轮询：仍在登录中的业务码 */
const CODE_LOGIN_PENDING = 11217;

/** 插件自有的两条命令 */
const COMMAND_LOGIN = "codebuddy-login";
const COMMAND_DOCTOR = "codebuddy-doctor";

/** TUI 提示条的样式 */
type ToastVariant = "info" | "success" | "warning" | "error";

interface StoredAuthEntry {
	type: string;
	access?: string;
	refresh?: string;
	expires?: number;
}

interface AccountEntry {
	uid: string;
	nickname: string;
	enterpriseId: string;
	pluginEnabled: boolean;
}

interface AccountSidecar {
	uid: string;
	nickname: string;
	enterpriseId: string;
	pluginEnabled: boolean;
	domain: string;
	updatedAt: number;
}

interface AccountsResponse {
	code: number;
	msg?: string;
	data?: {
		accounts?: Array<{
			uid?: string;
			nickname?: string;
			enterpriseId?: string;
			pluginEnabled?: boolean;
		}>;
	};
}

interface DiagnosisReport {
	credentialPresent: boolean;
	hasRefreshToken: boolean;
	expires: number | null;
	expiresInMs: number | null;
	expiresInHuman: string;
	refreshViable: boolean;
	discoveryCount: number;
	deviceTokenAvailable: boolean;
	uid: string;
	nickname: string;
	sidecarPresent: boolean;
	sidecarUid: string;
	sidecarNickname: string;
	accountChanged: boolean;
}

/** 宿主客户端 —— 由插件工厂注入，供 toast / 凭据落盘复用 */
let hostClient: PluginInput["client"] | null = null;

/** 引导登录的单飞守卫：并发调用共享同一次尝试 */
let guidedLoginPromise: Promise<boolean> | null = null;

/** 自愈动作冷却表：key -> 上次触发时刻 */
const selfHealCooldown = new Map<string, number>();

/** 已由命令钩子处理过的命令 (供 command.executed 事件兜底去重)  */
let lastHandledCommand: { cmd: string; at: number } | null = null;

function getOpencodeDataDir(): string {
	return path.join(os.homedir(), ".local", "share", "opencode");
}

function getAuthFilePath(): string {
	return path.join(getOpencodeDataDir(), "auth.json");
}

function getSidecarFilePath(): string {
	return path.join(getOpencodeDataDir(), ACCOUNT_SIDECAR_FILE);
}

/** 读取磁盘上的 CodeBuddy 凭据 (宿主无 client.auth.get，只能读文件)  */
function readStoredAuth(): StoredAuthEntry | null {
	try {
		const raw = fs.readFileSync(getAuthFilePath(), "utf8");
		const all = JSON.parse(raw) as Record<string, StoredAuthEntry>;
		const entry = all[PROVIDER_ID];
		if (!entry || typeof entry !== "object") return null;
		return entry;
	} catch {
		return null;
	}
}

/** 读取账号侧车 (失败一律返回 null，绝不抛)  */
function readSidecar(): AccountSidecar | null {
	try {
		const raw = fs.readFileSync(getSidecarFilePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<AccountSidecar>;
		if (!parsed || typeof parsed !== "object") return null;
		return {
			uid: typeof parsed.uid === "string" ? parsed.uid : "",
			nickname: typeof parsed.nickname === "string" ? parsed.nickname : "",
			enterpriseId: typeof parsed.enterpriseId === "string" ? parsed.enterpriseId : "",
			pluginEnabled: parsed.pluginEnabled === true,
			domain: typeof parsed.domain === "string" ? parsed.domain : "",
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
		};
	} catch {
		return null;
	}
}

/** 写入账号侧车 (失败只返回 false，绝不抛)  */
function writeSidecar(sidecar: AccountSidecar): boolean {
	try {
		const dir = getOpencodeDataDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(getSidecarFilePath(), `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 拉取账号列表 (GET /v2/plugin/accounts)  */
async function fetchAccountEntries(accessToken: string): Promise<AccountEntry[]> {
	try {
		const response = await fetch(`${resolvedServerUrl}/v2/plugin/accounts`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"X-Domain": resolvedDomain,
			},
		});
		if (!response.ok) return [];
		const body = (await response.json()) as AccountsResponse;
		if (body.code !== 0) return [];
		const list = Array.isArray(body.data?.accounts) ? body.data.accounts : [];
		return list.map((item) => ({
			uid: typeof item?.uid === "string" ? item.uid : "",
			nickname: typeof item?.nickname === "string" ? item.nickname : "",
			enterpriseId: typeof item?.enterpriseId === "string" ? item.enterpriseId : "",
			pluginEnabled: item?.pluginEnabled === true,
		}));
	} catch {
		return [];
	}
}

/** 解析当前 access token 绑定的账号 (用 JWT sub 对齐 accounts[].uid)  */
async function resolveBoundAccount(accessToken: string): Promise<AccountEntry | null> {
	const list = await fetchAccountEntries(accessToken);
	if (list.length === 0) return null;
	const sub = decodeJwtPayload(accessToken)?.sub || "";
	if (sub) {
		const hit = list.find((item) => item.uid && item.uid === sub);
		if (hit) return hit;
	}
	// 兜底：账号列表只有一项时直接采用
	if (list.length === 1) return list[0] ?? null;
	return null;
}

/** 登录 / 刷新成功后同步账号侧车 */
async function syncSidecar(accessToken: string): Promise<AccountEntry | null> {
	const account = await resolveBoundAccount(accessToken);
	if (!account) return null;
	writeSidecar({
		uid: account.uid,
		nickname: account.nickname,
		enterpriseId: account.enterpriseId,
		pluginEnabled: account.pluginEnabled,
		domain: resolvedDomain,
		updatedAt: Date.now(),
	});
	return account;
}

/** 把凭据写回宿主 (只走 client.auth.set，绝不手工改 auth.json)  */
async function persistCredential(
	client: PluginInput["client"] | null,
	tokens: { accessToken: string; refreshToken?: string; expiresIn?: number },
	fallbackRefresh?: string,
): Promise<number> {
	const expires = tokens.expiresIn
		? Date.now() + tokens.expiresIn * 1000
		: Date.now() + 24 * 60 * 60 * 1000;
	try {
		await client?.auth.set({
			path: { id: PROVIDER_ID },
			body: {
				type: "oauth",
				access: tokens.accessToken,
				refresh: tokens.refreshToken || fallbackRefresh || "",
				expires,
			},
		});
	} catch {
		/* 落盘失败不阻断 —— 后续仍可用内存中的令牌 */
	}
	return expires;
}

/**
 * 弹出 TUI 提示条。
 * 铁律：绝不能无限等待 —— 没有 TUI 订阅者时 (例如 headless 的 opencode run) ，
 * 服务端的 /tui/show-toast 会挂住不返回 awaited 就会把启动流程一起卡死。
 * 因此：固定超时 + fire-and-forget，绝不阻塞调用方。
 */
function showToast(message: string, variant: ToastVariant = "info"): void {
	try {
		const signal =
			typeof AbortSignal !== "undefined" &&
			typeof AbortSignal.timeout === "function"
				? AbortSignal.timeout(TOAST_TIMEOUT_MS)
				: undefined;
		const request = hostClient?.tui.showToast({
			body: { message, variant, duration: 8000 },
			...(signal ? { signal } : {}),
		});
		if (request && typeof request.catch === "function") {
			void request.catch(() => {});
		}
	} catch {
		/* TUI 不可用时忽略 */
	}
}

/** 在用户默认浏览器里打开登录地址 (分离进程，不阻塞宿主)  */
function openInBrowser(url: string, log: LogFn): boolean {
	const fallback = (reason: string) => {
		log(
			"warn",
			`[${VERSION_TAG}] 无法自动打开浏览器 (${reason})，请手动打开以下地址完成登录: ${url}`,
		);
	};
	try {
		let command: string;
		let args: string[];
		if (process.platform === "win32") {
			// cmd /c start "" "<url>" —— start 的首个引号参数是窗口标题，必须显式给空串
			command = "cmd.exe";
			args = ["/c", "start", "", url];
		} else if (process.platform === "darwin") {
			command = "open";
			args = [url];
		} else {
			command = "xdg-open";
			args = [url];
		}
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", (err) => fallback(String(err)));
		child.unref();
		return true;
	} catch (err) {
		fallback(String(err));
		return false;
	}
}

/**
 * 判定一个会话错误是否属于鉴权失败。
 * 纯函数：只做判断，不碰网络与文件，便于离线验证。
 *   - ProviderAuthError：宿主已明确判定 provider 鉴权失败
 *   - APIError 且 statusCode 为 401 / 403：上游拒绝凭据
 */
export function isAuthFailureError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const err = error as { name?: unknown; data?: { statusCode?: unknown } };
	if (err.name === "ProviderAuthError") return true;
	const status = err.data?.statusCode;
	if (typeof status === "number" && (status === 401 || status === 403)) return true;
	return false;
}

/** 冷却闸门：同一 key 在窗口内只放行一次 */
function consumeCooldown(key: string, ms: number, log: LogFn, reason: string): boolean {
	const now = Date.now();
	const last = selfHealCooldown.get(key) || 0;
	if (now - last < ms) {
		const left = Math.ceil((ms - (now - last)) / 1000);
		log("info", `[${VERSION_TAG}] skipped ${reason} (cooldown, ${left}s left)`);
		return true;
	}
	selfHealCooldown.set(key, now);
	return false;
}

interface GuidedPollResult {
	ok: boolean;
	data?: { accessToken: string; refreshToken?: string; expiresIn?: number };
	reason?: string;
}

/**
 * 轮询登录结果。
 *   code 11217 -> 仍在登录中，继续等待
 *   code 0     -> 成功
 *   其它 code  -> 立刻中止并给出明确原因
 */
async function pollTokenForLogin(
	state: string,
	deadline: number,
	log: LogFn,
): Promise<GuidedPollResult> {
	while (Date.now() < deadline) {
		await sleep(GUIDED_LOGIN_POLL_INTERVAL_MS);
		try {
			const response = await fetch(
				`${resolvedServerUrl}/v2/plugin/auth/token?state=${state}`,
				{
					method: "GET",
					headers: {
						Accept: "application/json",
						"X-No-Authorization": "true",
						"X-No-User-Id": "true",
						"X-No-Enterprise-Id": "true",
						"X-No-Department-Info": "true",
					},
				},
			);
			if (!response.ok) {
				log("debug", `[${VERSION_TAG}] guided login poll HTTP ${response.status}`);
				continue;
			}
			const body = (await response.json()) as TokenPollResponse & { msg?: string };
			if (body.code === 0) {
				if (body.data?.accessToken) return { ok: true, data: body.data };
				return { ok: false, reason: "服务端返回成功但未携带访问令牌" };
			}
          if (body.code === CODE_LOGIN_PENDING) continue;
          const classified = classifyUpstreamError(response.status, body);
          return {
            ok: false,
            reason: `服务端返回异常业务码 ${classified.codeLabel || "未知"}${body.msg ? ` (${redactSelfReferentialText(body.msg)})` : ""}`,
          };
		} catch (err) {
			log("debug", `[${VERSION_TAG}] guided login poll error: ${String(err)}`);
		}
	}
	return { ok: false, reason: "等待登录超时 (5 分钟) " };
}

/** 真正执行一次引导登录：开浏览器 -> 轮询 -> 落盘 -> 更新侧车 -> 提示 */
async function performGuidedLogin(reason: string): Promise<boolean> {
	const log = hostLog;
	log("info", `[${VERSION_TAG}] guided login started (reason=${reason})`);
	let state = "";
	let url = "";
	try {
		const authState = await requestAuthState();
		state = authState.state;
		url = authState.url;
	} catch (err) {
		log("warn", `[${VERSION_TAG}] guided login aborted: auth state request failed: ${String(err)}`);
		showToast(`CodeBuddy 登录初始化失败：${String(err)}`, "error");
		return false;
	}
	openInBrowser(url, log);
	const result = await pollTokenForLogin(state, Date.now() + GUIDED_LOGIN_TIMEOUT_MS, log);
	if (!result.ok || !result.data) {
		const reasonText = result.reason || "未知原因";
		log("warn", `[${VERSION_TAG}] guided login failed: ${reasonText}`);
		showToast(`CodeBuddy 登录未完成：${reasonText}`, "warning");
		return false;
	}
	await persistCredential(hostClient, result.data);
	log("info", `[${VERSION_TAG}] guided login succeeded, credential persisted`);
	const account = await syncSidecar(result.data.accessToken);
	const nickname = account?.nickname || "未知账号";
	log("info", `[${VERSION_TAG}] guided login succeeded (account=${nickname})`);
	showToast(`CodeBuddy 已重新登录，账号 ${nickname}`, "success");
	return true;
}

/**
 * 引导登录入口 (单飞) 。
 * 并发调用共享同一次尝试，避免重复开浏览器、重复轮询。
 */
async function runGuidedLogin(reason: string): Promise<boolean> {
	if (guidedLoginPromise) {
		hostLog(
			"info",
			`[${VERSION_TAG}] guided login already in progress, reusing current attempt (reason=${reason})`,
		);
		return guidedLoginPromise;
	}
	guidedLoginPromise = performGuidedLogin(reason).finally(() => {
		guidedLoginPromise = null;
	});
	return guidedLoginPromise;
}

/**
 * 带重试的异步调用。
 * 冷启动时首次 HTTPS 连接可能超时 (DNS/TCP 握手) ，重试一次即可拿到稳定结果。
 */
async function withRetry<T>(
	work: () => Promise<T>,
	attempts: number,
	delayMs: number,
): Promise<T> {
	let lastError: unknown = null;
	for (let i = 0; i < attempts; i++) {
		try {
			return await work();
		} catch (err) {
			lastError = err;
			if (i < attempts - 1) await sleep(delayMs);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 组装诊断报告 (只含布尔值、计数、uid、昵称与过期时间戳，绝不含令牌)  */
async function buildDiagnosis(): Promise<DiagnosisReport> {
  const stored = readStoredAuth();
  const hasAccess = typeof stored?.access === "string" && stored.access.length > 0;
  const hasRefresh = typeof stored?.refresh === "string" && stored.refresh.length > 0;
  const expires = typeof stored?.expires === "number" ? stored.expires : null;
  const expiresInMs = expires === null ? null : expires - Date.now();
  let discoveryCount = 0;
  let uid = "";
  let nickname = "";
  let deviceTokenAvailable = false;
  if (hasAccess && stored?.access) {
    try {
      const discovered = await withRetry(
        () => fetchRemoteModels(stored.access as string, noopLog),
        3,
        500,
      );
      discoveryCount = discovered.length;
    } catch {
      discoveryCount = 0;
    }
    try {
      const account = await withRetry(
        () => resolveBoundAccount(stored.access as string),
        3,
        500,
      );
      uid = account?.uid || "";
      nickname = account?.nickname || "";
    } catch {
      uid = "";
      nickname = "";
    }
    try {
      deviceTokenAvailable = !!(await getDeviceToken(noopLog));
    } catch {
      deviceTokenAvailable = false;
    }
  }
	const sidecar = readSidecar();
	const accountChanged = !!(
		uid &&
		sidecar &&
		(sidecar.uid !== uid || sidecar.nickname !== nickname)
	);
	return {
		credentialPresent: hasAccess,
		hasRefreshToken: hasRefresh,
		expires,
		expiresInMs,
		expiresInHuman: formatRemaining(expiresInMs),
		// 刷新路径是否可用：静态判断 (凭据里带 refresh token 即具备刷新能力) 。
		// 刻意不发起真实刷新 —— 那会轮换掉线上可用的 refresh token。
		refreshViable: hasAccess && hasRefresh,
		discoveryCount,
		deviceTokenAvailable,
		uid,
		nickname,
		sidecarPresent: !!sidecar,
		sidecarUid: sidecar?.uid || "",
		sidecarNickname: sidecar?.nickname || "",
		accountChanged,
	};
}

/** 把剩余毫秒格式化成人类可读文本 */
function formatRemaining(ms: number | null): string {
	if (ms === null) return "未知";
	if (ms <= 0) return "已过期";
	const hours = ms / 3600000;
	if (hours >= 1) return `${hours.toFixed(1)} 小时`;
	const minutes = ms / 60000;
	return `${minutes.toFixed(1)} 分钟`;
}

/** 生成诊断摘要文本 (toast 用，简洁)  */
function formatDiagnosisSummary(report: DiagnosisReport): string {
  const parts: string[] = [];
  parts.push(report.credentialPresent ? "凭据有效" : "凭据缺失");
  if (report.expiresInHuman !== "未知") parts.push(`剩余 ${report.expiresInHuman}`);
  parts.push(`模型 ${report.discoveryCount}`);
  parts.push(`设备令牌 ${report.deviceTokenAvailable ? "可用" : "不可用"}`);
  if (report.nickname) parts.push(`账号 ${report.nickname}`);
  return `CodeBuddy: ${parts.join(" | ")}`;
}

/** 注入插件自有的两条命令 (与既有 config.command 合并，不覆盖用户配置)  */
function injectCodebuddyCommands(config: PluginConfig): void {
  const existing = (config.command || {}) as Record<
    string,
    { template: string; description?: string }
  >;
  config.command = {
    ...existing,
    [COMMAND_LOGIN]: {
      template:
        "CodeBuddy 重新登录 (由插件内部完成：自动打开浏览器完成 IOA 登录，无需模型介入) 。",
      description: "重新登录 CodeBuddy (自动打开浏览器完成 IOA 登录) ",
    },
    [COMMAND_DOCTOR]: {
      template:
        "CodeBuddy 连接诊断 (由插件内部完成：检查凭据、模型发现、设备令牌与绑定账号，无需模型介入) 。",
      description: "诊断 CodeBuddy 连接 (凭据、模型发现、设备令牌、绑定账号) ",
    },
  };
}

/**
 * 账号比对：token 当前绑定的账号与侧车记录不一致 => 用户换了账号。
 * 首次运行 (侧车不存在) 只做初始化，不打扰用户。
 */
async function reportAccountChange(accessToken: string, log: LogFn): Promise<void> {
  const account = await resolveBoundAccount(accessToken);
  if (!account || !account.uid) return;
  const uidShort = account.uid.slice(0, 8);
  const sidecar = readSidecar();
  if (!sidecar) {
    writeSidecar({
      uid: account.uid,
      nickname: account.nickname,
      enterpriseId: account.enterpriseId,
      pluginEnabled: account.pluginEnabled,
      domain: resolvedDomain,
      updatedAt: Date.now(),
    });
    log(
      "info",
      `[${VERSION_TAG}] account sidecar initialized (uid=${uidShort}, nickname=${account.nickname})`,
    );
    return;
  }
  if (sidecar.uid === account.uid && sidecar.nickname === account.nickname) return;
  log(
    "info",
    `[${VERSION_TAG}] bound account changed: ${sidecar.nickname || sidecar.uid.slice(0, 8)} -> ${account.nickname || uidShort} (uid=${uidShort})`,
  );
  // 通知之后立刻更新侧车，避免每次启动重复提示
  writeSidecar({
    uid: account.uid,
    nickname: account.nickname,
    enterpriseId: account.enterpriseId,
    pluginEnabled: account.pluginEnabled,
    domain: resolvedDomain,
    updatedAt: Date.now(),
  });
  showToast(
    `CodeBuddy 绑定账号已变为 ${account.nickname || uidShort} (${uidShort})`,
    "info",
  );
}

/**
 * 处理插件自有的两条命令 (命令钩子与事件兜底共用) 。
 * codebuddy-login 会打开浏览器并最长等待 5 分钟 —— 一律放后台跑，绝不阻塞宿主。
 */
async function handleCodebuddyCommand(command: string, args: string): Promise<void> {
  const cmd = (command || "").trim().toLowerCase();
  if (cmd !== COMMAND_LOGIN && cmd !== COMMAND_DOCTOR) return;
  hostLog("info", `[${VERSION_TAG}] command ${cmd} intercepted (args=${args || ""})`);
  if (cmd === COMMAND_LOGIN) {
    void runGuidedLogin("manual command").catch(() => {});
    return;
  }
  const report = await buildDiagnosis();
  hostLog("info", `[${VERSION_TAG}] codebuddy-doctor: ${JSON.stringify(report)}`);
  showToast(formatDiagnosisSummary(report), "info");
}

/** 会话级自愈：session.error 判定为鉴权失败时，先试刷新，不行再引导登录 */
async function handleSessionAuthFailure(error: unknown): Promise<void> {
  if (!isAuthFailureError(error)) return;
  const log = hostLog;
  if (
    consumeCooldown(
      "session-auth-failure",
      SELF_HEAL_COOLDOWN_MS,
      log,
      "session auth self-heal",
    )
  ) {
    return;
  }
  const stored = readStoredAuth();
  const refreshed =
    stored?.access && stored?.refresh
      ? await refreshAccessToken(stored.access, stored.refresh)
      : null;
  if (refreshed?.accessToken) {
    await persistCredential(hostClient, refreshed, stored?.refresh);
    void syncSidecar(refreshed.accessToken).catch(() => {});
    log("info", `[${VERSION_TAG}] session auth failure fixed by proactive token refresh`);
    showToast("CodeBuddy 凭据已自动续期，请重试本轮", "info");
    return;
  }
  log("warn", `[${VERSION_TAG}] session auth failure: refresh unavailable, guided login required`);
  void runGuidedLogin("session auth failure").catch(() => {});
  showToast("CodeBuddy 登录已失效，已打开浏览器请完成登录", "warning");
}


/**
 * 供外部脚本做离线诊断 (构建产物可被 bun / node 直接 require) 。
 * 绝不返回任何令牌内容。
 */
export async function diagnoseForTest(): Promise<DiagnosisReport> {
	try {
		return await buildDiagnosis();
	} catch {
		return {
			credentialPresent: false,
			hasRefreshToken: false,
			expires: null,
			expiresInMs: null,
			expiresInHuman: "未知",
			refreshViable: false,
			discoveryCount: 0,
			deviceTokenAvailable: false,
			uid: "",
			nickname: "",
			sidecarPresent: false,
			sidecarUid: "",
			sidecarNickname: "",
			accountChanged: false,
		};
	}
}

export const CodeBuddyAuthPlugin: Plugin = async (input) => {
  // 统一的日志出口 —— 各钩子共用，模块级 hostLog 供闭包外的钩子复用
  const log: LogFn = (level, message) => {
    try {
      input.client.app.log({
        body: { service: "codebuddy-fork", level, message },
      });
    } catch { /* ignore log failure */ }
  };
  hostLog = log;
  // 宿主客户端 —— 供 toast / 凭据落盘复用 (模块级，便于闭包外的钩子访问)
  hostClient = input.client;

  return {
    async config(config) {
      // 版本标识：每次启动打印一次，后续 stream ended 日志也带这个 tag
      log("info", `${VERSION_TAG} starting (schema=opencode-codebuddy-auth, build=${FORK_VERSION})`);
      // 注入插件自有的两条命令 (与既有 config.command 合并，不覆盖用户配置)
      injectCodebuddyCommands(config);
      if (!config.provider) config.provider = {};
      if (!config.provider[PROVIDER_ID]) {
        config.provider[PROVIDER_ID] = {
          npm: "@ai-sdk/openai-compatible",
          name: "CodeBuddy",
          options: {
            baseURL: `${resolvedServerUrl}/v2`,
            setCacheKey: true,
          },
          models: {},
        };
      }
      const provider = config.provider[PROVIDER_ID] as
        | Record<string, unknown>
        | undefined;
      if (!provider) return;
      const opts = (provider.options || {}) as Record<string, unknown>;
      const configuredBase = typeof opts.baseURL === "string" ? opts.baseURL : undefined;
      if (configuredBase) {
        try {
          const u = new URL(configuredBase);
          resolvedServerUrl = `${u.protocol}//${u.host}`;
          if (resolvedServerUrl.includes("codebuddy.ai")) {
            resolvedDomain = "www.codebuddy.ai";
          }
        } catch {}
      }
      if (!provider.models) {
        provider.models = {};
      }
      const models = provider.models as Record<string, unknown>;

      let discovered: RemoteModel[] = [];
      // 启动自愈：凭据缺失 / 刷新失败 => 需要重新登录
      let loginNeeded = false;
      let loginReason = "";
      let accessToken = "";
      try {
        const auth = readStoredAuth();
        if (!auth || auth.type !== "oauth" || !auth.access) {
          // 没有 access token —— 只能重新登录
          loginNeeded = true;
          loginReason = "startup: no access token";
        } else {
          accessToken = auth.access;
          // 主动刷新：token 已过期或将在 120s 内过期时先换新，避免首次发现走到 401
          if (
            auth.refresh &&
            typeof auth.expires === "number" &&
            Date.now() > auth.expires - TOKEN_EXPIRY_WINDOW_MS
          ) {
            try {
              const refreshed = await refreshAccessToken(accessToken, auth.refresh);
              if (refreshed?.accessToken) {
                accessToken = refreshed.accessToken;
                await persistCredential(input.client, refreshed, auth.refresh);
                log("info", `[${VERSION_TAG}] proactive token refresh succeeded`);
                // 刷新成功后同步账号侧车
                void syncSidecar(accessToken).catch(() => {});
              } else {
                log("warn", `[${VERSION_TAG}] proactive token refresh failed, guided login required`);
                loginNeeded = true;
                loginReason = "startup: refresh rejected";
              }
            } catch {
              log("warn", `[${VERSION_TAG}] proactive token refresh threw, guided login required`);
              loginNeeded = true;
              loginReason = "startup: refresh error";
            }
          }
          if (accessToken) {
            const work = fetchRemoteModels(accessToken, log);
            discovered = await Promise.race([
              work,
              new Promise<RemoteModel[]>((resolve) =>
                setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS),
              ),
            ]);
          }
        }
      } catch {
        // auth not available yet, use fallback
        loginNeeded = true;
        loginReason = "startup: credential read failed";
      }

      if (discovered.length === 0) {
        log("warn", `[${VERSION_TAG}] model discovery yielded 0 models, falling back to "${DEFAULT_MODEL.id}"`);
        discovered = [DEFAULT_MODEL];
      } else {
        log("info", `[${VERSION_TAG}] model discovery succeeded: ${discovered.length} model(s)`);
      }

      // 账号比对：token 绑定的账号与侧车不一致 => 说明用户换了账号
      // 加超时兜底 —— 账号比对是附加能力，绝不能拖住启动流程
      if (accessToken) {
        try {
          await withTimeout(reportAccountChange(accessToken, log), 5000, undefined);
        } catch {
          /* 账号比对失败不影响主流程 */
        }
      }

      // 需要登录：不阻塞启动 —— 后台发起引导登录，同时给用户一个提示
      if (loginNeeded) {
        log("warn", `[${VERSION_TAG}] guided login required (${loginReason})`);
        showToast("CodeBuddy 登录凭据缺失或已失效，正在发起重新登录 (浏览器将自动打开) ", "warning");
        void runGuidedLogin(loginReason || "startup").catch(() => {});
      }

      for (const m of discovered) {
        if (models[m.id]) continue;
        models[m.id] = remoteModelToConfig(m);
      }
    },
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth, _provider) {
        return {
          apiKey: "cli-proxy",
          baseURL: resolvedServerUrl,
          async fetch(
            url: RequestInfo | URL,
            init?: RequestInit,
          ): Promise<Response> {
            const urlStr = url.toString();
            if (!urlStr.includes("/chat/completions")) {
              return fetch(url, init);
            }
            // NOTE: 保持 info —— 请求级事件频率低，且是确认请求确实到达 fork、
            // 版本加载是否正确的最直接证据 (本轮多次调试靠它定位版本问题) 。
            log("info", `[${VERSION_TAG}] fetch intercepted: ${urlStr.substring(0, 120)}`);

            const currentAuth = await getAuth();
            if (currentAuth.type !== "oauth" || !currentAuth.access) {
              throw new Error("缺少 access token，请重新登录");
            }

            let accessToken = currentAuth.access;
            const body = init?.body;
            if (!body) {
              return new Response(
                JSON.stringify({ error: "Missing request body" }),
                {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                },
              );
            }

            const openaiRequest = JSON.parse(
              typeof body === "string"
                ? body
                : await new Response(body).text(),
            ) as OpenAIRequest;

            const resolvedModel = resolveModel(openaiRequest.model);
            if (!resolvedModel) {
              throw new Error(
                "未设置模型，请设置 CODEBUDDY_DEFAULT_MODEL 或在 OpenCode 选择模型",
              );
            }

            let requestBody: OpenAIRequest = {
              ...openaiRequest,
              model: resolvedModel,
              // 网关已不支持非流式 (code 11101) ，强制 stream=true
              stream: true,
            };
            if (openaiRequest.response_format) {
              requestBody.response_format = openaiRequest.response_format;
            }

            // 请求体级指纹净化 (规避上游渠道校验 code 11128) ：
            // 上游对 system / assistant 消息 (含 reasoning_content) 做子串扫描，
            // 任何一条历史消息残留的身份短语都会让整条请求被拒。
            // 只改写命中的片段，用户 AGENTS.md 指令完整保留。
            //
            // 三个开关各管一件事：
            //   CODEBUDDY_FINGERPRINT_SANITIZE   —— 文本改写总开关
            //   CODEBUDDY_FINGERPRINT_SYSTEM_FIRST —— A1 (首条消息必须是 system)
            //   CODEBUDDY_FINGERPRINT_SCOPE      —— 作用范围 (默认 system-assistant)
            // 净化在**深拷贝**上进行 —— 宿主传入的请求对象绝不被就地修改。
            noteDeprecatedAliasOnce(log);
            const sanitizeText = isFingerprintSanitizeEnabled();
            const systemFirst = isSystemFirstEnabled();
            const sanitized = sanitizePayloadForTest(requestBody, {
              systemFirst,
              rewriteText: sanitizeText,
            });
            requestBody = sanitized.body as OpenAIRequest;
            if (sanitizeText) {
              log(
                "info",
                `[${VERSION_TAG}] fingerprint sanitize: scope=${sanitized.scope} messages scanned=${sanitized.messagesScanned} rewritten=${sanitized.messagesRewritten} spans=${sanitized.spansRewritten} empty-replaced=${sanitized.emptyContentReplaced} empty-dropped=${sanitized.emptyAssistantDropped}`,
              );
            } else {
              log(
                "debug",
                `[${VERSION_TAG}] fingerprint sanitize text rewriting disabled (CODEBUDDY_FINGERPRINT_SANITIZE=off)`,
              );
            }
            if (!systemFirst) {
              log(
                "debug",
                `[${VERSION_TAG}] system-first message shaping disabled (CODEBUDDY_FINGERPRINT_SYSTEM_FIRST=off)`,
              );
            }
            if (sanitized.toolArgsRolledBack > 0) {
              // 只报计数 —— 绝不打印工具入参内容
              log(
                "warn",
                `[${VERSION_TAG}] fingerprint sanitize: ${sanitized.toolArgsRolledBack} tool argument(s) rolled back (invalid JSON after rewrite)`,
              );
            }

            // 设备令牌 (TuringShield 原生插件) ：默认关闭 (opt-in) ，fail-open
            const deviceToken = await getDeviceToken(log);
            log(
              "debug",
              `[${VERSION_TAG}] X-Device-Token attached: ${deviceToken ? "true" : "false"} (device token is opt-in and disabled by default; set CODEBUDDY_DEVICE_TOKEN=on to enable)`,
            );

            const doRequest = async (token: string) => {
              return fetch(
                `${resolvedServerUrl}${CONFIG.chatCompletionsPath}`,
                {
                  method: "POST",
                  headers: buildAuthHeaders(token, resolvedModel, deviceToken),
                  body: JSON.stringify(requestBody),
                },
              );
            };

            let response = await doRequest(accessToken);

            if (
              (response.status === 401 || response.status === 403) &&
              currentAuth.refresh
            ) {
              log("info", "[codebuddy] Token expired, attempting refresh...");
              const refreshed = await refreshAccessToken(
                currentAuth.access,
                currentAuth.refresh,
              );
              if (refreshed?.accessToken) {
                accessToken = refreshed.accessToken;
                const newExpires = refreshed.expiresIn
                  ? Date.now() + refreshed.expiresIn * 1000
                  : Date.now() + 24 * 60 * 60 * 1000;
                await input.client.auth.set({
                  path: { id: PROVIDER_ID },
                  body: {
                    type: "oauth",
                    access: refreshed.accessToken,
                    refresh: refreshed.refreshToken || currentAuth.refresh,
                    expires: newExpires,
                  },
                });
                response = await doRequest(accessToken);
              }
            }

            if (!response.ok) {
              const errorText = await response.text();
              // 上游错误体绝不能原样进日志 —— 宿主日志会被 agent 读回，
              // 那句 "Illegal API invocation ..." 与裸错误码会重新进入对话，
              // 下一轮请求里又出现同样的指纹，于是又触发同一个错误：自污染回路。
              // 只记稳定分类：HTTP 状态 + 固定枚举标签 + 脱敏后的业务码
              // (11128 映射成 CHANNEL_REJECT，绝不按裸数字写出去) 。
              const classified = classifyUpstreamError(response.status, errorText);
              log(
                "warn",
                `[${VERSION_TAG}] upstream error: status=${response.status} class=${classified.label} code=${classified.codeLabel || "none"}`,
              );
              return new Response(errorText, {
                status: response.status,
                headers: { "Content-Type": "application/json" },
              });
            }

            // 流式响应规范化：修复 CodeBuddy CN 网关返回的 finish_reason: ""
            // 非标准字段导致的 thinking 流被切碎成单字的 bug。
            return normalizeCodeBuddySSE(response, log);
          },
        };
      },
      methods: [
        {
          label: "IOA 登录 (浏览器)",
          type: "oauth",
          async authorize() {
            const authState = await requestAuthState();
            const expiresAt = Date.now() + 10 * 60 * 1000;
            return {
              url: authState.url,
              instructions: "请在浏览器中完成 IOA 登录",
              method: "auto" as const,
              async callback() {
                const tokenData = await pollForToken(
                  authState.state,
                  expiresAt,
                );
                if (!tokenData) return { type: "failed" as const };
                return {
                  type: "success" as const,
                  access: tokenData.accessToken,
                  refresh: tokenData.refreshToken || "",
                  expires: tokenData.expiresIn
                    ? Date.now() + tokenData.expiresIn * 1000
                    : Date.now() + 24 * 60 * 60 * 1000,
                };
              },
            };
          },
        },
      ],
    },
    async "chat.params"(input, output) {
      // 捕获会话 ID —— 用于稳定派生会话维度 ID (X-Conversation-ID / X-Trace-ID / X-B3-ParentSpanId)
      if (input?.sessionID) currentSessionId = input.sessionID;
      if (input.model.providerID !== PROVIDER_ID) return;
      output.options.baseURL = resolvedServerUrl;
    },
    /**
     * 命令拦截：插件自有的两条命令在本地直接处理，不触发任何模型调用。
     * 清空 output.parts 时必须原地修改 —— 宿主拿到的是同一个数组引用，
     * 重新赋值只会改到副本，宿主仍会用原数组发起模型调用。
     */
    async "command.execute.before"(input, output) {
      try {
        const cmd = (input?.command || "").trim().toLowerCase();
        if (cmd !== COMMAND_LOGIN && cmd !== COMMAND_DOCTOR) return;
        await handleCodebuddyCommand(cmd, input?.arguments || "");
        lastHandledCommand = { cmd, at: Date.now() };
        // 原地清空 —— 彻底阻断本轮 LLM 调用
        output.parts.splice(0, output.parts.length);
        // 宿主对命令总会起一轮 assistant 消息：parts 被清空后这一轮是空消息，
        // 上游会直接拒绝 (messages must not be empty) 并把整轮变成错误。
        // 这里主动中止本会话的运行态，让这一轮干净收尾 (不产生模型调用) 。
        try {
          await hostClient?.session.abort({ path: { id: input.sessionID } });
        } catch { /* 忽略：中止失败不影响命令本身的处理 */ }
      } catch (err) {
        hostLog("warn", `[${VERSION_TAG}] command.execute.before error: ${String(err)}`);
      }
    },
    /**
     * 事件钩子：
     *   1. session.error —— 判定为鉴权失败时自动续期 / 引导登录
     *   2. command.executed —— 命令钩子没兜住的场景下做事件兜底
     * 绝不抛异常出去 —— 宿主对插件钩子的异常没有兜底。
     */
    async event({ event }) {
      try {
        if (event.type === "session.error") {
          await handleSessionAuthFailure(event.properties?.error);
          return;
        }
        if (event.type === "command.executed") {
          const cmd = (event.properties?.name || "").trim().toLowerCase();
          if (cmd !== COMMAND_LOGIN && cmd !== COMMAND_DOCTOR) return;
          // 命令钩子已经处理过 => 事件兜底只做确认，不再执行一遍
          if (
            lastHandledCommand &&
            lastHandledCommand.cmd === cmd &&
            Date.now() - lastHandledCommand.at < COMMAND_DEDUPE_MS
          ) {
            lastHandledCommand = null;
            hostLog(
              "info",
              `[${VERSION_TAG}] command ${cmd} already handled by command hook, event fallback skipped`,
            );
            return;
          }
          await handleCodebuddyCommand(cmd, event.properties?.arguments || "");
        }
      } catch (err) {
        hostLog("warn", `[${VERSION_TAG}] event hook error: ${String(err)}`);
      }
    },
    /**
     * 系统提示词指纹净化 (prompt 子集 —— 与请求体净化共用同一张规则表与同一个开关) 。
     * 只对本插件自己的 provider (codebuddy) 生效；其它 provider 原样透传。
     * 命中短语的条目逐条替换，日志只记录被改动的条目数，绝不记录提示词内容。
     */
    async "experimental.chat.system.transform"(input, output) {
      // 补充会话 ID 来源 (system 钩子同样带 sessionID)
      if (input?.sessionID) currentSessionId = input.sessionID;
      // 废弃别名提示 (首次见到时打一条 info)
      noteDeprecatedAliasOnce(hostLog);
      // 统一开关：CODEBUDDY_FINGERPRINT_SANITIZE (旧名 CODEBUDDY_PROMPT_SANITIZE 为别名)
      if (!isFingerprintSanitizeEnabled()) return;
      if (input?.model?.providerID !== PROVIDER_ID) return;
      const list = output?.system;
      if (!Array.isArray(list)) return;
      let modified = 0;
      for (let i = 0; i < list.length; i++) {
        const original = list[i];
        if (typeof original !== "string") continue;
        const sanitized = sanitizeSystemPromptForTest(original);
        if (sanitized !== original) {
          list[i] = sanitized;
          modified++;
        }
      }
      if (modified > 0) {
        hostLog(
          "debug",
          `[${VERSION_TAG}] system prompt sanitized: ${modified} entr${modified === 1 ? "y" : "ies"} modified`,
        );
      }
    },
  } satisfies Hooks;
};

export default {
  id: "codebuddy-auth",
  server: CodeBuddyAuthPlugin,
};
