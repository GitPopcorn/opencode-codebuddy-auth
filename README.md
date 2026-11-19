# opencode-codebuddy-auth

OpenCode 插件，用于 CodeBuddy (IOA) 认证。通过浏览器 OAuth 登录后，可在 OpenCode CLI 中使用 CodeBuddy 的对话模型。支持自动从 `/v3/config` 动态获取可用模型列表，支持国内版和国际版切换。

除认证与模型发现外，本插件还包含：**指纹净化** (规避上游渠道校验 11128) 、**SSE 规范化** (thinking 分批合并 + 心跳兜底) 、**凭据自愈** (自动续期 / 引导重登) 、**账号切换检测**、**回合级请求 ID** (用量页按回合归并)。

## 安装

在 `opencode.json` 中添加插件即可，三种配置方式任选其一：

#### 方式一：最简配置 (推荐)

只需添加插件，provider 和 models 由插件自动创建和发现：

```jsonc
{
  "plugin": ["opencode-codebuddy-auth"]
}
```

#### 方式二：声明 provider，自动发现 models

手动声明 provider 配置，但无需写 models (由 `config` hook 自动注入) ：

```jsonc
{
  "plugin": ["opencode-codebuddy-auth"],
  "provider": {
    "codebuddy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CodeBuddy",
      "options": {
        "baseURL": "https://copilot.tencent.com/v2",
        "setCacheKey": true
      }
    }
  }
}
```

#### 方式三：手动声明 models

完全手动控制模型列表，插件不会覆盖已有条目：

```jsonc
{
  "plugin": ["opencode-codebuddy-auth"],
  "provider": {
    "codebuddy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "CodeBuddy",
      "options": {
        "baseURL": "https://copilot.tencent.com/v2",
        "setCacheKey": true
      },
      "models": {
        "auto":                    { "name": "Auto", "contextLength": 256000 },
        "deepseek-v4.1-flash":     { "name": "Deepseek-V4.1-Flash", "contextLength": 1000000 },
        "glm-5.3-flash":           { "name": "GLM-5.3-Flash", "contextLength": 1000000 },
        "minimax-m3.1-flash":      { "name": "MiniMax-M3.1-Flash", "contextLength": 1000000 }
      }
    }
  }
}
```

> 插件通过 `config` hook 在启动时动态从 CodeBuddy API (`GET /v3/config`) 获取 craft agent 可用模型，自动注入到 `provider.codebuddy.models`。未登录时 fallback 为 `auto` 默认模型。如需覆盖，可在 `provider.codebuddy.models` 中手动声明，插件不会覆盖已有条目。
>
> **示例仅供格式参考，实际清单以 `/v3/config` 实时结果为准。**

## 登录

```bash
opencode providers login --provider codebuddy
```

浏览器会打开 IOA 登录页面，完成后 token 自动保存到本地。

## 用户命令

插件在 OpenCode 内注入两条命令：

| 命令 | 作用 |
|---|---|
| `/codebuddy-login` | 重新登录 CodeBuddy (自动打开浏览器完成 IOA 登录) |
| `/codebuddy-doctor` | 体检输出：凭据状态与到期时间、刷新可行性、模型发现数量、设备令牌、当前绑定账号 |

## 查看可用模型

```bash
# 非交互式列出
opencode models codebuddy

# 交互式选择 (OpenCode 内输入 /model 搜索 codebuddy)
```

IOA 登录后，config hook 会通过 `GET /v3/config` 实时获取 craft agent 可用模型并自动注入。

#### craft agent 支持的模型 (来自 /v3/config 接口，可能随时更新；实测日期 2026-11-19)

| 模型 ID | 名称 | 上下文 | 图片 | 推理 |
|---------|------|--------|------|------|
| `auto` | Auto | 256K | Yes | Yes |
| `hy4std` | Hy4 | 960K | Yes | Yes |
| `hy4flash` | Hy4 flash | 960K | Yes | Yes |
| `hy4flash-free` | Hy4 flash | 960K | Yes | Yes |
| `step-5-preview` | Step-5-Preview | 1M | Yes | Yes |
| `space-bunny` | Space-Bunny | 1M | Yes | Yes |
| `deepseek-v4.1-flash` | Deepseek-V4.1-Flash | 1M | Yes | Yes |
| `deepseek-v4-pro` | Deepseek-V4-Pro | 1M | Yes | Yes |
| `glm-5.3` | GLM-5.3 | 1M | Yes | Yes |
| `glm-5.3-flash` | GLM-5.3-Flash | 1M | Yes | Yes |
| `glm-5.2` | GLM-5.2 | 1M | Yes | Yes |
| `kimi-k3.1-pro` | Kimi-K3.1-Pro | 1M | Yes | Yes |
| `kimi-k3-1` | Kimi-K3 | 1M | Yes | Yes |
| `kimi-k2.8-preview` | Kimi-K2.8-Preview | 1M | Yes | Yes |
| `minimax-m3.1-flash` | MiniMax-M3.1-Flash | 1M | Yes | Yes |
| `mimo-v2.6-pro` | Xiaomi MiMo-V2.6-Pro | 1M | Yes | Yes |

