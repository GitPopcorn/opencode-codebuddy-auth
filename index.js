import * as fs from "fs";
import * as path from "path";
import * as os from "os";
const PROVIDER_ID = "codebuddy";
const CONFIG = {
    serverUrl: "https://copilot.tencent.com",
    chatCompletionsPath: "/v2/chat/completions",
    platform: "VSCode",
    appVersion: "4.9.29177644",
    ideName: "VSCode",
    ideType: "VSCode",
    ideVersion: "1.119.0",
    domain: "www.codebuddy.cn",
    product: "SaaS",
    agentIntent: "craft",
    envId: "production",
    tenantId: process.env.CODEBUDDY_TENANT_ID || "",
    enterpriseId: process.env.CODEBUDDY_ENTERPRISE_ID || "",
    userId: process.env.CODEBUDDY_USER_ID || "",
    defaultModel: process.env.CODEBUDDY_DEFAULT_MODEL || "",
};
const DEFAULT_MODEL = { id: "auto", name: "Auto", maxInputTokens: 168000, maxOutputTokens: 32000, supportsToolCall: true };
const DISCOVERY_TIMEOUT_MS = 5000;
let resolvedServerUrl = CONFIG.serverUrl;
let resolvedDomain = CONFIG.domain;
function remoteModelToConfig(m) {
    const entry = { name: m.name };
    if (m.maxInputTokens || m.maxOutputTokens) {
        entry.limit = { context: m.maxInputTokens ?? 0, output: m.maxOutputTokens ?? 0 };
    }
    if (m.supportsToolCall)
        entry.tool_call = true;
    if (m.supportsImages)
        entry.attachment = true;
    return entry;
}
async function fetchRemoteModels(accessToken) {
    const headers = {
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
    if (!resp.ok)
        return [];
    const body = (await resp.json());
    if (body.code !== 0 || !body.data)
        return [];
    const allModels = body.data.models || [];
    const modelMap = new Map(allModels.map((m) => [m.id, m]));
    const craftAgent = (body.data.agents || []).find((a) => a.name === CONFIG.agentIntent);
    const craftIds = craftAgent?.models || [];
    if (craftIds.length === 0)
        return [DEFAULT_MODEL];
    return craftIds.map((id) => modelMap.get(id)).filter((m) => !!m?.supportsToolCall);
}
function generateUuid() {
    if (globalThis.crypto?.randomUUID)
        return globalThis.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function decodeJwtPayload(token) {
    try {
        const parts = token.split(".");
        if (parts.length < 2)
            return null;
        const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = "=".repeat((4 - (payload.length % 4)) % 4);
        return JSON.parse(Buffer.from(payload + pad, "base64").toString("utf8"));
    }
    catch {
        return null;
    }
}
function resolveTenantId(accessToken) {
    if (CONFIG.tenantId)
        return CONFIG.tenantId;
    const p = decodeJwtPayload(accessToken);
    if (!p)
        return "";
    const iss = p.iss || "";
    const m = iss.match(/realms\/sso-([^/]+)$/);
    return p.tenant_id || p.tenantId || (m?.[1] || "");
}
function resolveEnterpriseId(accessToken) {
    if (CONFIG.enterpriseId)
        return CONFIG.enterpriseId;
    const p = decodeJwtPayload(accessToken);
    if (!p)
        return "";
    const roles = p.realm_access?.roles || p.resource_access?.account?.roles;
    if (roles) {
        for (const r of roles) {
            const m = r.match(/group-admin:([A-Za-z0-9-]+)/);
            if (m?.[1])
                return m[1];
        }
    }
    return p.enterprise_id || p.enterpriseId || p.ent_id || p.entId || "";
}
function resolveUserId(accessToken) {
    if (CONFIG.userId)
        return CONFIG.userId;
    const p = decodeJwtPayload(accessToken);
    return p?.user_id || p?.userId || p?.uid || p?.sub || "";
}
function resolveModel(inputModel) {
    if (CONFIG.defaultModel)
        return CONFIG.defaultModel;
    return inputModel || "";
}
function generateTraceId() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function buildAuthHeaders(accessToken, modelId) {
    const tenantId = resolveTenantId(accessToken);
    const enterpriseId = resolveEnterpriseId(accessToken);
    const userId = resolveUserId(accessToken);
    const conversationId = generateTraceId();
    const messageId = generateTraceId();
    const traceId = generateTraceId();
    const spanId = generateTraceId().slice(0, 16);
    const parentSpanId = generateTraceId().slice(0, 16);
    const headers = {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Authorization: `Bearer ${accessToken}`,
        "X-Request-ID": messageId,
        "X-Conversation-ID": conversationId,
        "X-Conversation-Request-ID": messageId,
        "X-Conversation-Message-ID": messageId,
        "X-Agent-Intent": CONFIG.agentIntent,
        "X-IDE-Type": CONFIG.ideType,
        "X-IDE-Name": CONFIG.ideName,
        "X-IDE-Version": CONFIG.ideVersion,
        "X-Product-Version": CONFIG.appVersion,
        "X-Request-Trace-Id": traceId,
        "X-Env-ID": CONFIG.envId,
        "X-Domain": resolvedDomain,
        "X-Product": CONFIG.product,
        "User-Agent": `${CONFIG.ideName}/${CONFIG.ideVersion} CodeBuddy/${CONFIG.appVersion}`,
        b3: `${traceId}-${spanId}-1-${parentSpanId}`,
        "X-B3-TraceId": traceId,
        "X-B3-ParentSpanId": parentSpanId,
        "X-B3-SpanId": spanId,
        "X-B3-Sampled": "1",
    };
    if (tenantId)
        headers["X-Tenant-Id"] = tenantId;
    if (enterpriseId)
        headers["X-Enterprise-Id"] = enterpriseId;
    if (userId)
        headers["X-User-Id"] = userId;
    if (modelId)
        headers["X-Model-ID"] = modelId;
    return headers;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// reasoning 分批阈值：每累积约 400 字符就 flush 一个 reasoning delta chunk。
// 太大 → 下游长时间无数据（可能被误判超时）；太小 → flush 太碎。
// 400 字符约等于正常模型 1-3 秒的思考输出，平衡流式感与开销。
const REASONING_BATCH_CHARS = 400;
// 版本标识 — 每次 tsc build 时计算新的时间戳
// ============================================================================
// 版本标识（固定常量，不再用运行时 Date —— 之前运行时生成导致无法区分
// "磁盘产物是不是最新编译"，每次启动都不同，日志误导判断）
// 铁律：每次修改代码逻辑后，必须手动 bump 下面这个版本号！
//   v3.1 = 首次固定版本号机制
//   v3.2 = 修复 SSE 事件分隔符 bug（\n → \n\n，之前导致两个 JSON 拼接解析失败）
//   v3.2.1 = 空行跳过（原始 SSE 空行分隔由每行自带 \n\n 承担，避免双空行 + ratio 虚高）
const FORK_VERSION = "3.4.0";
const VERSION_TAG = `codebuddy-fork-v${FORK_VERSION}`;
function buildReasoningChunk(reasoningText) {
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
// 处理单个 SSE data: 行。返回要 enqueue 的 SSE 行数组（可空）。
// 副作用：可能向 state.reasoningBuffer 累积 reasoning_content。
function processSseDataLine(line, state) {
    // 只处理 data: {...} 行；其他 SSE 行（event:/id:/retry:/空行/注释）原样返回
    if (!line.startsWith("data:"))
        return [line];
    const payload = line.slice(5).replace(/^\s/, ""); // 去前导空格
    if (payload === "" || payload === "[DONE]")
        return [line];
    let obj;
    try {
        obj = JSON.parse(payload);
    }
    catch {
        return [line];
    }
    state.totalChunksIn++;
    // 字段规范化
    // 1. finish_reason: "" -> null （CodeBuddy 网关非标准行为，OpenCode 会把 "" 误判为终止）
    // 2. 剥离 null/empty 非标准字段
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    for (const choice of choices) {
        if (choice.finish_reason === "")
            choice.finish_reason = null;
    }
    for (const key of ["function_call", "refusal", "extra_fields"]) {
        const v = obj[key];
        if (v === null || v === "")
            delete obj[key];
    }
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length === 0) {
        delete obj.tool_calls;
    }
    if (choices.length === 0)
        return ["data: " + JSON.stringify(obj)];
    const firstChoice = choices[0];
    const delta = (firstChoice.delta || {});
    const finishReason = firstChoice.finish_reason;
    // 1. 把 reasoning_content 抽到 buffer，从原 delta 移除
    const reasoningChunk = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (reasoningChunk.length > 0) {
        state.reasoningBuffer += reasoningChunk;
        delete delta.reasoning_content;
    }
    const hasContent = typeof delta.content === "string" && delta.content.length > 0;
    const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
    const isTerminal = finishReason === "stop" || finishReason === "length";
    const out = [];
    // 2. 触发点：content / tool_calls / stop / length 出现
    //    → 先 flush 残余 reasoning（独立 chunk），再发当前 chunk
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
    //    - 否则不返回（等累积）
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
// 让 TUI 每 ~2 秒能看到思考在推进（几词一刷）。纯兜底，不影响正常分批逻辑。
const REASONING_HEARTBEAT_MS = 2000;
const noopLog = () => { };
async function normalizeCodeBuddySSE(response, log = noopLog) {
    // 非 SSE 响应（如非流式 chat completion）直接透传
    // NOTE: 保持 info 级别 —— 请求级事件频率低（每请求1条），且是判断
    // "fork 是否生效 / 响应是否 SSE" 的核心排障信号。debug 在默认运行时
    // 不可见，降级会导致日常排查丢失此信号。
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
        log("info", `[${VERSION_TAG}] non-SSE response, content-type: ${ct}`);
        return response;
    }
    log("info", `[${VERSION_TAG}] SSE stream detected, normalizing + batching reasoning`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let streamController;
    const state = {
        reasoningBuffer: "",
        totalChunksIn: 0,
        totalChunksOut: 0,
        reasoningFlushed: false,
        totalRawBytes: 0,
        streamStartMs: Date.now(),
        heartbeatLogged: false,
    };
    // ==========================================================================
    // 心跳机制（setTimeout 链式续期，非 setInterval）
    // 防 setInterval 永不销毁的泄漏：每轮回调先检查 alive 标志，
    // 只有 stream 仍活跃才续期。即使某个清理路径漏执行，一旦 alive=false
    // 就不再调度下一轮 —— 结构性杜绝"定时器永活"。
    // ==========================================================================
    let heartbeatActive = true;
    let heartbeatTimer;
    const stopHeartbeat = () => {
        heartbeatActive = false;
        if (heartbeatTimer !== undefined) {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    };
    // 每 HEARTBEAT ms 强制 flush 累积的 reasoning（即使 pull 未被调用也能 enqueue）
    // 这是防"无限卡死"的关键兜底：reasoning-only 期间迟迟不达 400 字符阈值时，
    // 保证每 ~2s 至少输出一次 thinking，TUI 能看到推进，不会误判死锁。
    const scheduleHeartbeat = () => {
        if (!heartbeatActive)
            return;
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
                    // 若要诊断 heartbeat 是否规律触发，可临时取消注释下一行（逐条日志）。
                    // log("info", `[${VERSION_TAG}] heartbeat flush ${line.length}B reasoning`);
                    if (!state.heartbeatLogged) {
                        state.heartbeatLogged = true;
                        log("info", `[${VERSION_TAG}] heartbeat active (periodic reasoning flush enabled, first flush ${line.length}B)`);
                    }
                }
            }
            catch { /* stream closed — ignore */ }
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
                        for (const o of out)
                            controller.enqueue(encoder.encode(o + "\n\n"));
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
                // reasoning-only 期间 processSseDataLine 返回空数组（不到阈值不输出），
                // 若此时也没有空行 enqueue，队列空 → 消费者 read() pending → pull 不再被调用 → 死锁。
                // 空行让消费者持续收到数据、pull 持续被调用。ratio=2.0 只是计数失真，不影响功能。
                let nl;
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
            }
            catch (err) {
                stopHeartbeat();
                log("warn", `[${VERSION_TAG}] stream error: ${String(err)}`);
                try {
                    if (state.reasoningBuffer.length > 0) {
                        controller.enqueue(encoder.encode(buildReasoningChunk(state.reasoningBuffer) + "\n\n"));
                        state.reasoningBuffer = "";
                    }
                }
                catch { /* swallow */ }
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
async function requestAuthState() {
    const params = new URLSearchParams({ platform: CONFIG.platform, ioa: "1" });
    const response = await fetch(`${resolvedServerUrl}/v2/plugin/auth/state?${params.toString()}`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-No-Authorization": "true",
            "X-No-User-Id": "true",
            "X-No-Enterprise-Id": "true",
            "X-No-Department-Info": "true",
        },
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Auth state request failed: ${response.status} - ${text}`);
    }
    const data = (await response.json());
    if (data.code !== 0 || !data.data?.state) {
        throw new Error(`Invalid auth state response: ${JSON.stringify(data)}`);
    }
    const loginUrl = data.data.authUrl ||
        `${resolvedServerUrl}/login?platform=${CONFIG.platform}&state=${data.data.state}&ioa=1`;
    return { state: data.data.state, url: loginUrl };
}
async function pollForToken(state, expiresAt, signal) {
    while (Date.now() < expiresAt) {
        if (signal?.aborted)
            return null;
        await sleep(3000);
        try {
            const response = await fetch(`${resolvedServerUrl}/v2/plugin/auth/token?state=${state}`, {
                method: "GET",
                headers: {
                    Accept: "application/json",
                    "X-No-Authorization": "true",
                    "X-No-User-Id": "true",
                    "X-No-Enterprise-Id": "true",
                    "X-No-Department-Info": "true",
                },
                signal,
            });
            if (response.ok) {
                const data = (await response.json());
                if (data.code === 0 && data.data?.accessToken)
                    return data.data;
            }
        }
        catch {
            if (signal?.aborted)
                return null;
        }
    }
    return null;
}
async function refreshAccessToken(refreshToken) {
    try {
        const response = await fetch(`${resolvedServerUrl}/v2/plugin/auth/token/refresh`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${refreshToken}`,
            },
        });
        if (!response.ok)
            return null;
        const data = (await response.json());
        if (data.code !== 0)
            return null;
        return data.data || null;
    }
    catch {
        return null;
    }
}
export const CodeBuddyAuthPlugin = async (input) => {
    return {
        async config(config) {
            // 版本标识：每次启动打印一次，后续 stream ended 日志也带这个 tag
            try {
                input.client.app.log({
                    body: {
                        service: "codebuddy-fork",
                        level: "info",
                        message: `${VERSION_TAG} starting (schema=opencode-codebuddy-auth, build=${FORK_VERSION})`,
                    },
                });
            }
            catch { /* ignore */ }
            if (!config.provider)
                config.provider = {};
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
            const provider = config.provider[PROVIDER_ID];
            if (!provider)
                return;
            const opts = (provider.options || {});
            const configuredBase = typeof opts.baseURL === "string" ? opts.baseURL : undefined;
            if (configuredBase) {
                try {
                    const u = new URL(configuredBase);
                    resolvedServerUrl = `${u.protocol}//${u.host}`;
                    if (resolvedServerUrl.includes("codebuddy.ai")) {
                        resolvedDomain = "www.codebuddy.ai";
                    }
                }
                catch { }
            }
            if (!provider.models) {
                provider.models = {};
            }
            const models = provider.models;
            let discovered = [];
            try {
                const home = os.homedir();
                const authPath = path.join(home, ".local", "share", "opencode", "auth.json");
                const raw = fs.readFileSync(authPath, "utf8");
                const all = JSON.parse(raw);
                const auth = all[PROVIDER_ID];
                if (auth?.type === "oauth" && auth.access) {
                    const work = fetchRemoteModels(auth.access);
                    discovered = await Promise.race([
                        work,
                        new Promise((resolve) => setTimeout(() => resolve([]), DISCOVERY_TIMEOUT_MS)),
                    ]);
                }
            }
            catch {
                // auth not available yet, use fallback
            }
            if (discovered.length === 0) {
                discovered = [DEFAULT_MODEL];
            }
            for (const m of discovered) {
                if (models[m.id])
                    continue;
                models[m.id] = remoteModelToConfig(m);
            }
        },
        auth: {
            provider: PROVIDER_ID,
            async loader(getAuth, _provider) {
                return {
                    apiKey: "cli-proxy",
                    baseURL: resolvedServerUrl,
                    async fetch(url, init) {
                        const urlStr = url.toString();
                        if (!urlStr.includes("/chat/completions")) {
                            return fetch(url, init);
                        }
                        const log = (level, message) => {
                            try {
                                input.client.app.log({
                                    body: { service: "codebuddy-fork", level, message },
                                });
                            }
                            catch { /* ignore log failure */ }
                        };
                        // NOTE: 保持 info —— 请求级事件频率低，且是确认请求确实到达 fork、
                        // 版本加载是否正确的最直接证据（本轮多次调试靠它定位版本问题）。
                        log("info", `[${VERSION_TAG}] fetch intercepted: ${urlStr.substring(0, 120)}`);
                        const currentAuth = await getAuth();
                        if (currentAuth.type !== "oauth" || !currentAuth.access) {
                            throw new Error("缺少 access token，请重新登录");
                        }
                        let accessToken = currentAuth.access;
                        const body = init?.body;
                        if (!body) {
                            return new Response(JSON.stringify({ error: "Missing request body" }), {
                                status: 400,
                                headers: { "Content-Type": "application/json" },
                            });
                        }
                        const openaiRequest = JSON.parse(typeof body === "string"
                            ? body
                            : await new Response(body).text());
                        const resolvedModel = resolveModel(openaiRequest.model);
                        if (!resolvedModel) {
                            throw new Error("未设置模型，请设置 CODEBUDDY_DEFAULT_MODEL 或在 OpenCode 选择模型");
                        }
                        const requestBody = {
                            ...openaiRequest,
                            model: resolvedModel,
                            stream: openaiRequest.stream ?? true,
                        };
                        if (openaiRequest.response_format) {
                            requestBody.response_format = openaiRequest.response_format;
                        }
                        const doRequest = async (token) => {
                            return fetch(`${resolvedServerUrl}${CONFIG.chatCompletionsPath}`, {
                                method: "POST",
                                headers: buildAuthHeaders(token, resolvedModel),
                                body: JSON.stringify(requestBody),
                            });
                        };
                        let response = await doRequest(accessToken);
                        if ((response.status === 401 || response.status === 403) &&
                            currentAuth.refresh) {
                            log("info", "[codebuddy] Token expired, attempting refresh...");
                            const refreshed = await refreshAccessToken(currentAuth.refresh);
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
                            log("warn", `[codebuddy] API error: ${response.status} - ${errorText.substring(0, 200)}`);
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
                            method: "auto",
                            async callback() {
                                const tokenData = await pollForToken(authState.state, expiresAt);
                                if (!tokenData)
                                    return { type: "failed" };
                                return {
                                    type: "success",
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
            if (input.model.providerID !== PROVIDER_ID)
                return;
            output.options.baseURL = resolvedServerUrl;
        },
    };
};
export default {
    id: "codebuddy-auth",
    server: CodeBuddyAuthPlugin,
};
