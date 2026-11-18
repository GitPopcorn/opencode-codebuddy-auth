# opencode-codebuddy-auth

OpenCode 插件，用于 CodeBuddy (IOA) 认证。通过浏览器 OAuth 登录后，可在 OpenCode CLI 中使用 CodeBuddy 的对话模型。支持自动从 `/v3/config` 动态获取可用模型列表，支持国内版和国际版切换。

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
        "auto":                    { "name": "Auto", "contextLength": 168000 },
        "hy3-preview-agent":       { "name": "Hy3-preview", "contextLength": 192000 },
        "glm-5v-turbo":            { "name": "GLM-5v-Turbo", "contextLength": 200000 },
        "glm-5.1":                 { "name": "GLM-5.1", "contextLength": 200000 },
        "glm-5.0-turbo":           { "name": "GLM-5.0-Turbo", "contextLength": 200000 },
        "glm-4.6":                 { "name": "GLM-4.6", "contextLength": 168000 },
        "kimi-k2.6":               { "name": "Kimi-K2.6", "contextLength": 256000 },
        "kimi-k2.5":               { "name": "Kimi-K2.5", "contextLength": 256000 },
        "deepseek-v4-pro":         { "name": "DeepSeek-V4-Pro", "contextLength": 1000000 },
        "deepseek-v4-flash":       { "name": "DeepSeek-V4-Flash", "contextLength": 1000000 },
        "deepseek-v3-2-volc":      { "name": "DeepSeek-V3.2", "contextLength": 96000 }
      }
    }
  }
}
```

> 插件通过 `config` hook 在启动时动态从 CodeBuddy API (`GET /v3/config`) 获取 craft agent 可用模型，自动注入到 `provider.codebuddy.models`。未登录时 fallback 为 `auto` 默认模型。如需覆盖，可在 `provider.codebuddy.models` 中手动声明，插件不会覆盖已有条目。

## 登录

```bash
opencode providers login --provider codebuddy
```

浏览器会打开 IOA 登录页面，完成后 token 自动保存到本地。

## 查看可用模型

```bash
# 非交互式列出
opencode models codebuddy

# 交互式选择 (OpenCode 内输入 /model 搜索 codebuddy)
```

IOA 登录后，config hook 会通过 `GET /v3/config` 实时获取 craft agent 可用模型并自动注入。

#### craft agent 支持的模型 (来自 /v3/config 接口，可能随时更新)

| 模型 ID | 名称 | 上下文 | 图片 | 推理 |
|---------|------|--------|------|------|
| `auto` | Auto | 168K | Yes | Yes |
| `hy3-preview-agent` | Hy3-preview | 192K | Yes | Yes |
| `glm-5v-turbo` | GLM-5v-Turbo | 200K | Yes | Yes |
| `glm-5.1` | GLM-5.1 | 200K | Yes | Yes |
| `glm-5.0-turbo` | GLM-5.0-Turbo | 200K | Yes | Yes |
| `glm-4.6` | GLM-4.6 | 168K | No | - |
| `kimi-k2.6` | Kimi-K2.6 | 256K | Yes | Yes |
| `kimi-k2.5` | Kimi-K2.5 | 256K | Yes | Yes |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1M | Yes | Yes |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | 1M | Yes | Yes |
| `deepseek-v3-2-volc` | DeepSeek-V3.2 | 96K | Yes | Yes |

#### 动态获取模型列表

```bash
curl -H 'Accept: application/json, text/plain, */*' \
     -H 'X-Requested-With: XMLHttpRequest' \
     -H 'Authorization: Bearer <TOKEN>' \
     -H 'X-User-Id: <USER_ID>' \
     -H 'X-Domain: www.codebuddy.cn' \
     -H 'X-Product: SaaS' \
     -H 'X-IDE-Type: VSCode' \
     -H 'X-IDE-Name: VSCode' \
     -H 'X-IDE-Version: 1.119.0' \
     -H 'X-Product-Version: 4.9.29177644' \
     -H 'X-Request-Trace-Id: <UUID>' \
     -H 'X-Env-ID: production' \
     -H 'User-Agent: VSCode/1.119.0 CodeBuddy/4.9.29177644' \
     'https://copilot.tencent.com/v3/config'
```

- `data.models` — 所有可用模型的详细信息
- `data.agents[0].models` — craft agent 可用的模型 ID 列表

## 环境变量

通过 shell `export` 设置，普通用户无需配置 (JWT 自动提取) ：

```bash
# 强制使用指定模型 (忽略 OpenCode 模型选择)
export CODEBUDDY_DEFAULT_MODEL=deepseek-v3-2-volc

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
                直接透传 OpenAI 兼容 SSE 响应
```

- **自定义 fetch** 拦截所有 `/chat/completions` 请求，绕过 AI SDK 默认认证
- **自动 token 刷新** — 遇到 401/403 时自动刷新 token 后重试
- **无需 SSE 转换** — API 已直接返回标准 OpenAI 格式

## 开发

```bash
npm install
npm run build
```

## 许可证

MIT
