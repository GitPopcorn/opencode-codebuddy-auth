# PATCH-RELEASE.md — opencode-codebuddy-auth 本地补丁发布历史

> 本仓库 fork 自上游 `kuops/opencode-codebuddy-auth`（基线 `v1.0.3`）。
> 本文档记录**本地补丁自己的版本演进**，每个版本 = 一次可验证的功能/修复状态。
>
> 补丁目标：修复 CodeBuddy CN 网关非标准 SSE 导致的 thinking 切碎、卡死、JSON 解析错误，
> 并让 OpenCode TUI 中 GLM-5.3-Flash 的 thinking 以合理节奏流式输出。
>
> 仓库位置：`~/.config/opencode/opencode-codebuddy-auth/`
> 加载方式：`opencode.jsonc` 中 `plugin` 引用 `index.js`（tsc 编译产物，输出到仓库根目录）

---

## 版本列表

| 版本 | 日期 | 状态 | 摘要 |
|---|---|---|---|
| `1.0.3` (上游基线) | 2026-06-05 | 可用 | 上游 npm 版本，透传 SSE，存在 thinking 切碎问题 |
| `1.0.3-fork.1` | 2026-09-09 | 实验 | 字段规范化 + reasoning 合并（thinking 完整不切碎，但一次性冒出、thinking 期零输出） |
| `2.1.0-throttle-bd` | 2026-09-09 | 废弃 | 引入 B+D 混合 throttle（pendingEmit + 时间/大小阈值），**产生死锁**：pendingEmit 为空时永不 flush，无限进度条 |
| `3.1.0` | 2026-09-09 | 废弃 | 去除 pendingEmit 缓冲，改为"每次 pull 同步 enqueue + reasoning 按字符分批"；首次固定版本号机制 |
| `3.2.0` | 2026-09-09 | 可用 | 修复 SSE 事件分隔符（输出行 `\n` → `\n\n`），修复两个 JSON 被拼一起的解析失败 |
| `3.2.1` | 2026-09-09 | 回退 | 空行跳过实验 —— 发现空行是 ReadableStream 心跳，删除即死锁，已回退（教训见下方） |
| `3.3.0` | 2026-09-09 | 可用 | 新增 reasoning 定时心跳 flush（2s 周期），防"无限卡死"兜底 |
| `3.3.1` | 2026-09-09 | 可用 | `setInterval` → `setTimeout` 链式续期 + `alive` 标志（防定时器永活）；while 循环加行数防御上限 |
| `3.4.0` | 2026-09-09 | 可用 | 日志收敛：heartbeat 逐条日志降为仅首次一条 info，其余注释留痕；确认 OpenCode 日志级别无 TRACE |
| `3.5.1` | 2026-09-10 ~ 09-16 | 已回退 | 曾短期发布（可从日志 `codebuddy-fork-v3.5.1 starting` 回溯），随后回退到 `3.4.0` 基线继续演进 |
| `3.6.0` | 2026-11-18 | 可用 | 鉴权修复：刷新请求补 `X-Refresh-Token` 头、config 钩子到期前主动刷新、强制流式、模型发现补日志、版本指纹对齐 `4.12.39997873` |
| `3.7.0` | 2026-11-18 | 可用 | 新增 `X-Device-Token`：动态发现本机 TuringShield 原生插件并自签令牌（60s 缓存，失败即跳过） |
| `3.8.0` | 2026-11-18 | 可用 | 请求头对齐官方 IDE 构造规则（补 `X-Trace-ID`、`X-Request-ID` 与 `X-Conversation-Request-ID` 同值、会话级稳定 `X-Conversation-ID`），新增 system prompt 指纹净化钩子 |
| `3.9.0` | 2026-11-18 | 可用 | 凭据自愈层：启动期自检、`session.error` 捕获 401 自动续期、失效自动拉起浏览器重登、toast 提示、`/codebuddy-login` 与 `/codebuddy-doctor` 命令、账号 sidecar |
| `4.0.0` | 2026-11-18 | **当前** | 渠道指纹修复：出站请求体按跨度改写净化（覆盖 assistant 历史与 `reasoning_content`），品牌换 `CodeBuddyIDE/4.12.0`，补 `X-CodeBuddy-Request` 等官方头，设备令牌改环境变量开启 |

---

## 各版本详细说明

### 1.0.3-fork.1 — 首次补丁（字段规范化 + reasoning 合并）

