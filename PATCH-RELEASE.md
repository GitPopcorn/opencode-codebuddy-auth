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
| `3.4.0` | 2026-09-09 | **当前** | 日志收敛：heartbeat 逐条日志降为仅首次一条 info，其余注释留痕；确认 OpenCode 日志级别无 TRACE |

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

---

## 关键设计结论（踩坑汇总）

1. **ReadableStream 内禁止"攒数据等时间再 flush"** —— pull 只在消费者请求时调用，攒着不 flush = 死锁
2. **空行是流心跳，不能删** —— 保证每批至少 enqueue 一个空行，pull 才会持续被调用
3. **flush 必须由 setTimeout 主动驱动**（controller.enqueue 可在 pull 外调用），不能依赖 pull 内时间判断
4. **SSE 事件之间必须空行分隔**（`\n\n`），两条 `data:` 无空行会被解析器拼成一行导致 JSON 失败
5. **CodeBuddy CN 网关非标准字段**：`finish_reason: ""`（应 null）、null/empty 字段（`function_call`/`refusal`/`tool_calls`/`extra_fields`）——需规范化
6. **调试版本文档留痕**：`src/index.ts.bak` ~ `.bak7` 保留完整演进，`package.json.bak` / `tsconfig.json.bak` 保留配置演进

## 排障速查

| 现象 | 定位 |
|---|---|
| 无限进度条、零输出 | 确认日志出现 `SSE stream detected`；若无 `stream ended` → 死锁（检查是否动了空行/缓冲逻辑） |
| thinking 切碎成几十个 3ms 块 | 确认加载的是 v3.x（`starting` 日志带版本号）；v1 透传版会有此问题 |
| JSON parsing failed（两个 JSON 拼接） | v3.2.0 前版本的分隔符 bug；升级到 v3.2+ |
| 版本不确定 | 看 `starting` 日志版本号，与 `index.js` 中 `FORK_VERSION` 对比 |