#### 动态获取模型列表

```bash
curl -H 'Accept: application/json, text/plain, */*' \
     -H 'X-Requested-With: XMLHttpRequest' \
     -H 'Authorization: Bearer <TOKEN>' \
     -H 'X-User-Id: <USER_ID>' \
     -H 'X-Domain: www.codebuddy.cn' \
     -H 'X-Product: SaaS' \
     -H 'X-Env-ID: production' \
     -H 'X-IDE-Type: CodeBuddyIDE' \
     -H 'X-IDE-Name: CodeBuddyIDE' \
     -H 'X-IDE-Version: 4.12.4' \
     -H 'X-Product-Version: 4.12.4' \
     -H 'X-Agent-Intent: craft' \
     -H 'X-Agent-Type: main' \
     -H 'X-Request-ID: <32 位小写 hex>' \
     -H 'X-Conversation-ID: <32 位小写 hex>' \
     -H 'X-Conversation-Request-ID: <与 X-Request-ID 同值>' \
     -H 'X-Conversation-Message-ID: <32 位小写 hex>' \
     -H 'X-Request-Trace-Id: <UUID v4>' \
     -H 'User-Agent: CodeBuddyIDE/4.12.4 CodeBuddy/4.12.4' \
     'https://copilot.tencent.com/v3/config'
```

> **插件实际发出的头比这更多** —— 含 B3 追踪三元组 (`X-Trace-ID` / `X-B3-TraceId` / `X-B3-SpanId` / `X-B3-ParentSpanId`) 与两个 `monitor_*` 埋点时间戳，完整清单见 `src/index.ts` 的 `buildAuthHeaders`。

- `data.models` — 所有可用模型的详细信息
- `data.agents[0].models` — craft agent 可用的模型 ID 列表

## 环境变量

通过 shell `export` 设置，普通用户无需配置 (JWT 自动提取) ：

```bash
# 强制使用指定模型 (忽略 OpenCode 模型选择)
export CODEBUDDY_DEFAULT_MODEL=deepseek-v4.1-flash

# 覆盖企业/租户信息 (不设置则从 JWT 自动提取)
export CODEBUDDY_TENANT_ID=xxx
export CODEBUDDY_ENTERPRISE_ID=xxx
export CODEBUDDY_USER_ID=xxx

opencode
```

| 变量 | 说明 | 必需 |
|------|------|------|
| `CODEBUDDY_DEFAULT_MODEL` | 强制使用指定模型 (不设置则使用 OpenCode 选择的模型)  | 否 |
| `CODEBUDDY_TENANT_ID` | 覆盖 tenant_id (不设置则从 JWT 自动提取)  | 否 |
| `CODEBUDDY_ENTERPRISE_ID` | 覆盖 enterprise_id (不设置则从 JWT 自动提取)  | 否 |
| `CODEBUDDY_USER_ID` | 覆盖 user_id (不设置则从 JWT 自动提取)  | 否 |
| `CODEBUDDY_FINGERPRINT_SANITIZE` | 关闭全部指纹文本改写 (置 `off`) 。旧名 `CODEBUDDY_PROMPT_SANITIZE` 为废弃别名，置 `off` 等同关闭 | 否 |
| `CODEBUDDY_FINGERPRINT_SYSTEM_FIRST` | 关闭 A1 (保证首条消息是 `role:system`) ，与净化开关相互独立 | 否 |
| `CODEBUDDY_FINGERPRINT_SCOPE` | 净化作用范围：`all` 改写全部 role，`system-assistant` 只改 system + assistant (默认) | 否 |
| `CODEBUDDY_RELOCATE_TAGS` | 逗号分隔的注入块标签名 (默认 `system-reminder,user_info`) ；置 `off` 或空值停用 A2 迁移 | 否 |
| `CODEBUDDY_TURN_REQUEST_ID` | 置 `off` 退回每请求新 ID (关闭用量页回合归并) | 否 |
| `CODEBUDDY_DEVICE_TOKEN` | 置 `on` 才附带自签的 `X-Device-Token` | 否 |
| `CODEBUDDY_TURING_NATIVE` | 指定 TuringShield 原生插件路径 (文件或目录均可) ，默认自动发现 | 否 |
| `CODEBUDDY_TURING_NATIVE_DISABLED` | 置 `1` 完全关闭设备令牌能力 | 否 |

