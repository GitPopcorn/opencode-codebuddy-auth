# AGENTS.md

## 项目概述

OpenCode 插件，为 CodeBuddy 提供 IOA OAuth 认证和请求拦截。单文件项目，入口 `src/index.ts`。

> **本仓库是本地 fork**：基线 `kuops/opencode-codebuddy-auth` v1.0.3，叠加了针对
> CodeBuddy CN 网关非标准 SSE 的补丁 (thinking 切碎/卡死/JSON 解析修复) 。
> 版本历史见 `RELEASE.md`，补丁变更总览见 `PATCH-NOTES.md`。

## 构建

```bash
npm install && npm run build   # tsc 编译到仓库根目录 (index.js + index.d.ts，非 dist/)
node scripts/verify-fingerprint.mjs   # 指纹净化黄金回归测试 (零依赖，纯 node)
```

无 lint、无 CI。只有 `npm run build`；`scripts/verify-fingerprint.mjs` 是独立的
黄金回归脚本 (每条内置规则一条用例 + 幂等 + 空内容 + 工具入参 JSON + 日志防自污染) 。

**构建输出位置注意**：`tsconfig.json` 的 `outDir: "."`，`rootDir: "src"`，
编译产物直接落在仓库根目录 (`index.js`) ，OpenCode 通过 `opencode.jsonc` 的
`plugin` 引用该文件。不要改回 `dist/`，否则 `opencode.jsonc` 引用路径要同步改。

## 版本规范 (重要)

- `FORK_VERSION` 是**固定常量** (在 `src/index.ts` 顶部) ，不带 `v` 前缀，
  `VERSION_TAG = codebuddy-fork-v${FORK_VERSION}` 会拼出 `codebuddy-fork-vX.Y.Z`
- **每次修改代码逻辑后必须手动 bump `FORK_VERSION`**，否则无法确认 OpenCode 加载的
  是否最新产物 (OpenCode 进程有模块缓存，重启后看 `starting` 日志的版本号来判断)
- 产物 `index.js` 必须与 `src/index.ts` 同步 (改完跑 `npm run build`)

## 文本规范 (全角圆括号)

代码、注释、文档里的圆括号一律用半角 `(` `)`，禁止使用全角左圆括号 (U+FF08) 与全角右圆括号 (U+FF09)。
本条规则刻意只写码位、不写字形，目的是让全仓批量处理能无豁免地重复执行，不会把规则文本自身改掉。

- 替换形态：全角左圆括号 → ` (`，全角右圆括号 → `) ` (半角括号外侧补一个空格，保持中西文混排间距)
- 例外只限两类：被引号或反引号括含的引用内容、正则或匹配串里的字面字符。改任何字符串前必须确认它不是匹配键
  (既有代码里规则表 R1~R8、命令名常量、错误码比较均不含该字符)
- 批量处理命令：

    jsinvokefiles modify process-text formatReplaceMarkdownFullWidthParenthesesOnly --script-seq 1 --file <显式文件路径...> --force

- 必须用显式 `--file` 枚举，不要用 `-g` 通配符：工具的文件发现不排除 `node_modules`，`-g` 配合 `-r Y` 会钻进依赖目录
- 该方法会顺带移除行尾空白，并把混合行尾统一为文件内占多数的形态。处理完复查 `git diff`，并删除工具生成的 `*.js_inv.bak`
- 改完注释与文案后跑 `npm run build`，`index.js` 与 `index.d.ts` 必须与 `src/index.ts` 保持同步

## 架构要点

- `src/index.ts` 是唯一源文件，导出 `CodeBuddyAuthPlugin` (Plugin 类型) 和 default export
- 运行时作为 OpenCode 插件加载，通过自定义 `fetch` 拦截 `/chat/completions` 请求并注入 CodeBuddy 认证 headers
- `@opencode-ai/plugin` 是 peer dependency，仅开发时安装

### 核心 Hooks

