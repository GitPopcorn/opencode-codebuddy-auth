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
const FORK_VERSION = "3.4.0";                    // 固定常量，改代码必须手动 bump
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

---

## 行为差异对照（vs 上游）

| 场景 | 上游 1.0.3 | 本地补丁 v3.4.0 |
|---|---|---|
| CodeBuddy `finish_reason: ""` | 透传，OpenCode 误判为终止 | 规范化成 `null` |
| thinking 输出 | 每个 reasoning delta 原样透传（TUI 切碎成 3ms 小块） | 按 400 字符分批合并，OpenCode 拼成完整思考段 |
| 慢思考（长 thinking） | 期间对 OpenCode 零输出 | 2s 心跳兜底，每 ~2s 一段输出 |
| SSE 事件分隔 | 原样透传（正常） | 统一 `\n\n`，修复插入 chunk 时的拼接 bug |
| 空行 | 透传 | 透传（**心跳，不可删**） |
| 日志 | 无 | 分级日志 + 版本号前缀 |

## 已知限制 / 注意

- **ratio=2.0 是计数失真**：buffer 按 `\n` 切分时空行也被计入 in/out，实际 data 行
  输出接近 1:1（reasoning 合并后 <1）。不影响功能，勿当 bug 修（修了会踩空行心跳的坑）
- OpenCode `client.app.log()` 无 TRACE 级别，最细只到 `debug`
- fork 的 `index.js` 是编译产物，**不要手改**；改 `src/index.ts` 后跑 `npm run build`