- `finish_reason: ""` → `null`（CodeBuddy CN 网关非标准行为，OpenCode 会把它误判为"响应终止"）
- 剥离 null/empty 非标准字段（`function_call` / `refusal` / `tool_calls` / `extra_fields`）
- reasoning-only delta 丢弃累积，遇到 content/tool_calls/stop 时把完整 thinking 注入单个 chunk

**已知问题**：thinking 一次性冒出（不流式）；thinking 很长期间对 OpenCode 零输出。

### 2.1.0-throttle-bd — 死锁版本（勿用，教训来源）

尝试用 `pendingEmit` 缓冲 + `shouldFlush()`（80ms / 200 字符）节流输出频率。

**死锁机制**：ReadableStream 的 `pull()` 只在消费者请求数据且内部队列空时被调用。
数据攒进 `pendingEmit` 但没 enqueue 时队列为空 → 消费者 `read()` 永远 pending →
`pull()` 不再被调用 → 攒着的数据永远发不出去 → OpenCode 端 SSE 长时间无数据 → 无限进度条。

**教训**：ReadableStream 内**任何"攒数据等时间"的缓冲逻辑都会死锁**。flush 必须由
`setTimeout` 主动 enqueue 驱动（v3.3.0 起），不能放在 `pull()` 内靠时间判断。

### 3.1.0 — 无死锁重构

- 删除 `pendingEmit` / `shouldFlush` / `flushPending`
- 每次 `pull()` 读到的数据在本次调用内全部同步处理并 enqueue，绝不留给下次
- reasoning 合并只按「字符数阈值」分批（`REASONING_BATCH_CHARS = 400`），不按时间
- 保留空行透传（空行是流心跳，见 3.2.1 教训）
- 版本号改为固定常量（不再运行时 `new Date()`，避免日志无法区分新旧产物）

### 3.2.0 — SSE 事件分隔符修复

- 所有输出行统一 `data: {...}\n\n`（此前 `\n`）
- **修复**：插入的 reasoning flush chunk 与后续 content chunk 之间缺少空行分隔，
  SSE 解析器把两条 `data:` 当同一事件的多行，值拼接成 `{json1}\n{json2}` → JSON parse 失败

### 3.2.1 — 空行跳过实验（已回退）

尝试跳过原始 SSE 空行（认为 data 行自带 `\n\n` 已足够），结果 thinking 期零输出卡死。

**教训（重要）**：空行透传是 ReadableStream 的"心跳"——reasoning-only 期间
`processSseDataLine` 返回空数组（不到阈值不输出），若同时没有空行 enqueue，
队列空 → `pull()` 不再被调用 → 死锁。**空行不能删**。ratio=2.0 只是计数失真（空行也算进 out），不影响功能。

### 3.3.0 — reasoning 定时心跳 flush

- 新增 `REASONING_HEARTBEAT_MS = 2000` 心跳：每 2s 强制把累积 reasoning flush 成 chunk
- `controller.enqueue()` 可在 `pull()` 之外调用（setInterval 回调驱动），不依赖 pull
- 兜底效果：thinking 再慢也每 ~2s 有一小段输出，TUI 永不误判卡死

### 3.3.1 — 定时器健壮化

- `setInterval` → 递归 `setTimeout` + `heartbeatActive` 标志链式续期
- 结构性杜绝"定时器永不销毁"：任何清理路径执行 `stopHeartbeat()` 后，回调不再续期
- while 循环加 `linesProcessed > 100000` 防御上限（理论上 indexOf 必终止，此为极端输入最后保险）
- 修复双 v 版本号 bug（`FORK_VERSION` 不带 `v` 前缀，避免拼出 `vv3.x`）

### 3.4.0 — 日志收敛（当前）

- heartbeat flush 从"每 2s 一条 info"降为"仅首次一条 info"（原逐条日志注释留痕，需要时可取消注释）
- 实测：单次长对话 fork 日志从 ~80 条降至 ~5-6 条；全量日志占比约 0.43% → ~0.1%
- 确认 OpenCode `client.app.log()` 级别枚举仅 `debug / info / warn / error`（无 TRACE，zod 校验）

### 3.5.1 — 短期发布后回退（历史）

- 2026-09-10 至 09-16 期间产物版本号为 `3.5.1`（可从日志 `codebuddy-fork-v3.5.1 starting` 回溯），09-16 之后回退到 `3.4.0` 基线继续演进
- 回退原因未在仓内留档，排查历史问题时以日志中的版本号横幅为准

