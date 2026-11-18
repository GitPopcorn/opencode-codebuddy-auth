# PATCH-NOTES.md — 本地补丁变更总览

> 本文档从**代码 diff 视角**列出本地 fork 相对上游 `kuops/opencode-codebuddy-auth@1.0.3`
> 的所有变更点，供 review / 同步上游 / 回归排查使用。
> 版本演进与踩坑详见 `RELEASE.md`。

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/index.ts` | 修改 | 核心补丁所在，新增 SSE 处理层、心跳机制、版本标识 |
| `tsconfig.json` | 修改 | `outDir` `dist` → `.`（产物落根目录）；`exclude` 去掉 `dist` |
| `package.json` | 修改 | `main`/`types`/`exports["./server"]`/`files` 去掉 `/dist/` 前缀 |
| `.gitignore` | 修改 | `dist/` → `*.js.map` / `*.d.ts.map`（产物落根目录后的忽略项调整） |
| `index.js` / `index.d.ts` | 新增 | tsc 编译产物（`index.js` 是 OpenCode 实际加载的文件） |
| `src/index.ts.bak` ~ `.bak7` | 新增 | 调试演进备份（勿删，排查回归时对比用） |
| `RELEASE.md` | 新增 | 补丁版本发布历史 |
| `PATCH-NOTES.md` | 新增 | 本文档 |

---

## 代码级变更点（src/index.ts）

### 1. 版本标识（模块顶部）

```ts
const FORK_VERSION = "4.0.0";                    // 固定常量，改代码必须手动 bump
const VERSION_TAG = `codebuddy-fork-v${FORK_VERSION}`;  // 不带 v 前缀避免拼出 vv3.x
```

- 替换原无版本标识的代码
- 所有日志带 `[codebuddy-fork-vX.Y.Z]` 前缀，启动时 config hook 打一条 `starting` 确认版本

### 2. 常量新增

```ts
const REASONING_BATCH_CHARS = 400;   // reasoning 分批阈值（字符）
const REASONING_HEARTBEAT_MS = 2000; // 心跳 flush 周期（ms）
```

### 3. `processSseDataLine(line, state)` — 新增

上游没有此函数。单行 SSE data 处理，职责：

1. **字段规范化**：`finish_reason: ""` → `null`；剥离 `function_call` / `refusal` / `extra_fields`
   的 null/empty、空 `tool_calls` 数组
2. **reasoning 累积**：把 `delta.reasoning_content` 抽到 `state.reasoningBuffer`，从原 delta 移除
3. **分批 flush**：
   - 遇到 content / tool_calls / stop / length → 先 flush 残余 reasoning（独立 chunk），再发当前 chunk
   - 纯 reasoning-only delta → 累积，达 `REASONING_BATCH_CHARS` 才 flush
   - 返回 `string[]`（要 enqueue 的 SSE 行，可空）

### 4. `buildReasoningChunk(reasoningText)` — 新增

构造一个只带 `reasoning_content` 的 chat.completion.chunk（`finish_reason: null`），
用于把累积的 thinking 作为独立增量 delta 发出。OpenCode 上游 Lifecycle(id=`reasoning-0`)
会把多次 reasoning delta 拼接成一段完整思考。

### 5. `normalizeCodeBuddySSE(response, log)` — 新增（核心）

在 loader fetch 的 `return response` 前调用，对 CodeBuddy 流式响应做 SSE 规范化：

- 非 SSE 响应（content-type 不含 `text/event-stream`）直接透传
- 用 `ReadableStream` 包一层：`reader.read()` → 按 `\n` 切行 → `processSseDataLine` 处理 →
  `controller.enqueue(line + "\n\n")`
- **心跳机制**（`setTimeout` 链式 + `heartbeatActive` 标志）：
  每 2s 若 `reasoningBuffer` 有累积，强制 flush 成 reasoning chunk enqueue（不依赖 pull）
- `start(controller)` 缓存 controller 引用；`done`/`error`/`cancel` 三处 `stopHeartbeat()` 清理

### 6. loader fetch 改造

上游 `return response` 前插入 `return normalizeCodeBuddySSE(response, log)`。
`log` 是包装 `input.client.app.log` 的 `LogFn`（service=`codebuddy-fork`）。

### 7. 刷新链路修复 — `refreshAccessToken(accessToken, refreshToken)`

上游只发 `Authorization: Bearer <refreshToken>` 且无 body，服务端固定返回 `10001: refreshToken is empty` —— 自动刷新从未生效过。改为真实客户端形态：

```ts
headers: {
  Authorization: `Bearer ${accessToken}`,
  "X-Refresh-Token": refreshToken,
  "X-Auth-Refresh-Source": "plugin",
  "X-Product": CONFIG.product,
  "X-Domain": resolvedDomain,
  ...(userId ? { "X-User-Id": userId } : {}),
},
body: "{}",
```

### 8. config 钩子主动刷新与发现诊断

- 读取 auth.json 后检查 `expires`，到期前 120s 主动刷新，成功后经 `client.auth.set` 落盘，失败退回原令牌
- `fetchRemoteModels` 增 `log` 形参：非 2xx 报 HTTP 状态，`code !== 0` 报 `code` 与 `msg`，0 模型显式告警（此前全静默，故障不可诊断）
- 强制 `stream: true`（服务端对非流式固定 `11101`）

### 9. 设备令牌 provider（TuringShield）

- 动态发现本机客户端的 `prebuilds/<plat>-<arch>/electron.napi.node`，用 `createRequire` 兜底加载
- `initialize({ channelId, productName, productVersion })` 加 `syncFetchRiskDetect(true, false)`，60s 缓存、并发去重、5s 超时，失败即不带头
- v4.0.0 起默认关闭，需 `CODEBUDDY_DEVICE_TOKEN=on`

### 10. 请求头对齐官方 IDE 抓包

- 补 `X-Trace-ID`（此前完全缺失）、`X-CodeBuddy-Request: 1`、`X-Product-Code`、`X-Private-Data`、`X-Agent-Purpose`、`Accept-Language`、`Origin`、`Referer`
- `X-Request-ID` 与 `X-Conversation-Request-ID` 同值；`X-Conversation-Message-ID` 与 `X-Request-Trace-Id` 用 UUID v4
- `X-Conversation-ID` 由会话 id 派生（`sha256` 后置 UUID v4 版本位与 variant 位），同会话恒定
- 品牌换 `CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0`，`X-IDE-Version` 与 UA 首段同版本；移除官方刻意不发的 `X-B3-ParentSpanId`

### 11. 请求体指纹净化 — `sanitizePayloadForTest`

上游对请求体做不分角色的大小写不敏感精确子串匹配，扫描 `system`、`assistant` 正文与 `reasoning_content`。本项在 loader fetch 拦截里对出站 body 做**跨度改写**（不是整条替换 system，用户 AGENTS.md 指令完整保留）：

- 覆盖 `content`（字符串与数组 text part）、`reasoning_content`、`reasoning`、`tool_calls[].function.arguments`
- 规则集：字面短语表（R1）、品牌改名（R2）、身份句通用正则（R3）、`11128` 裸数字（R4）、`cc_entrypoint=`（R5）、`model_identity` 标签（R6）、服务端注入身份指令（R7）、XML 标记（R8）
- 首条消息角色保障：`developer` 就地改 `system`，否则前置一条中性 system
- 幂等：净化两次与净化一次结果一致，周边文本逐字节保留

### 11b. 指纹净化九项正确性修复（v4.0.1 —— 行为修复，非新功能）

1. **A1 与净化开关解耦**：`CODEBUDDY_FINGERPRINT_SANITIZE=off` 只停用**文本改写**；首条 `role:system` 由独立开关 `CODEBUDDY_FINGERPRINT_SYSTEM_FIRST=off` 控制
2. **深拷贝**：净化在副本上进行 —— 宿主传入的 `messages` 数组与消息对象绝不被就地改写（此前浅拷贝共享同一数组引用）
3. **作用范围可配**：`CODEBUDDY_FINGERPRINT_SCOPE=all|system-assistant`，默认 `system-assistant` —— 线上实测（2026-11-18）：上游**不**扫描 `user` / `tool` 角色（P1/P2 均 200，P3 assistant 为 400/11128），改写 tool 结果会与磁盘内容不符
4. **工具入参保持合法 JSON**：改写后 `JSON.parse` 校验，非法（含被删除型规则清空）则回滚该字段，只记一条计数 warn
5. **空内容处理**：`system` 内容被清空 -> 换中性默认提示词；`assistant` 内容被清空且无 `tool_calls` -> 整条丢弃
6. **日志防自污染**：上游错误体（`11128` 与 `Illegal API invocation from an unapproved channel`）绝不原样进日志 —— 宿主日志会被 agent 读回并重新触发同一错误；只记 HTTP 状态 + 固定分类标签（`channel-reject` / `auth` / `rate-limit` / `other`）+ 脱敏码（`11128` -> `CHANNEL_REJECT`）
7. **规则表合并**：原先分散的两张表（prompt 6 条 + body 29 条）合并为一张 `FINGERPRINT_RULES`，两个调用点各取子集；开关收敛为 `CODEBUDDY_FINGERPRINT_SANITIZE`，`CODEBUDDY_PROMPT_SANITIZE` 保留为**废弃别名**（首次见到打一条 info）
8. **识别 2xx + JSON 错误体**：上游偶尔用 HTTP 200 返回 JSON 错误 —— 此前逃过 `!response.ok` 分支从未被分类；现在按同一套分类记日志（body 仍原样转发）
9. **黄金回归测试**：新增 `scripts/verify-fingerprint.mjs`（零依赖，纯 node）—— 每条内置规则一条精确输出用例 + 幂等 + 空内容 + 工具入参 JSON + 作用域 + 开关 + 日志防自污染

### 12. 凭据自愈层

- `event` 钩子监听 `session.error`，命中 `ProviderAuthError` 或 401 与 403 → 自动刷新 → 提示重试（不自动重放用户消息）
- 启动期自检与失效自动重登：取 `plugin/auth/state` → 拉起浏览器 → 轮询 `plugin/auth/token`（`11217` 表示登录中）→ `client.auth.set` 落盘
- 账号 sidecar `~/.local/share/opencode/codebuddy-account.json` 记录 `uid` 与 `nickname`，用于账号切换检测
- `config.command` 注入 `/codebuddy-login` 与 `/codebuddy-doctor`；`command.execute.before` 原地清空 `output.parts` 并中止会话
- `client.tui.showToast` 给用户可见横幅（fire-and-forget 加 2s 超时，绕开无 TUI 订阅时永久挂起）

---

## 行为差异对照（vs 上游）

| 场景 | 上游 1.0.3 | 本地补丁 v4.0.0 |
|---|---|---|
| CodeBuddy `finish_reason: ""` | 透传，OpenCode 误判为终止 | 规范化成 `null` |
| thinking 输出 | 每个 reasoning delta 原样透传（TUI 切碎成 3ms 小块） | 按 400 字符分批合并，OpenCode 拼成完整思考段 |
| 慢思考（长 thinking） | 期间对 OpenCode 零输出 | 2s 心跳兜底，每 ~2s 一段输出 |
| SSE 事件分隔 | 原样透传（正常） | 统一 `\n\n`，修复插入 chunk 时的拼接 bug |
| 空行 | 透传 | 透传（**心跳，不可删**） |
| 令牌到期 | 无自动刷新 | 到期前 120s 主动刷新；刷新会话被注销时自动引导重登 |
| 刷新请求 | 只有 `Authorization`，服务端回 `10001` | 补 `X-Refresh-Token` 与 `X-Auth-Refresh-Source` |
| 模型列表 | 不做发现 | 调 `/v3/config` 发现并注入模型，失败显式告警 |
| 客户端身份 | `VSCode` 品牌加 `4.9.x` 版本 | `CodeBuddyIDE/4.12.0` 品牌加官方抓包同款头集 |
| 渠道指纹 | 请求体原样透传 | 出站 body 按跨度改写净化，规避 `11128` |
| 设备令牌 | 不发 | 可选自签（`CODEBUDDY_DEVICE_TOKEN=on`，默认关闭） |
| 日志 | 无 | 分级日志 + 版本号前缀 |

## 已知限制 / 注意

- **ratio=2.0 是计数失真**：buffer 按 `\n` 切分时空行也被计入 in/out，实际 data 行
  输出接近 1:1（reasoning 合并后 <1）。不影响功能，勿当 bug 修（修了会踩空行心跳的坑）
- OpenCode `client.app.log()` 无 TRACE 级别，最细只到 `debug`
- fork 的 `index.js` 是编译产物，**不要手改**；改 `src/index.ts` 后跑 `npm run build`
- 令牌有效期由服务端决定（实测 access 28 天、refresh 30 天），到期后插件自动刷新；若离线会话被注销则只能 `/codebuddy-login` 重新登录
- 渠道指纹规则表来自多个社区实现的并集，上游随时可能扩展；净化是尽力而为，仍被拦截时按 `PATCH-RELEASE.md` 的排障速查定位
- 设备令牌依赖本机已安装官方客户端的原生插件，路径随客户端升级变化（动态发现失效即自动跳过该头）
- `CODEBUDDY_FINGERPRINT_SANITIZE=off` 可关闭净化（仅用于排查净化副作用，默认开启）