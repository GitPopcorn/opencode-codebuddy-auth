import type { Plugin } from "@opencode-ai/plugin";
/**
 * 生成注入 `config.provider.codebuddy.models[].name` 的展示名。
 * - 幂等：已带 `[自配][CDBD] ` 前缀时先剥掉再重新加，绝不复利叠加
 * - 兜底：名称为空或只有分隔符时，依次回退到 fallbackId 与 `Model`，不抛错
 * - 只处理展示名，模型 id 由调用方单独保留，绝不经此处改写
 */
export declare function formatModelDisplayName(rawName: string, fallbackId?: string): string;
/**
 * `formatModelDisplayName` 的验证入口 —— 供离线断言脚本直接调用。
 */
export declare function formatModelDisplayNameForTest(rawName: string, fallbackId?: string): string;
/**
 * 供外部脚本验证请求头构造（不打印令牌内容）。
 * 与插件内部走同一套 buildAuthHeaders 逻辑，保证验证的就是线上行为。
 */
export declare function buildAuthHeadersForTest(accessToken: string, modelId: string, deviceToken: string, sessionId: string): Record<string, string>;
/** 净化作用范围：all = 全部 role；system-assistant = 只改 system + assistant */
export type FingerprintScope = "all" | "system-assistant";
/**
 * 对单条系统提示词做指纹净化（prompt 子集）。
 * 纯函数：不读环境变量、不打日志 —— 命中短语逐条替换，其余文本逐字节保留。
 * 供钩子与外部验证脚本共用（钩子侧另行判断 provider 与开关）。
 */
export declare function sanitizeSystemPromptForTest(text: string): string;
/**
 * 对单段文本做指纹净化（body 子集）。
 * 纯函数：不读环境变量、不打日志、不碰网络。
 */
export declare function sanitizeFingerprintTextForTest(text: string): {
    text: string;
    spans: number;
};
/**
 * 指纹净化总开关（唯一开关）：CODEBUDDY_FINGERPRINT_SANITIZE=off 停用**文本改写**。
 * 旧名 CODEBUDDY_PROMPT_SANITIZE 保留为废弃别名 —— 两个开关任一为停用值即整体停用。
 * 注意：本开关**只管文本改写**；A1（首条消息必须是 system）由独立开关控制。
 */
export declare function isFingerprintSanitizeEnabled(): boolean;
/**
 * A1（首条消息必须是 system）开关：CODEBUDDY_FINGERPRINT_SYSTEM_FIRST=off 停用。
 * 与净化开关相互独立 —— 协议形态修正与文本改写是两件事。
 */
export declare function isSystemFirstEnabled(): boolean;
/**
 * 净化作用范围：CODEBUDDY_FINGERPRINT_SCOPE=all | system-assistant。
 * 默认 system-assistant —— 线上实测（2026-11-18）：上游只扫描 system 与 assistant
 * 消息，user / tool 角色携带同样短语时上游返回 200（P1/P2 实测通过）。
 */
export declare function getFingerprintScope(): FingerprintScope;
/** 请求体净化的可调项 */
export interface FingerprintSanitizeOptions {
    /** 是否保证首条消息是 system（默认 true；由 CODEBUDDY_FINGERPRINT_SYSTEM_FIRST 控制） */
    systemFirst?: boolean;
    /** 是否改写文本（默认 true；由 CODEBUDDY_FINGERPRINT_SANITIZE 控制） */
    rewriteText?: boolean;
    /** 作用范围（默认取环境变量解析结果） */
    scope?: FingerprintScope;
}
/** 请求体净化结果（只含计数，绝不含内容） */
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
 * 请求体级指纹净化入口（纯函数，不依赖网络与环境变量）。
 * 深拷贝 messages 后再改写 —— **绝不修改调用方传入的对象**。
 * 返回改写后的**新** body，调用方必须使用返回值。
 */
export declare function sanitizePayloadForTest(body: unknown, options?: FingerprintSanitizeOptions): FingerprintSanitizeResult;
/** 上游错误分类标签（固定枚举） */
export type UpstreamErrorLabel = "channel-reject" | "auth" | "rate-limit" | "other";
/** 把上游原文里的自指片段替换成符号标签 */
export declare function redactSelfReferentialText(text: string): string;
/**
 * 上游错误分类 —— 只产出稳定标签与脱敏码，绝不回显上游原文。
 * 返回的 codeLabel 对自指错误码是符号标签（CHANNEL_REJECT），不是裸数字。
 */
export declare function classifyUpstreamError(status: number, body: unknown): {
    label: UpstreamErrorLabel;
    codeLabel: string;
};
/** 供外部脚本探测设备令牌可用性（只返回令牌本身，不打印内容） */
export declare function getDeviceTokenForTest(): Promise<string | null>;
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
/**
 * 判定一个会话错误是否属于鉴权失败。
 * 纯函数：只做判断，不碰网络与文件，便于离线验证。
 *   - ProviderAuthError：宿主已明确判定 provider 鉴权失败
 *   - APIError 且 statusCode 为 401 / 403：上游拒绝凭据
 */
export declare function isAuthFailureError(error: unknown): boolean;
/**
 * 供外部脚本做离线诊断（构建产物可被 bun / node 直接 require）。
 * 绝不返回任何令牌内容。
 */
export declare function diagnoseForTest(): Promise<DiagnosisReport>;
export declare const CodeBuddyAuthPlugin: Plugin;
declare const _default: {
    id: string;
    server: Plugin;
};
export default _default;
