import type { Plugin } from "@opencode-ai/plugin";
/**
 * 供外部脚本验证请求头构造（不打印令牌内容）。
 * 与插件内部走同一套 buildAuthHeaders 逻辑，保证验证的就是线上行为。
 */
export declare function buildAuthHeadersForTest(accessToken: string, modelId: string, deviceToken: string, sessionId: string): Record<string, string>;
/**
 * 对单条系统提示词做指纹净化。
 * 纯函数：不读环境变量、不打日志 —— 命中短语逐条替换，其余文本逐字节保留。
 * 供钩子与外部验证脚本共用（钩子侧另行判断 provider 与开关）。
 */
export declare function sanitizeSystemPromptForTest(text: string): string;
/**
 * 对单段文本做指纹净化（R1 ~ R8 按顺序应用，后面的规则看到前面的输出）。
 * 纯函数：不读环境变量、不打日志、不碰网络。
 */
export declare function sanitizeFingerprintTextForTest(text: string): {
    text: string;
    spans: number;
};
/**
 * 请求体级指纹净化入口（纯函数，不依赖网络与环境变量）。
 * 对 chat/completions 请求体就地应用 A1 + A2，返回改写后的 body 与计数。
 */
export declare function sanitizePayloadForTest(body: unknown): {
    body: unknown;
    messagesScanned: number;
    messagesRewritten: number;
    spansRewritten: number;
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