1. **config** — 启动时从 `~/.local/share/opencode/auth.json` 读取已保存的 access token，调用 `GET /v3/config` 动态获取 craft agent 可用模型，注入到 `config.provider.codebuddy.models`；未登录或获取失败时 fallback 为 `auto` 默认模型；不覆盖用户手动声明的 models。v3.6.0 起：凭据临近过期会先主动刷新并落盘，模型发现成功与失败都会记日志
2. **auth** — IOA OAuth 登录流程 (浏览器 → 轮询 token) ，loader 返回自定义 fetch 拦截请求
3. **chat.params** — 设置 baseURL，并捕获 `sessionID` 供 `X-Conversation-ID` 派生
4. **event** — v3.9.0 起监听 `session.error`，命中 `ProviderAuthError` 或 401 与 403 时自动刷新凭据并提示重试；`command.executed` 作为命令的兜底入口
5. **command.execute.before** — 拦截 `/codebuddy-login` 与 `/codebuddy-doctor`，原地清空 `output.parts` 并中止会话 (宿主对任何命令都会强起一个 assistant turn)
6. **experimental.chat.system.transform** — 按跨度改写 system prompt 中的第三方身份指纹

### 凭据自愈与指纹净化

- 启动期自检：无凭据或刷新失败 → 自动拉起浏览器重登 (`plugin/auth/state` → 浏览器 → 轮询 `plugin/auth/token`，`11217` 表示登录中) → 经 `client.auth.set` 落盘
- 会话内自愈：`event` 钩子捕获 401 与 403 → 自动刷新 → toast 提示重试 (不自动重放用户消息，避免副作用重复)
- 账号切换检测：sidecar `~/.local/share/opencode/codebuddy-account.json` 记录 `uid` 与 `nickname`，与当前令牌绑定账号不一致即提示
- 渠道指纹净化：出站 body 按**跨度改写** (不是整条替换 system，用户 AGENTS.md 指令完整保留) ，覆盖 `content`、`reasoning_content`、`reasoning` 与工具参数
  - v4.0.1 起：规则表**合并为一张** (prompt 6 条 + body 29 条共用一个引擎) ，开关收敛为 `CODEBUDDY_FINGERPRINT_SANITIZE`
  - 作用范围由 `CODEBUDDY_FINGERPRINT_SCOPE` 控制，默认 `system-assistant` (线上实测上游不扫描 user / tool 角色)
  - 净化在**深拷贝**上进行 —— 宿主传入的请求对象绝不被就地修改
  - 上游错误体**绝不原样进日志**：只记 HTTP 状态 + 固定分类标签 + 脱敏码 (`11128` -> `CHANNEL_REJECT`) ，
    防止宿主日志被 agent 读回后重新触发同一个错误 (自污染回路)
- 用户命令：`/codebuddy-login` 主动重登，`/codebuddy-doctor` 输出体检结论

### 环境变量开关

| 变量 | 默认 | 作用 |
|---|---|---|
| `CODEBUDDY_FINGERPRINT_SANITIZE` | 开启 | 置 `off` 关闭**全部**指纹文本改写 (body + system prompt)  |
| `CODEBUDDY_FINGERPRINT_SYSTEM_FIRST` | 开启 | 置 `off` 关闭 A1 (保证首条消息是 `role:system`) —— 与净化开关相互独立 |
| `CODEBUDDY_FINGERPRINT_SCOPE` | `system-assistant` | `all` 改写全部 role；`system-assistant` 只改 system + assistant (工具入参始终改写)  |
| `CODEBUDDY_DEVICE_TOKEN` | 关闭 | 置 `on` 才附带自签的 `X-Device-Token` |
| `CODEBUDDY_TURING_NATIVE` | 自动发现 | 指定 TuringShield 原生插件路径 (文件或目录均可)  |
| `CODEBUDDY_TURING_NATIVE_DISABLED` | 未设置 | 置 `1` 完全关闭设备令牌能力 |
| `CODEBUDDY_PROMPT_SANITIZE` | 未设置 | **废弃别名** —— 置 `off` 等同于关闭 `CODEBUDDY_FINGERPRINT_SANITIZE` (首次见到会打一条 info 提示迁移)  |
| `CODEBUDDY_DEFAULT_MODEL` | 空 | 强制覆盖用户所选模型 |

### SSE 处理 (本地补丁核心，`normalizeCodeBuddySSE`)

