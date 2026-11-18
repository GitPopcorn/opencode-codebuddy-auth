#!/usr/bin/env node
/**
 * 指纹净化黄金回归测试（零依赖，纯 node）
 * ----------------------------------------------------------------------------
 * 用法：node scripts/verify-fingerprint.mjs
 *
 * 覆盖：
 *   1. 每条内置规则一条"输入 -> 期望输出"用例（body 29 条 + prompt 6 条）；
 *   2. 幂等：sanitize(sanitize(x)) === sanitize(x)；
 *   3. 空内容：system 换中性默认提示词、assistant 无工具调用则丢弃；
 *   4. tool_calls[].function.arguments 改写后仍是合法 JSON（非法则回滚）；
 *   5. 深拷贝：净化绝不改写调用方传入的对象；
 *   6. 作用范围：system-assistant（默认）不改 user / tool，all 改；
 *   7. 开关：净化总开关 / system-first 开关 / 作用范围开关 / 废弃别名；
 *   8. 日志防自污染：失败路径写出的日志里不含 11128 与上游原句。
 *
 * 依赖：只依赖仓库根目录的构建产物 index.js（零第三方运行时依赖）。
 */

const mod = await import("../index.js");

const {
  sanitizeFingerprintTextForTest,
  sanitizeSystemPromptForTest,
  sanitizePayloadForTest,
  isFingerprintSanitizeEnabled,
  isSystemFirstEnabled,
  getFingerprintScope,
  CodeBuddyAuthPlugin,
} = mod;

/** 断言失败收集器 */
const failures = [];
let checks = 0;
let caseCount = 0;

