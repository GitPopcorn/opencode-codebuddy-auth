# AGENTS.md

## 项目概述

OpenCode 插件，为 CodeBuddy 提供 IOA OAuth 认证和请求拦截。单文件项目，入口 `src/index.ts`。

> **本仓库是本地 fork**：基线 `kuops/opencode-codebuddy-auth` v1.0.3，叠加了针对
> CodeBuddy CN 网关非标准 SSE 的补丁（thinking 切碎/卡死/JSON 解析修复）。
> 版本历史见 `RELEASE.md`，补丁变更总览见 `PATCH-NOTES.md`。

## 构建

```bash
npm install && npm run build   # tsc 编译到仓库根目录（index.js + index.d.ts，非 dist/）
```

无测试、无 lint、无 CI。只有 `npm run build`。

**构建输出位置注意**：`tsconfig.json` 的 `outDir: "."`，`rootDir: "src"`，
编译产物直接落在仓库根目录（`index.js`），OpenCode 通过 `opencode.jsonc` 的
`plugin` 引用该文件。不要改回 `dist/`，否则 `opencode.jsonc` 引用路径要同步改。

## 版本规范（重要）

- `FORK_VERSION` 是**固定常量**（在 `src/index.ts` 顶部），不带 `v` 前缀，
  `VERSION_TAG = codebuddy-fork-v${FORK_VERSION}` 会拼出 `codebuddy-fork-vX.Y.Z`
- **每次修改代码逻辑后必须手动 bump `FORK_VERSION`**，否则无法确认 OpenCode 加载的
  是否最新产物（OpenCode 进程有模块缓存，重启后看 `starting` 日志的版本号来判断）
- 产物 `index.js` 必须与 `src/index.ts` 同步（改完跑 `npm run build`）

## 架构要点

- `src/index.ts` 是唯一源文件，导出 `CodeBuddyAuthPlugin`（Plugin 类型）和 default export
- 运行时作为 OpenCode 插件加载，通过自定义 `fetch` 拦截 `/chat/completions` 请求并注入 CodeBuddy 认证 headers
- `@opencode-ai/plugin` 是 peer dependency，仅开发时安装

### 核心 Hooks

1. **config** — 启动时从 `~/.local/share/opencode/auth.json` 读取已保存的 access token，调用 `GET /v3/config` 动态获取 craft agent 可用模型，注入到 `config.provider.codebuddy.models`；未登录或获取失败时 fallback 为 `auto` 默认模型；不覆盖用户手动声明的 models
2. **auth** — IOA OAuth 登录流程（浏览器 → 轮询 token），loader 返回自定义 fetch 拦截请求
3. **chat.params** — 设置 baseURL

### SSE 处理（本地补丁核心，`normalizeCodeBuddySSE`）

对 CodeBuddy 流式响应做三层处理，详见 `RELEASE.md` 的踩坑汇总：

1. **字段规范化**：`finish_reason: ""` → `null`；剥离 `function_call` / `refusal` / `tool_calls` / `extra_fields` 的 null/empty
2. **reasoning 分批**：纯 reasoning-only delta 累积，按 `REASONING_BATCH_CHARS = 400` 字符分批 flush，
   或遇到 content/tool_calls/stop 时 flush 残余——OpenCode 上游 Lifecycle(id=`reasoning-0`) 会把多次 delta 拼接成一段完整思考
3. **心跳兜底**：`setTimeout` 链式（`REASONING_HEARTBEAT_MS = 2000`）主动 enqueue 累积 reasoning，
   保证慢思考时每 ~2s 也有输出，防无限卡死；`heartbeatActive` 标志 + `stopHeartbeat()` 保证定时器随流结束消亡

**四条不能违反的铁律**（每一条都是踩坑换来的，详见 RELEASE.md）：

1. 禁止在 ReadableStream `pull()` 内做"攒数据等时间再 flush"——pull 只在消费者请求时调用，攒着不 flush = 死锁
2. 空行透传是流心跳，**不能跳过**——reasoning-only 期间靠空行 enqueue 维持 pull 被持续调用
3. flush 必须由 `setTimeout` 主动驱动（`controller.enqueue()` 可在 pull 之外调用）
4. SSE 事件之间必须空行分隔（输出行统一 `data: {...}\n\n`），否则相邻 data 被解析器拼行导致 JSON 失败

### 用户配置

`codebuddy` 不在 models.dev 数据库中，插件通过 `config` hook 自动创建 `provider.codebuddy`（如未声明），并动态注入 models。支持三种配置方式：
1. 只加 `plugin`，不声明 provider（推荐，全自动）
2. 声明 provider 不声明 models（自动发现模型）
3. 手动声明 provider + models（完全手动控制）

## 环境

- 国内版 API：`copilot.tencent.com`，`X-Domain: www.codebuddy.cn`
- 国际版 API：`www.codebuddy.ai`，`X-Domain: www.codebuddy.ai`
- 切换环境需同时改 `CONFIG.serverUrl` 和 `CONFIG.domain`
- 模型列表通过 `GET /v3/config` 获取（需 access token），可能随时变化
- Token 存储路径：`~/.local/share/opencode/auth.json`，config hook 直接读取该文件获取 token

## 调试留痕

- `src/index.ts.bak` ~ `.bak7`：SSE 处理的完整演进备份（含死锁版/心跳版等历史状态），
  排查回归问题时可按时间顺序对比
- `package.json.bak` / `tsconfig.json.bak`：构建配置演进备份
- 日志均通过 `input.client.app.log()`（service=`codebuddy-fork`）写入
  `~/.local/share/opencode/log/opencode.log`，带 `[codebuddy-fork-vX.Y.Z]` 前缀
- OpenCode `client.app.log()` 级别枚举仅 `debug / info / warn / error`（**无 TRACE**）