## 国内版 vs 国际版

默认使用**国内版**。切换国际版只需修改 `baseURL`，插件会自动检测并切换 `X-Domain`：

```jsonc
{
  "plugin": ["opencode-codebuddy-auth"],
  "provider": {
    "codebuddy": {
      "options": {
        "baseURL": "https://www.codebuddy.ai/v2"
      }
    }
  }
}
```

| 环境 | baseURL | X-Domain (自动检测)  |
|------|---------|---------|
| 国内版 (默认)  | `https://copilot.tencent.com/v2` | `www.codebuddy.cn` |
| 国际版 | `https://www.codebuddy.ai/v2` | `www.codebuddy.ai` |

> 插件只取 `baseURL` 的协议与主机部分 (路径被忽略) ，实际请求地址固定为 `<主机>/v2/chat/completions`，因此写 `https://copilot.tencent.com` 与 `https://copilot.tencent.com/v2` 等价。

> 插件根据 `baseURL` 自动设置 `X-Domain`：检测到 `codebuddy.ai` 时使用 `www.codebuddy.ai`，否则默认 `www.codebuddy.cn`。

## 工作原理

```
OpenCode CLI
  ├─ config hook → 读取 ~/.local/share/opencode/auth.json 获取 token
  │                 调用 GET /v3/config 动态获取 craft agent 可用模型
  │                 注入到 config.provider.codebuddy.models
  ├─ auth hook → 浏览器 IOA OAuth → 获取 access_token + refresh_token
  ├─ loader() → 返回 { apiKey, baseURL, fetch }
  │              fetch 拦截所有 /chat/completions 请求
  └─ 对话流程 → 拦截请求
                附加认证 headers (Authorization, B3 追踪, X-Model-ID 等)
                转发到 CodeBuddy /v2/chat/completions
                SSE 规范化后回传 (thinking 分批 + 心跳 + 事件分隔)
```

- **自定义 fetch** 拦截所有 `/chat/completions` 请求，绕过 AI SDK 默认认证
- **自动 token 刷新** — 遇到 401/403 时自动刷新 token 后重试
- **无需协议转换** — API 直接返回标准 OpenAI 格式，只需做 SSE 规范化 (见下)
- **回合级请求 ID** — 同一用户回合内的多次上游请求复用同一个 `X-Request-ID`；上游账号用量页按该 ID 归并，于是一个回合在用量页上合并成一行、积分求和。可用环境变量 `CODEBUDDY_TURN_REQUEST_ID=off` 关闭 (退回每请求新 ID 的旧行为)。**代价是丢失单请求粒度** —— 用量页只剩「一回合一行的合计积分」，上游没有更细的视图；需要逐次查看时用 `CODEBUDDY_TURN_REQUEST_ID=off` 临时退回

### 钩子清单

| 钩子 | 作用 |
|---|---|
| `config` | 启动自检 + 模型发现 + 注入 provider + 注入命令 |
| `auth` | IOA OAuth 登录流程 |
| `chat.params` | 设置 baseURL + 捕获 sessionID |
| `experimental.chat.system.transform` | system prompt 指纹净化 |
| `command.execute.before` | 拦截本插件两条命令 (`/codebuddy-login`、`/codebuddy-doctor`) |
| `event` | `session.error` 鉴权自愈 |

### SSE 规范化

上游返回的 thinking delta 会被切碎成几十个 3ms 小块，插件按 400 字符分批合并 + 2s 心跳兜底，事件之间统一 `\n\n` 分隔。

### 指纹净化

上游对 `system` / `assistant` 正文与 `reasoning_content` 做不分角色的精确子串匹配，历史里一条含指纹的消息会毒化整个会话 (400 / 11128) ；插件按**跨度改写**出站请求体 (用户 AGENTS.md 指令完整保留) ，规则表覆盖 `content` / `reasoning_content` / `reasoning` / 工具入参。

### 凭据自愈

启动期自检 (凭据缺失或刷新失败则拉起浏览器重登) + 会话内 401/403 自动续期 + 账号切换检测 (sidecar `~/.local/share/opencode/codebuddy-account.json`) 。

## 已知限制

- 历史被压缩后 user 消息下标漂移，会把一个回合拆成两行 (可接受退化)
- `CODEBUDDY_TURN_REQUEST_ID=off` 时用量页回到一请求一行
- 插件改动需**重启 OpenCode 进程**才生效 (Bun 模块缓存)
- `opencode run` 在无 stdin 重定向时会静默阻塞，自动化验证须重定向 `NUL`

## 开发

```bash
npm install
npm run build
```

黄金回归脚本 (零依赖，纯 node) ：

```bash
node scripts/verify-fingerprint.mjs
```

当前为 58 cases / 212 assertions。

## 许可证

MIT