function fail(name, detail) {
  failures.push(`${name}\n    ${detail}`);
}

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) {
    fail(name, `expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function checkTrue(name, condition, detail) {
  checks++;
  if (!condition) fail(name, detail || "condition was false");
}

/**
 * 注册一条规则用例：断言精确输出 + 幂等。
 * @param {string} id 规则标识
 * @param {(text: string) => {text: string} | string} fn 净化函数
 * @param {string} input 输入
 * @param {string} expected 期望输出
 */
function addCase(id, fn, input, expected) {
  caseCount++;
  const apply = (text) => {
    const out = fn(text);
    return typeof out === "string" ? out : out.text;
  };
  const first = apply(input);
  check(`case[${id}] output`, first, expected);
  const second = apply(first);
  check(`case[${id}] idempotency`, second, first);
}

// ============================================================================
// 1. body 规则用例（29 条 —— 与内置规则一一对应）
// ============================================================================

const BODY_CASES = [
  // R1 固定短语表（20 条）
  ["body-lit-ai-agent-harness",
    "You are an AI agent powered by DeepSeek Harness.",
    "You are an AI agent running inside this harness."],
  ["body-lit-coding-agent-powered-by",
    "You are a coding agent powered by the model",
    "You are a coding agent running on the model"],
  ["body-lit-harness-web-gui",
    "You are interacting with the user through the DeepSeek Harness Web GUI.",
    "You are working with the user inside this harness Web GUI."],
  ["body-lit-agent-teams",
    "Agent Teams is available in this session.",
    "Agent Teams is enabled for this session."],
  ["body-lit-tokens-prefixed-at",
    "Tokens prefixed with @ are paths the user explicitly referenced.",
    "Paths that begin with @ are the ones the user explicitly referenced."],
  ["body-lit-relative-paths",
    "Relative paths resolve from the workspace root;",
    "Relative paths are resolved against the workspace root;"],
  ["body-lit-absolute-paths",
    "absolute paths identify files or directories on the host.",
    "absolute paths point at files or directories on the host."],
  ["body-lit-trailing-slash",
    "A trailing slash marks a directory:",
    "A trailing slash indicates a directory:"],
  ["body-lit-list-it",
    "list it when its contents matter.",
    "list it whenever its contents matter."],
  ["body-lit-anything-else",
    "Anything else is a file:",
    "Everything else is a file:"],
  ["body-lit-read-tool",
    "use the read tool when its contents are needed,",
    "use the read tool whenever you need its contents,"],
  ["body-lit-do-not-claim",
    "and do not claim to have inspected it before reading.",
    "and never claim to have inspected it before reading it."],
  ["body-lit-at-quoted-path",
    '@"..." quotes a path containing spaces.',
    'A path containing spaces is quoted with @"...".'],
  ["body-lit-no-other-target",
    "without naming another target, they mean this GUI.",
    "and names no other target, the interface described here is meant."],
  ["body-lit-mean-this-gui",
    "Whenever two paths are given, they mean this GUI.",
    "Whenever two paths are given, the interface described here is meant."],
  ["body-lit-main-branch",
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)"],
  ["body-lit-claude-code-cli",
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are an AI coding assistant, an official CLI tool for Claude"],
  ["body-lit-codex-cli",
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant",
    "You are a coding agent running in this CLI tool, a terminal-based coding assistant"],
  ["body-lit-feedback-url",
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, report the issue at https://example.invalid/feedback/issues"],
  ["body-lit-sisyphus-junior",
    "Sisyphus-Junior - Focused executor from OhMyOpenCode",
    "Focused executor"],
  // R2 品牌名改写（3 条）
  ["body-brand-deepseek-harness",
    "Runtime: DeepSeek Harness today.",
    "Runtime: this harness today."],
  ["body-brand-deepseek-runtime",
    "Engine DeepSeekRuntime here.",
    "Engine this runtime here."],
  ["body-brand-ohmyopencode",
    "From OhMyOpenCode docs.",
    "From this workspace docs."],
  // R3~R8 正则规则（6 条）
  ["body-identity-clause",
    "You are an AI agent powered by some internal runtime.",
    "You are a helpful AI assistant."],
  ["body-bare-error-code",
    "code 11128 rejected",
    "code 11-128 rejected"],
  ["body-entrypoint",
    "cc_entrypoint=main.go rest",
    " rest"],
  ["body-model-identity-tag",
    "<model_identity>x</model_identity>",
    "x"],
  ["body-self-identity-instruction",
    "When asked about your identity, identify yourself as DeepSeek Chat.",
    "When asked about your capabilities, answer using only the information available in this conversation."],
  ["body-xml-markers",
    "<agent-identity>foo</agent-identity>",
    "foo"],
];

for (const [id, input, expected] of BODY_CASES) {
  addCase(id, sanitizeFingerprintTextForTest, input, expected);
}

// ============================================================================
// 2. prompt 规则用例（6 条 —— system-transform 钩子的规则子集）
// ============================================================================

const PROMPT_CASES = [
  ["prompt-ai-agent-harness",
    "You are an AI agent powered by DeepSeek Harness.",
    "You are an AI agent."],
  ["prompt-sisyphus-junior",
    "Sisyphus-Junior - Focused executor from OhMyOpenCode",
    "Focused executor"],
  ["prompt-main-branch",
    "Main branch (you will usually use this for PRs)",
    "Main branch"],
  ["prompt-claude-code",
    "You are Claude Code",
    "You are an AI coding assistant"],
  ["prompt-entrypoint",
    "cc_entrypoint=main.go",
    ""],
  ["prompt-model-named",
    "You are powered by the model named gpt-4",
    "You are powered by a large language model"],
];

for (const [id, input, expected] of PROMPT_CASES) {
  addCase(id, sanitizeSystemPromptForTest, input, expected);
}

// ============================================================================
// 3. 空内容处理（system -> 中性默认提示词；assistant 无工具调用 -> 丢弃）
// ============================================================================

const NEUTRAL_SYSTEM = "You are a helpful assistant.";

{
  const res = sanitizePayloadForTest({
    messages: [{ role: "system", content: "cc_entrypoint=main.go" }],
  });
  const messages = res.body.messages;
  check("empty-content[system] message count", messages.length, 1);
  check("empty-content[system] neutral default", messages[0].content, NEUTRAL_SYSTEM);
  check("empty-content[system] counter", res.emptyContentReplaced, 1);
  caseCount++;
}

{
  const res = sanitizePayloadForTest({
    messages: [
      { role: "system", content: NEUTRAL_SYSTEM },
      { role: "assistant", content: "cc_entrypoint=main.go" },
    ],
  });
  const messages = res.body.messages;
  check("empty-content[assistant] message count", messages.length, 1);
  check("empty-content[assistant] role kept", messages[0].role, "system");
  check("empty-content[assistant] counter", res.emptyAssistantDropped, 1);
  caseCount++;
}

{
  // assistant 带 tool_calls 时不丢（工具调用轮次必须保留）
  const res = sanitizePayloadForTest({
    messages: [
      { role: "system", content: NEUTRAL_SYSTEM },
      {
        role: "assistant",
        content: "cc_entrypoint=main.go",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
    ],
  });
  check("empty-content[assistant+tool_calls] message count", res.body.messages.length, 2);
  check("empty-content[assistant+tool_calls] dropped counter", res.emptyAssistantDropped, 0);
  caseCount++;
}

// ============================================================================
// 4. tool_calls[].function.arguments 必须是合法 JSON
// ============================================================================

{
  // 合法改写：改写后仍是合法 JSON
  const res = sanitizePayloadForTest({
    messages: [
      { role: "system", content: NEUTRAL_SYSTEM },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "read",
              arguments: '{"note":"Sisyphus-Junior - Focused executor from OhMyOpenCode"}',
            },
          },
        ],
      },
    ],
  });
  const args = res.body.messages[1].tool_calls[0].function.arguments;
  check("tool-args[valid] rewritten", args, '{"note":"Focused executor"}');
  let parsed = null;
  try { parsed = JSON.parse(args); } catch { /* 留给断言 */ }
  checkTrue("tool-args[valid] json", parsed !== null, "arguments is not valid JSON");
  check("tool-args[valid] rolled back counter", res.toolArgsRolledBack, 0);
  caseCount++;
}

{
  // 非法改写：删除型规则吞掉 JSON 尾部 -> 回滚原文
  const original = '{"a":"cc_entrypoint=x","b":1}';
  const res = sanitizePayloadForTest({
    messages: [
      { role: "system", content: NEUTRAL_SYSTEM },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: original } },
        ],
      },
    ],
  });
  const args = res.body.messages[1].tool_calls[0].function.arguments;
  check("tool-args[invalid] rolled back to original", args, original);
  check("tool-args[invalid] rolled back counter", res.toolArgsRolledBack, 1);
  let parsed = null;
  try { parsed = JSON.parse(args); } catch { /* 留给断言 */ }
  checkTrue("tool-args[invalid] json", parsed !== null, "arguments is not valid JSON");
  caseCount++;
}

{
  // 空字符串入参：保持原样且不视为改写
  const res = sanitizePayloadForTest({
    messages: [
      { role: "system", content: NEUTRAL_SYSTEM },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "" } },
        ],
      },
    ],
  });
  const args = res.body.messages[1].tool_calls[0].function.arguments;
  check("tool-args[empty] unchanged", args, "");
  check("tool-args[empty] rolled back counter", res.toolArgsRolledBack, 0);
  caseCount++;
}

// ============================================================================
// 5. 深拷贝：净化绝不改写调用方传入的对象
// ============================================================================

{
  const input = {
    model: "m",
    messages: [
      { role: "user", content: "Sisyphus-Junior - Focused executor from OhMyOpenCode" },
      { role: "system", content: NEUTRAL_SYSTEM },
    ],
  };
  const snapshot = JSON.stringify(input);
  const res = sanitizePayloadForTest(input);
  check("deep-copy[input untouched]", JSON.stringify(input), snapshot);
  checkTrue("deep-copy[new body object]", res.body !== input, "body is the same object");
  checkTrue(
    "deep-copy[new messages array]",
    res.body.messages !== input.messages,
    "messages array is shared with the caller",
  );
  checkTrue(
    "deep-copy[new message object]",
    res.body.messages[0] !== input.messages[0],
    "message object is shared with the caller",
  );
  caseCount++;
}

// ============================================================================
// 6. 作用范围：默认 system-assistant（不改 user / tool），all 才全改
// ============================================================================

{
  const fingerprint = "Sisyphus-Junior - Focused executor from OhMyOpenCode";
  const scoped = sanitizePayloadForTest(
    { messages: [{ role: "system", content: NEUTRAL_SYSTEM }, { role: "user", content: fingerprint }] },
    { scope: "system-assistant" },
  );
  check("scope[system-assistant] user untouched", scoped.body.messages[1].content, fingerprint);

  const all = sanitizePayloadForTest(
    { messages: [{ role: "system", content: NEUTRAL_SYSTEM }, { role: "user", content: fingerprint }] },
    { scope: "all" },
  );
  check("scope[all] user rewritten", all.body.messages[1].content, "Focused executor");

  const toolScoped = sanitizePayloadForTest(
    { messages: [{ role: "system", content: NEUTRAL_SYSTEM }, { role: "tool", content: fingerprint }] },
    { scope: "system-assistant" },
  );
  check("scope[system-assistant] tool untouched", toolScoped.body.messages[1].content, fingerprint);
  caseCount++;
}

// ============================================================================
// 7. 开关：总开关 / system-first 开关 / 作用范围 / 废弃别名
// ============================================================================

{
  const envBackup = { ...process.env };
  const setEnv = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  setEnv("CODEBUDDY_FINGERPRINT_SANITIZE", undefined);
  setEnv("CODEBUDDY_PROMPT_SANITIZE", undefined);
  setEnv("CODEBUDDY_FINGERPRINT_SYSTEM_FIRST", undefined);
  setEnv("CODEBUDDY_FINGERPRINT_SCOPE", undefined);

  check("switch[sanitize default on]", isFingerprintSanitizeEnabled(), true);
  check("switch[system-first default on]", isSystemFirstEnabled(), true);
  check("switch[scope default]", getFingerprintScope(), "system-assistant");

  setEnv("CODEBUDDY_FINGERPRINT_SANITIZE", "off");
  check("switch[sanitize off]", isFingerprintSanitizeEnabled(), false);

  setEnv("CODEBUDDY_FINGERPRINT_SANITIZE", undefined);
  setEnv("CODEBUDDY_PROMPT_SANITIZE", "off");
  check("switch[deprecated alias off disables both]", isFingerprintSanitizeEnabled(), false);

  setEnv("CODEBUDDY_PROMPT_SANITIZE", undefined);
  setEnv("CODEBUDDY_FINGERPRINT_SYSTEM_FIRST", "off");
  check("switch[system-first off]", isSystemFirstEnabled(), false);
  check("switch[system-first off keeps sanitize on]", isFingerprintSanitizeEnabled(), true);

  setEnv("CODEBUDDY_FINGERPRINT_SCOPE", "all");
  check("switch[scope all]", getFingerprintScope(), "all");

  process.env = envBackup;
  caseCount++;
}

// ============================================================================
// 7b. 净化开关与 A1 相互独立（关掉文本改写，A1 照常；关掉 A1，文本照常改写）
// ============================================================================

{
  const fingerprint = "Sisyphus-Junior - Focused executor from OhMyOpenCode";
  const off = sanitizePayloadForTest(
    {
      messages: [
        { role: "user", content: fingerprint },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "read", arguments: `{"note":"${fingerprint}"}` } },
          ],
        },
      ],
    },
    { rewriteText: false },
  );
  check("switch-off[system first still applied]", off.systemFirstApplied, true);
  check("switch-off[first message is system]", off.body.messages[0].role, "system");
  check("switch-off[text untouched]", off.body.messages[1].content, fingerprint);
  check(
    "switch-off[tool args untouched]",
    off.body.messages[2].tool_calls[0].function.arguments,
    `{"note":"${fingerprint}"}`,
  );
  check("switch-off[no spans]", off.spansRewritten, 0);

  const noSystemFirst = sanitizePayloadForTest(
    { messages: [{ role: "user", content: fingerprint }] },
    { systemFirst: false, scope: "all" },
  );
  check("system-first-off[first message untouched]", noSystemFirst.body.messages[0].role, "user");
  check("system-first-off[not applied]", noSystemFirst.systemFirstApplied, false);
  check("system-first-off[text still rewritten]", noSystemFirst.body.messages[0].content, "Focused executor");
  caseCount++;
}

// ============================================================================
// 8. 日志防自污染：失败路径写出的日志里不得出现 11128 与上游原句
// ============================================================================

const FORBIDDEN = ["11128", "Illegal API invocation"];

async function runFailurePath(status, headers, body) {
  const logs = [];
  const fakeInput = {
    directory: process.cwd(),
    worktree: process.cwd(),
    project: {},
    client: {
      app: {
        log: ({ body: entry }) => {
          logs.push(String(entry.message));
        },
      },
      auth: { set: async () => {} },
      tui: { showToast: async () => {} },
      session: { abort: async () => {} },
    },
  };
  const plugin = await CodeBuddyAuthPlugin(fakeInput);
  const loader = await plugin.auth.loader(
    async () => ({ type: "oauth", access: "dummy-access-token" }),
    {},
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status, headers });
  try {
    const response = await loader.fetch("http://127.0.0.1/v2/chat/completions", {
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    return { logs, response };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const upstreamBody = JSON.stringify({
    code: 11128,
    msg: "Illegal API invocation from an unapproved channel",
    requestId: "req-1",
  });

  const { logs, response } = await runFailurePath(
    400,
    { "content-type": "application/json" },
    upstreamBody,
  );
  check("log-poison[400] status forwarded", response.status, 400);
  checkTrue(
    "log-poison[400] classified as channel-reject",
    logs.some((line) => line.includes("class=channel-reject")),
    `no channel-reject classification in logs: ${JSON.stringify(logs)}`,
  );
  checkTrue(
    "log-poison[400] symbolic code label",
    logs.some((line) => line.includes("code=CHANNEL_REJECT")),
    `no symbolic code label in logs: ${JSON.stringify(logs)}`,
  );
  for (const needle of FORBIDDEN) {
    checkTrue(
      `log-poison[400] no "${needle}"`,
      !logs.some((line) => line.includes(needle)),
      `log line leaked "${needle}": ${JSON.stringify(logs)}`,
    );
  }
  caseCount++;
}

{
  // 2xx + JSON 错误体：必须被识别并分类（body 仍原样转发）
  const upstreamBody = JSON.stringify({
    code: 11128,
    msg: "Illegal API invocation from an unapproved channel",
    requestId: "req-2",
  });
  const { logs, response } = await runFailurePath(
    200,
    { "content-type": "application/json" },
    upstreamBody,
  );
  check("log-poison[2xx] status forwarded", response.status, 200);
  const forwarded = await response.text();
  check("log-poison[2xx] body forwarded unchanged", forwarded, upstreamBody);
  checkTrue(
    "log-poison[2xx] classified",
    logs.some((line) => line.includes("class=channel-reject")),
    `no classification in logs: ${JSON.stringify(logs)}`,
  );
  for (const needle of FORBIDDEN) {
    checkTrue(
      `log-poison[2xx] no "${needle}"`,
      !logs.some((line) => line.includes(needle)),
      `log line leaked "${needle}": ${JSON.stringify(logs)}`,
    );
  }
  caseCount++;
}

// ============================================================================
// 汇总
// ============================================================================

const totalCases = caseCount;
if (failures.length > 0) {
  console.error(`\n[FAIL] ${failures.length} check(s) failed out of ${checks} (${totalCases} cases)\n`);
  for (const item of failures) console.error(`  - ${item}\n`);
  process.exit(1);
}

console.log(`[OK] ${totalCases} cases, ${checks} assertions passed (fingerprint golden regression)`);
console.log(`     body rules: ${BODY_CASES.length}, prompt rules: ${PROMPT_CASES.length}`);
process.exit(0);