### 3.6.0 — 鉴权修复（插件整体不可用的根因）

- **根因**：access token 到期（60 天）后 `config` 钩子从不检查 `expires`、从不刷新，且刷新实现漏了 `X-Refresh-Token` 头，服务端固定返回 `10001: refreshToken is empty` —— 刷新从上线起就不可能成功
- `refreshAccessToken(accessToken, refreshToken)` 改为真实客户端形态：头 `Authorization` / `X-Refresh-Token` / `X-Auth-Refresh-Source: plugin` / `X-Product` / `X-Domain` / `X-User-Id`，body `{}`
- `config` 钩子新增到期前 120s 主动刷新并经 `client.auth.set` 落盘，失败则退回原令牌
- 强制 `stream: true`（服务端对非流式固定返回 `11101`）
- 模型发现补日志：成功带数量、失败带状态码与 `code`/`msg`、0 模型显式告警（此前全静默，导致这次故障不可诊断）
- 版本指纹对齐真实客户端 `X-Product-Version: 4.12.39997873`（旧值 `4.9.29177644` 在任何真实客户端产物中都不存在）

### 3.7.0 — 设备令牌自签

- 真实客户端的 `X-Device-Token` 由腾讯 TuringShield 原生插件（N-API）产出，官方无公开协议，纯 HTTP 不可复刻
- 实现：动态发现本机已安装客户端里的 `prebuilds/<plat>-<arch>/electron.napi.node` → `initialize({channelId})` → `syncFetchRiskDetect` → 60s 缓存，失败即不带头（fail-open）
- 只在个人账号场景出现（企业账号 `enterpriseId` 非空时官方整体跳过该头）
- 注意：官方 VS Code 扩展版并未打包该 SDK，发出去的是 `X-Device-Token-Error: sdk_not_initialized`，说明该头并非准入门槛

### 3.8.0 — 请求头对齐与 system prompt 净化

- 依据真实扩展的请求头构造代码，补 `X-Trace-ID`（此前完全缺失）、把 `X-Request-ID` 与 `X-Conversation-Request-ID` 改为同值、`X-Conversation-Message-ID` 与 `X-Request-Trace-Id` 改 UUID v4
- `X-Conversation-ID` 由每请求随机改为**会话级稳定**（上游按它做提示词缓存分桶）
- 新增 `experimental.chat.system.transform` 钩子，按跨度改写 system prompt 中的第三方身份指纹

### 3.9.0 — 凭据自愈层

- 启动期自检：无凭据或刷新失败 → 自动拉起浏览器重登（轮询 `plugin/auth/token`，`11217` 表示登录中），成功后经 `client.auth.set` 落盘
- 会话内自愈：`event` 钩子监听 `session.error`，命中 `ProviderAuthError` 或 401/403 → 自动刷新 → 提示重试（不自动重放用户消息，避免副作用重复）
- 账号切换检测：sidecar（`~/.local/share/opencode/codebuddy-account.json`）比对当前令牌绑定的 `uid`/`nickname`，不一致即提示
- 新增 `/codebuddy-login`、`/codebuddy-doctor` 两个命令；`client.tui.showToast` 给用户可见横幅
- 绕过两个宿主缺陷：`showToast` 在无 TUI 订阅时永久挂起（改为 fire-and-forget 加 2s 超时）；opencode 1.19.6 对任何命令都会强起一个 assistant turn（原地清空 `output.parts` 并中止会话）

### 4.0.0 — 渠道指纹修复（11128）

- **根因**：上游对请求体做**不分角色的大小写不敏感精确子串匹配**，扫描 `system` 与 `assistant` 正文及 `reasoning_content`；会话历史里任何一条含被禁指纹的 assistant 消息都会毒化该会话之后的所有请求
- 修复：出站请求体按**跨度改写**（不是整条替换 system，用户 AGENTS.md 指令完整保留），覆盖 `content`（字符串与数组 text part）、`reasoning_content`、`reasoning`、`tool_calls[].function.arguments`
- 净化规则取自 8 个独立仓库的实现并集：字面短语表、品牌改名、身份句通用正则、`11128` 裸数字、`cc_entrypoint=`、`model_identity` 标签、服务端注入的身份指令、XML 标记
- 首条消息角色保障：`developer` 就地改 `system`，否则前置一条中性 system
- 品牌换官方 IDE 形状 `CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0`，补 `X-CodeBuddy-Request: 1` 等 10 家一致的头，移除官方刻意不发的 `X-B3-ParentSpanId`
- 设备令牌改为**默认关闭**（`CODEBUDDY_DEVICE_TOKEN=on` 才发），与官方来源优先、取不到宁可不发的社区共识一致
- 验证方式：被污染的 assistant 历史消息，经净化后由 `400 / 11128` 变为 `200` 加 SSE