对 CodeBuddy 流式响应做三层处理，详见 `RELEASE.md` 的踩坑汇总：

1. **字段规范化**：`finish_reason: ""` → `null`；剥离 `function_call` / `refusal` / `tool_calls` / `extra_fields` 的 null/empty
2. **reasoning 分批**：纯 reasoning-only delta 累积，按 `REASONING_BATCH_CHARS = 400` 字符分批 flush，
   或遇到 content/tool_calls/stop 时 flush 残余——OpenCode 上游 Lifecycle(id=`reasoning-0`) 会把多次 delta 拼接成一段完整思考
3. **心跳兜底**：`setTimeout` 链式 (`REASONING_HEARTBEAT_MS = 2000`) 主动 enqueue 累积 reasoning，
   保证慢思考时每 ~2s 也有输出，防无限卡死；`heartbeatActive` 标志 + `stopHeartbeat()` 保证定时器随流结束消亡

**四条不能违反的铁律** (每一条都是踩坑换来的，详见 RELEASE.md) ：

1. 禁止在 ReadableStream `pull()` 内做"攒数据等时间再 flush"——pull 只在消费者请求时调用，攒着不 flush = 死锁
2. 空行透传是流心跳，**不能跳过**——reasoning-only 期间靠空行 enqueue 维持 pull 被持续调用
3. flush 必须由 `setTimeout` 主动驱动 (`controller.enqueue()` 可在 pull 之外调用)
4. SSE 事件之间必须空行分隔 (输出行统一 `data: {...}\n\n`) ，否则相邻 data 被解析器拼行导致 JSON 失败

### 用户配置

`codebuddy` 不在 models.dev 数据库中，插件通过 `config` hook 自动创建 `provider.codebuddy` (如未声明) ，并动态注入 models。支持三种配置方式：
1. 只加 `plugin`，不声明 provider (推荐，全自动)
2. 声明 provider 不声明 models (自动发现模型)
3. 手动声明 provider + models (完全手动控制)

## 环境

- 国内版 API：`copilot.tencent.com`，`X-Domain: www.codebuddy.cn`
- 国际版 API：`www.codebuddy.ai`，`X-Domain: www.codebuddy.ai`
- 切换环境需同时改 `CONFIG.serverUrl` 和 `CONFIG.domain`
- 模型列表通过 `GET /v3/config` 获取 (需 access token) ，可能随时变化
- Token 存储路径：`~/.local/share/opencode/auth.json`，config hook 直接读取该文件获取 token

## 调试留痕

- `src/index.ts.bak` ~ `.bak7`：SSE 处理的完整演进备份 (含死锁版/心跳版等历史状态) ，
  排查回归问题时可按时间顺序对比
- `package.json.bak` / `tsconfig.json.bak`：构建配置演进备份
- 日志均通过 `input.client.app.log()` (service=`codebuddy-fork`) 写入
  `~/.local/share/opencode/log/opencode.log`，带 `[codebuddy-fork-vX.Y.Z]` 前缀
- OpenCode `client.app.log()` 级别枚举仅 `debug / info / warn / error` (**无 TRACE**)
- 账号 sidecar：`~/.local/share/opencode/codebuddy-account.json` 记录当前绑定账号的 `uid` 与 `nickname`，用于账号切换检测
- 体检命令：`/codebuddy-doctor` 输出凭据、到期时间、刷新可行性、模型数、设备令牌与绑定账号 (也可在进程外调用 `diagnoseForTest()`)

---

## 提交信息规范门禁

- **触发条件** (以下任一时机触发) ：
    - 提交代码：`commit-msg` 钩子自动检查并就地修复提交信息
    - 生成提交信息：调用门禁脚本 `--apply --file <提交信息文件>`
    - Reword 调整提交信息：调用门禁脚本 `--apply --file <提交信息文件>`
    - 全量历史复核：调用门禁脚本 `--scan-history`
- **门禁脚本**：单点共享，位于 `E:\vscode-workspace-temp\tools\check_commit_msg.py`
- **钩子安装**：`git config core.hooksPath .githooks`
- **规则全文与判定口径**：`E:\vscode-workspace-temp\docs\specs\2026-10-26-提交信息规范.md`