---

## 关键设计结论（踩坑汇总）

1. **ReadableStream 内禁止"攒数据等时间再 flush"** —— pull 只在消费者请求时调用，攒着不 flush = 死锁
2. **空行是流心跳，不能删** —— 保证每批至少 enqueue 一个空行，pull 才会持续被调用
3. **flush 必须由 setTimeout 主动驱动**（controller.enqueue 可在 pull 外调用），不能依赖 pull 内时间判断
4. **SSE 事件之间必须空行分隔**（`\n\n`），两条 `data:` 无空行会被解析器拼成一行导致 JSON 失败
5. **CodeBuddy CN 网关非标准字段**：`finish_reason: ""`（应 null）、null/empty 字段（`function_call`/`refusal`/`tool_calls`/`extra_fields`）——需规范化
6. **调试版本文档留痕**：`src/index.ts.bak` ~ `.bak7` 保留完整演进，`package.json.bak` / `tsconfig.json.bak` 保留配置演进
7. **刷新必须带 `X-Refresh-Token` 头** —— 只放 `Authorization: Bearer <refreshToken>` 会得到 `10001: refreshToken is empty`，刷新永远失败
8. **离线会话会被服务端注销** —— refresh token 未过期也可能返回 `12153` 与 `invalid_grant: Offline user session not found`，此时只能重新登录
9. **`/v3/config` 未鉴权时不报 401** —— 它返回 `code:0` 但 `models` 为 `null` 的空骨架，插件据此静默回退到 `auto`，表现为只剩一个模型
10. **上游对请求体做不分角色的精确子串匹配** —— `system` 与 `assistant` 正文及 `reasoning_content` 都会被扫，历史里一条含指纹的 assistant 消息会毒化整个会话
11. **非流式请求固定 `11101`** —— 必须 `stream: true`
12. **官方客户端品牌只有 `CodeBuddyIDE` 与 `CLI`** —— `VSCode` 不在白名单内
13. **Bun 模块缓存** —— `plugin/loader.ts` 用动态 `import()` 加载插件，同一路径命中进程内缓存，改插件必须**重启进程**，无免重启重载路径
14. **`client.tui.showToast` 在无 TUI 订阅时永久挂起** —— 必须 fire-and-forget 并带超时
15. **opencode 1.19.6 对命令总会强起一个 assistant turn** —— 需原地清空 `output.parts`（宿主复用同一数组引用）并中止会话
16. **`opencode run` 在无 stdin 重定向时会静默阻塞** —— 自动化验证须重定向 `NUL`

## 排障速查

| 现象 | 定位 |
|---|---|
| 无限进度条、零输出 | 确认日志出现 `SSE stream detected`；若无 `stream ended` → 死锁（检查是否动了空行/缓冲逻辑） |
| thinking 切碎成几十个 3ms 块 | 确认加载的是 v3.x（`starting` 日志带版本号）；v1 透传版会有此问题 |
| JSON parsing failed（两个 JSON 拼接） | v3.2.0 前版本的分隔符 bug；升级到 v3.2+ |
| 版本不确定 | 看 `starting` 日志版本号，与 `index.js` 中 `FORK_VERSION` 对比 |
| 模型列表只剩 `auto` | 看 `model discovery` 日志；0 模型通常是凭据失效（`/v3/config` 返回空骨架），先跑 `/codebuddy-doctor` |
| 对话 401 | 令牌过期；v3.6.0 起会主动刷新，仍失败则刷新会话已被注销，需 `/codebuddy-login` |
| 刷新报 `10001 refreshToken is empty` | 刷新请求缺 `X-Refresh-Token` 头；v3.6.0 起已修 |
| 刷新报 `12153` 或 `invalid_grant` | 离线会话已被服务端注销，只能重新登录 |
| 对话 400 且 `code:11128` | 请求体命中渠道指纹；v4.0.0 起已按跨度改写净化，若仍出现需检查历史消息里是否残留指纹 |
| 对话 400 且 `code:11101` | 非流式请求；插件已强制 `stream: true` |
| 改了插件但行为没变 | Bun 模块缓存，必须重启 OpenCode 进程 |
