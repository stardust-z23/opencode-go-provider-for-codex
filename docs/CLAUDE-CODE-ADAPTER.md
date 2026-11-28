# Claude Code 适配需求分析

本文是 `TODO.md` 中 “Claude Code adapter” 一节的展开分析，面向实现者。区别：TODO 是任务清单，本文给出**已验证事实、与现有实现的差距、以及可落地的设计决定**。

结论以 2026-11-28 的实测与官方文档为准；无法实测的部分显式标注为“待验证”。

## 0. 实现状态（2026-11-28）

P0（直通代理）与 P1（设置接管 + picker）已实现并纳入 `npm test`：

| 模块 | 内容 | 测试 |
|---|---|---|
| `src/proxy/messagesNative.ts` | 原生 Messages 直通：四处改写、SSE 字节保真、usage 旁路解析、错误透传、`count_tokens` | `scripts/test-proxy-messages.mjs`（11 例） |
| `src/modelRouting.ts` | `[1m]` 剥离、四档/别名路由、picker 行生成、窗口下限 | `scripts/test-model-routing.mjs`（12 例） |
| `src/claudeSettings.ts` | 设置投影、自有键 diff、归属、三方回滚、墓碑、原子写入与备份 | `scripts/test-claude-settings.mjs`（14 例） |
| `src/claudeCodeCli.ts` | `claude --version` 探测与版本门控 | 同上（版本解析用例） |
| `src/claudeCodeService.ts` | 配置/刷新/恢复/诊断命令、激活时的地址失配提示 | 手工（需 VS Code） |
| `src/proxy/server.ts` | `/v1/messages`、`/v1/messages/count_tokens` 路由、Anthropic 形状 `/v1/models`、本机 `/api/hello`、`x-api-key` 认证 | 同上 |

另外用真实 `~/.claude/settings.json` 的**副本**做了接管 → 回滚演练：写入后除自有键外全部保持，回滚并清墓碑后文档与原文逐字节相等。

仍未完成（见 §5）：thinking 是否对未知 ID 下发、翻译型上游的 thinking 签名回放、`anthropic-beta` 透传兼容性、`modelSettings.autoCompactWindow`、目录变化时自动提醒重建 picker、真实 Claude Code 端到端验收。

## 1. 结论摘要

1. **直通可行，且比现有 Anthropic 转换路径更安全。** OpenCode Go 的 Anthropic 端点会把非 Messages 原生模型翻译成各自的原生 API（`/inference/go/anthropic`），因此 Claude Code 的原始 Messages 请求可以逐字转发，只需要改写 `model`、注入认证与 `x-opencode-session`。不解析 body 就不会丢 `thinking`、`cache_control`、`output_config`、`context_management`、`anthropic-beta` 等字段。
2. **`x-opencode-session` 是硬性要求，不是优化项。** 缺该头的 Go 请求在**认证之前**就被拒绝：`400 {"type":"error","error":{"type":"MissingSessionID",...}}`。Claude Code 原生会带 `x-claude-code-session-id`，代理仍必须解析并注入，否则 Claude Code 一条请求都发不出去。
3. **模型列表不能用网关发现，必须写 `modelPicker`。** 发现接口只保留含 `claude`/`anthropic` 的 ID，Go 目录里符合的只有 `claude-haiku-5-5`。Claude Code ≥ v2.1.242 的 `modelPicker` + `replaceBuiltInOptions: true` 是唯一能列出全部 Go 文本模型的机制。
4. **上下文窗口要处理，但不必写 `behavesAs`。** Go 目录的上下文是 256k–1.05M。Claude Code 对未知 ID 默认假定 1M 并打印 “isn't recognized” 警告；小于 1M 的模型（`hy3` 256k、`iceman-contributor-free` / `kimi-k2.7-code` 262,144、`grok-4.7` 500k）会因此不会及时自动压缩。用 `[1m]` 标记 1M 档 + `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 取非 1M 档的最小窗口，可以用老版本也支持的机制解决；`behavesAs` 会把某个 Claude 模型的能力（含价格、effort 默认值）张冠李戴，建议默认不写。
5. **设置写入是最大的破坏面，必须按 cc-switch 的教训做。** 不能同时写 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY`（Claude Code 会弹自定义密钥确认框 + “Both … set” 警告）；运行中的会话只做 `env` 增量合并，**从文件删键不会撤销进程里的旧值**，要先用空串“墓碑”再删；`modelPicker` 与 env 一样按“启动时读取”处理（这一点尚未单独实测）。

## 2. 已验证事实

### 2.1 端点与认证

| 事实 | 证据 |
|---|---|
| Claude Code 在 `ANTHROPIC_BASE_URL` 后追加 `/v1/messages` | 官方 Harnesses → Claude Code 文档 |
| Go 的 Claude Code base 是 `https://opencode.ai/inference/go/anthropic` | 同上，Go 小节 |
| 官方推荐 `ANTHROPIC_AUTH_TOKEN`（→ `Authorization: Bearer`），并明确说不要用 `ANTHROPIC_API_KEY` | 同上 |
| 上游**同时**接受 `Authorization: Bearer` 与 `x-api-key` | 实测：伪造密钥两种头都返回 `401 Invalid credential`（若头不被识别会落到别的错误） |
| 两条 Messages 路径都存在：`/inference/go/anthropic/v1/messages`（文档地址）与 `/inference/go/v1/messages`（本扩展现有 Anthropic 别名在用） | 实测两者对伪造密钥均返回 `401`，非 `404` |
| `POST /inference/go/anthropic/v1/messages/count_tokens` 存在 | 实测 `401`，非 `404` |
| `GET /inference/go/anthropic/v1/models` 存在 | 实测 `401`（带 Go 前缀的 anthropic 子路径也挂了 models） |
| **`x-opencode-session` 缺失会被硬拒** | 实测：`400 MissingSessionID`，且该检查发生在认证之前 |
| `HEAD /inference/go/anthropic/api/hello` 会挂起（无响应） | 实测 300 秒超时 |
| 每个模型在目录里只列原生 API（`chat-completions` / `responses` / `messages` / `interactions`），但**所有文本模型都能走其它 API 家族，由 Console 翻译** | 官方 Go 文档 “Endpoints” 段 + 目录 `api` 字段对照 |

推论：

- 直通用文档地址 `https://opencode.ai/inference/go/anthropic` + `/v1/messages`；认证发 `Authorization: Bearer`，可再带一份 `x-api-key` 以求兼容（两者都被接受，实测无冲突）。
- `x-opencode-session` 由本机代理解析并注入，绝不能依赖原样透传。
- `/api/hello` 只在本机应答（200/204），绝不转发，否则会占住一个请求槽位直到超时。
- `count_tokens` 和 `models` 都是廉价直通项，不需要本地估算。

### 2.2 模型目录（2026-11-28 快照）

37 个条目，其中文本对话 30 个。原生 API 分布：

| 原生 API | 数量 | 代表 |
|---|---|---|
| `chat-completions` | 20 | `deepseek-v4.1-flash`、`glm-5.3`、`kimi-k3`、`minimax-m3.1-flash` |
| `messages` | 6 | `claude-haiku-5-5`、`minimax-m3`、`qwen3.8-max`、`qwen4-max` |
| `responses` | 5 | `grok-4.7`、`gpt-6-luna`、`muse-spark-*` |
| `interactions` | 1 | `gemini-4-argon` |
| `embeddings` / `systemone` | 3 + 3 | 不可选 |

上下文窗口分布（决定 P2 的窗口策略）：

- `hy3` 256,000
- `iceman-contributor-free`、`kimi-k2.7-code` 262,144
- `grok-4.7` 500,000
- 其余 1,000,000 / 1,048,576 / 1,050,000

### 2.3 Claude Code 侧行为

| 事实 | 证据 |
|---|---|
| `modelPicker` 需 v2.1.242+；`behavesAs` 需 v2.1.257+；`modelSettings.<model>.autoCompactWindow` 需 v2.1.288+；`maxEffortLevel` 需 v2.1.267+ | settings-reference / model-config |
| `modelPicker` 只在 **user / managed / `--settings`** 生效，project 与 local 被忽略；多个来源不合并（高优先级整份胜出） | settings-reference |
| `replaceBuiltInOptions: true` 时只剩配置行列、`Default`、当前会话模型 | settings-reference |
| Claude Code 会**丢弃**无法提供的行、**置灰**暂不可选的行；全部行失效时回退内置列表 | settings-reference |
| 未经识别的模型 ID 会打印 “isn't recognized · context assumed to be 1m tokens” 并按其假定窗口自动压缩 | model-config |
| 未识别且不含 `[1m]` 的 ID：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 直接生效 | model-config |
| 含 `[1m]`（任意大小写）的 ID：假定 1M，低于 1M 的 MAX 不生效；需要 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 才回落到 MAX | model-config |
| 解析到已知 Claude 模型的 ID（含 `claude-*` 前缀，如 `claude-haiku-5-5`）：MAX 需配合 `DISABLE_COMPACT` 才生效 | model-config |
| `modelOverrides` 可把 Claude 模型 ID 映射到供应商 ID；`behavesAs` 对 picker 行做同样的事，但作用于能力与 effort 默认值（价格展示很可能随被模仿模型变化，官方只明确写了能力与 effort） | settings-reference |
| 后台任务用 Haiku 档，子代理用 `CLAUDE_CODE_SUBAGENT_MODEL` | settings-reference / model-config |
| 网关发现需 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`，且丢弃不含 `claude`/`anthropic` 的 ID | llm-gateway-protocol / model-config |

### 2.4 cc-switch 的实测经验（`G:\MyProject\cc-switch`，v4.0.44）

- **运行中的 Claude Code 只把 `settings.json` 的 `env` 增量合并进进程**（`Object.assign(process.env, env)`）。新增、改值下一条请求即生效；**从文件删掉的键留在进程里**。切回官方时必须先写 `""`（墓碑）再删除。
- 在 2.1.318 上逐键实测：`CLAUDE_CODE_DISABLE_THINKING`、`EXTRA_BODY`、`MAX_OUTPUT_TOKENS`、`MAX_CONTEXT_TOKENS`、`AUTO_COMPACT_WINDOW` 等用空串可撤销；`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` 只部分撤销；`ENABLE_TOOL_SEARCH`、`DISABLE_INTERLEAVED_THINKING`、`CLAUDE_CODE_DISABLE_1M_CONTEXT` 是启动期决定，改文件无效。
- 认证占位符**只写 `ANTHROPIC_AUTH_TOKEN`**：写在 `ANTHROPIC_API_KEY` 上会被 Claude Code 当成用户自定义密钥弹确认框（默认拒绝 → 未登录）；两个都写触发 “Both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY set” 警告。
- 网关场景（非官方端点）需要写入 `CLAUDE_CODE_AUTO_MODE_SERVER=0`，否则 auto 权限模式的分类器请求打到不支持它的端点。
- 角色档位除 `ANTHROPIC_DEFAULT_*_MODEL` 外还可写 `*_MODEL_NAME` / `*_MODEL_DESCRIPTION`，让内置选择器显示可读名字。
- 1M 档用 `[1m]` 标记写进模型 ID，代理转发前剥离；`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 取非 1M 档里最小的窗口。
- `modelPicker` 用 `replaceBuiltInOptions: true`，四档别名仍然要写（`Default`、`--model opus`、子代理靠它们）。

本机 `%USERPROFILE%\.claude\settings.json` 是一个真实接管样本：`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`、`ANTHROPIC_AUTH_TOKEN`、四档 `ANTHROPIC_DEFAULT_*_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、`model`、`permissions.additionalDirectories`、`ENABLE_TOOL_SEARCH`。适配器必须能原样备份、只改自有键、并能逐键回滚这份文件。

## 3. 与现有 TODO 的差异

| TODO 现状 | 分析结论 | 处理 |
|---|---|---|
| “OpenCode Go documents that every text model works through its translated Anthropic Messages endpoint” | 已由文档 + 目录 `api` 字段证实 | 改为已验证 |
| 未提 `x-opencode-session` 缺失被硬拒 | 实测 `400 MissingSessionID`，且在认证之前 | 提为 P0 首要项，并加一条“缺头必须报错可读”的测试 |
| “Inject the real OpenCode Go key upstream using the authentication header documented by OpenCode” | 文档写 `Authorization: Bearer`；`x-api-key` 也被接受 | 明确 Bearer 为主，`x-api-key` 兼容 |
| `count_tokens` 列为 P2 “决定是否实现” | 上游存在，直通成本几乎为零 | 降到 P1 “直通实现” |
| `HEAD /api/hello` 列为 P2 “决定是否响应” | 上游会挂起 | 定为“本机应答，绝不转发” |
| 未提上下文窗口的具体机制 | `[1m]` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 可覆盖全部版本；`modelSettings` 仅新版可得 | 新增 P1 项 |
| `behavesAs` 为“optional” | 默认不写更安全；仅在用户显式要求“让 Claude Code 认为这是某个 Claude 模型”时开启 | 默认关闭 |
| 未提认证键冲突 | 两个键不能同时写 | 加入设置契约 |
| 未提热撤销 | 删键对运行中会话无效 | 加入设置契约 |
| 未提 `modelPicker` 的生效时机 | 与 env 一致，按“启动时读取”处理；改 picker 后需重载窗口/新会话（尚未单独实测） | 通知文案要写清楚 |

## 4. 目标设计

### 4.1 三种流量的分流

同一个回环端口同时服务两种客户端，按路径分流，互不干扰：

| 客户端 | 路径 | 处理 |
|---|---|---|
| Codex | `/v1/responses`、`/v1/responses/compact` | 现有三条协议路径，行为不变 |
| Claude Code | `/v1/messages`（忽略 `?beta=true` 等查询串） | 原生 Messages 直通 |
| Claude Code | `/v1/messages/count_tokens` | 原生直通 |
| Claude Code | `GET /v1/models?limit=1000` | 按 `anthropic-version` 头返回 Anthropic 形状 |
| 两者 | `GET /v1/health`、`HEAD /api/hello` | 本机应答 |

Claude Code 的 `ANTHROPIC_BASE_URL` 写 `http://127.0.0.1:<port>`（**不带** `/v1`），Codex 的 `base_url` 继续带 `/v1`。

### 4.2 直通代理的改写规则（仅四处）

1. **`model`**：去空白 → 去 `[1m]`/`[1M]` 后缀 → 若命中角色别名（`opus`/`sonnet`/`haiku`/`fable`/`best`/`opusplan`/`default`）或 `claude-*` 形态但不在 Go 目录中 → 按角色映射到配置的 Go 模型；命中 Go 目录/内置表的 ID → 原样转发；都不命中 → 原样转发，让上游返回可读错误。
2. **认证**：用 SecretStorage 中的真实密钥覆盖 `Authorization: Bearer`（并带 `x-api-key` 以求兼容）；丢弃客户端的派生 token。
3. **`x-opencode-session`**：按 `resolveSessionId()`（已存在）取 `x-claude-code-session-id` → `metadata.user_id` JSON / `_session_` → `metadata.session_id` → 稳定会话指纹；**必须**注入。
4. **User-Agent**：改成扩展 UA（OpenCode 要求客户端自报身份，不能是裸 SDK）。

其余头/字段一律透传，特别是：`anthropic-version`、`anthropic-beta`、`content-type`、`accept`、`x-request-id`、`x-client-request-id`、`x-app`、`x-stainless-*`，以及 body 里的 `system`、`tools`、`tool_choice`、`thinking`、`output_config`、`context_management`、`metadata`、`stop_sequences`、`cache_control`、图片/PDF/`tool_result` 嵌套块。

### 4.3 响应路径

- **SSE**：按字节转发，保留 `event:`/`data:` 帧序、`ping` 与注释帧；同时旁路解析完整块，抓 `message_start.message.usage` 与 `message_delta.usage` 合并成 Responses 形状进本地 usage（复用 `anthropicUsageToResponsesUsage`），并抓 `message_delta.delta.stop_reason`。绝不改写帧内容。
- **JSON**（`stream:false`）：原样透传 body，解析 usage。
- **错误**：状态码 + body 原样透传，并把 body 摘要记进 `proxy.upstream_error`。Claude Code 依赖原始措辞做上下文超限恢复与重试，改写会破坏它。
- **usage 事件**：沿用 `proxy.usage` / `proxy.upstream_error` 两个日志事件与现有字段，`protocol` 记为 `messages`，这样统计面板、缓存命中率、状态栏无需改动。
- **诊断**：每个请求额外记录一份不含正文的能力摘要（`stream`、`tools` 数、`hasThinking`、`thinking.type`、`hasOutputConfig`、`beta` 列表、`image`/`document` 数、`model` 原值与改写后值、`sessionSource`），用于排查“Claude Code 到底有没有发 thinking”。

### 4.4 模型发现与 picker

`modelPicker` 行 = Go 目录里全部文本模型（`isChatModel()`，排除 decision/embedding），一行一个：

```json
{
  "model": "deepseek-v4.1-flash[1m]",
  "label": "DeepSeek V4.1 Flash",
  "description": "OpenCode Go · 1M context · chat"
}
```

- `replaceBuiltInOptions: true`：否则内置 Opus/Sonnet/Haiku 行会把选择器撑成一份与 Go 无关的列表。
- `label` 用官方目录 `name`；`description` 用「OpenCode Go · 上下文 · 原生协议」，一眼能看出走的哪条上游。
- `[1m]` 只加在目录上下文 ≥ 1M 的行上；代理负责剥离。
- **不写 `behavesAs`**（默认）。理由：它会把被模仿 Claude 模型的能力与 effort 默认值套到任意 Go 模型上（价格展示很可能跟着变），而用户看到的 `$` 与订阅制实际计费无关；同时它会掩盖“未知模型”的真实告警。需要时用设置项 `codexgo.claudeCode.behavesAs` 显式开启。
- 一旦存在 picker，就不需要网关发现；`GET /v1/models` 仍按 Anthropic 形状返回同一份列表（供开启发现时使用，并且不影响 picker）。

### 4.5 上下文窗口与输出上限

- 写 `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` = 所选模型中**非 1M 档的最小上下文**（当前是 `hy3` 的 256,000）。含 `[1m]` 的行不受它影响，因此 1M 模型仍按 1M 压缩。**已实现。**
- 版本 ≥ 2.1.288 时，可再给这些 <1M 的模型写 `modelSettings.<id>.autoCompactWindow` 精确值（可选增强）。**未实现。**
- 不写 `CLAUDE_CODE_MAX_OUTPUT_TOKENS`：上游 `limit.output` 差异很大（64k–1M），Claude Code 的默认上限对我们是安全的；需要时留给用户手动设。
- 不写 `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`：默认窗口策略已经是“假定 1M”，关掉主动压缩只会让超限请求打到上游。

### 4.6 设置写入契约（`~/.claude/settings.json`）

**路径解析**：`CLAUDE_CONFIG_DIR` → `settings.json`；否则 `~/.claude/settings.json`（Windows 为 `%USERPROFILE%\.claude\settings.json`）。

**只写自有的键**：

| 位置 | 键 |
|---|---|
| `env` | `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、`CLAUDE_CODE_AUTO_MODE_SERVER`（=0，网关兼容） |
| 顶层 | `modelPicker`、（可选）`modelSettings` |

**禁止**：

- 同时写 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY`。接管时若发现已有 `ANTHROPIC_API_KEY`，先备份其值再删除（记录进归属表以便回滚），否则 Claude Code 会弹自定义密钥确认框。
- 覆盖 `model`、`permissions`、`hooks`、`enabledPlugins`、`statusLine`、marketplaces 等任何非自有键。

**写入流程**（沿用 `codexConfigFile.ts` 的既有约定，JSON 版）：

1. 读取并 `JSON.parse`；失败则中止并提示，绝不覆盖无法解析的文件。
2. 计算目标 JSON；与现状深度相等 → `changed: false`，不写盘不备份。
3. 首次真实改动前复制 `settings.json.bak-<timestamp>`，按 `codexgo.maxBackups` 清理。
4. 同目录写临时文件 → `rename` 原子替换 → 回读校验 `JSON.parse` 成功；失败则用备份还原。
5. 记录归属表（`globalState`）：每个自有键的**原值**（存在/不存在）与写入值；`modelPicker` 原值整份保存。

**回滚**：逐键三方合并——只有“当前值仍等于我们写入的值”的键才回滚；用户期间改过的键保持原样并在结果里列出跳过项。删除类回滚先写 `""`（墓碑），延迟约 3 秒后再删（运行中会话的 `env` 增量合并），并提示“需要重载窗口/新会话”。

### 4.7 命令与设置项

命令（沿用现有命名风格）：

| 命令 | 作用 |
|---|---|
| `codexgo.configureClaudeCode` | 一次完成：校验版本 → 解析路径 → 写 env/picker → 备份 → 提示重载窗口 |
| `codexgo.restoreClaudeCode` | 按归属表逐键回滚（含墓碑），报告跳过项 |
| `codexgo.refreshClaudeCodePicker` | 目录变化后重建 picker（不动其它键） |
| `codexgo.showClaudeCodeDiagnostics` | 代理可达性、设置合法性、picker 版本、会话头/指纹来源、模型映射结果 |

设置项：

| 设置 | 默认 | 说明 |
|---|---|---|
| `codexgo.claudeCode.enabled` | `false` | 是否接管 `~/.claude/settings.json` |
| `codexgo.claudeCode.settingsPath` | 空 | 覆盖默认路径（便携/多配置目录） |
| `codexgo.claudeCode.defaultModel` | 空 | 写入 `ANTHROPIC_MODEL`；空 = 目录里第一个可用的便宜档 |
| `codexgo.claudeCode.haikuModel` | 空 | 写入 `ANTHROPIC_DEFAULT_HAIKU_MODEL`（后台任务） |
| `codexgo.claudeCode.subagentModel` | 空 | 写入 `CLAUDE_CODE_SUBAGENT_MODEL` |
| `codexgo.claudeCode.roleModels` | 空 | 可选，一次配置 opus/sonnet/fable 三档 |
| `codexgo.claudeCode.replaceBuiltInPicker` | `true` | 对应 `replaceBuiltInOptions` |
| `codexgo.claudeCode.useBehavesAs` | `false` | 是否给 picker 行写 `behavesAs` |
| `codexgo.claudeCode.profile` | 空 | 共享 CLI 与 VS Code 扩展的同一份设置，不需要区分；此项目前仅作命名占位 |

### 4.8 版本检测与降级

用 `claude --version`（PATH 或 `codexgo.claudeExecutable`）解析语义版本：

| 检测结果 | 行为 |
|---|---|
| ≥ 2.1.242 | 写 `modelPicker` |
| < 2.1.242 或不可探测 | 不写 picker；只写 env 四档 + 默认模型，并在通知里说明“选择器会是内置列表，但每个 Claude 档位都路由到 Go 模型” |
| ≥ 2.1.257 | `useBehavesAs` 才允许生效 |
| ≥ 2.1.288 | 才写 `modelSettings.autoCompactWindow` |

角色映射是这套降级能成立的原因：即使选择器里是 Claude 内置模型，代理也会把它按角色改写到配置的 Go 模型。

## 5. 待验证风险（实现顺序按此排）

1. **未知 ID 是否带 thinking。** Claude Code 是否对未经识别的模型发送 `thinking` / `output_config.effort`？若不发，推理模型的 reasoning 就完全看不到。必须用真实流量确认（我们的能力摘要日志就是为它准备的）。若确实不发，解决方案是给对应行加 `behavesAs`（需 2.1.257+）或写 `modelSettings.effortLevel`。
2. **thinking 签名回放。** 翻译型上游（chat/responses 原生模型）返回的 `thinking` 块是否带可回放的签名？第二轮带工具调用时会不会报签名无效？这是直通方案最大的未知（我们的现有 Anthropic 转换路径用自造 `codexgo-anthropic-thinking-v*` 信封绕过过同类问题，直通时该信封机制不适用）。
3. **`anthropic-beta` 透传。** 网关是否拒绝它不认识的 beta（例如 `context-1m-2025-08-07`、`interleaved-thinking-*`）？若拒绝，需要一张可配置的剥离表。
4. **`[1m]` 与实际窗口。** `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` 的用户会把 `[1m]` 行的窗口压到 MAX，需要确认降级后的行为可接受。
5. **picker 掉行。** Go 的 `claude-haiku-5-5` 会被 Claude Code 解析成已知模型；其余行是未知 ID，需确认不会因“org 无权限”之类判断被丢弃。
6. **`count_tokens` 语义。** 直通是否返回 Claude Code 期望的 Anthropic 形状（直通应该天然满足，需跑一次）。

## 6. 测试矩阵

| 层 | 用例 |
|---|---|
| 单元（纯 Node） | `[1m]` 剥离；角色别名 → Go 模型；未知 ID 原样；设置三方合并（写入/回滚/用户期间改动跳过）；墓碑写入时机；JSON 备份与原子替换；picker 行生成（含 `[1m]` 与 MAX 计算） |
| 代理（假上游） | 认证头与派生 token；缺 `x-opencode-session` 时注入、上游 400 时透传；SSE 帧序 + `ping` 保真；JSON 直通；错误透传（400/429/529）；usage 汇总（含 cache_read/cache_creation）；`count_tokens` 直通；`GET /v1/models` 按 `anthropic-version` 返回 Anthropic 形状；`HEAD /api/hello` 本机应答 |
| 设置（临时目录） | 保留 `hooks`/`permissions`/`enabledPlugins`/未知键；已有 `ANTHROPIC_API_KEY` 的处理；`CLAUDE_CONFIG_DIR`；不可解析文件的拒绝；幂等（同值不写盘） |
| 实测（`npm run test:claude-code`） | Claude Code CLI 两轮对话 + 工具调用 + 图片 + PDF；thinking 开/关；模型切换；会话头稳定性；`/status` 确认 base URL；与 Codex 同时运行互不影响 |
| 回归 | 现有 `npm test`（Codex 三条协议路径）+ 缓存前缀不变 |

## 7. 实施顺序（文件级）

### P0 — 代理直通（可独立验证，不碰用户配置）

1. `src/proxy/messagesNative.ts`（新）：`proxyNativeMessages()` —— 路由、四种改写、SSE/JSON 透传、usage 旁路解析、错误透传。
2. `src/proxy/server.ts`：`handleProxyRequest` 增加 `/messages`、`/v1/messages`、`/messages/count_tokens` 分支；`GET /v1/models` 按 `anthropic-version` 返回 Anthropic 形状；`HEAD /api/hello` 本机应答；`isAuthorized` 同时接受 `x-api-key`。
3. `src/modelRouting.ts`（新，纯函数）：`[1m]` 剥离、角色别名、Go 目录判定、未知 ID 透传。
4. `src/proxyController.ts`：新增 `resolveMessagesModel()`（复用 `ensureOfficialCatalogLoadedOnce` + `HARDCODED_GO_MODELS` + 角色设置）。
5. `scripts/test-proxy-messages.mjs`（新）挂进 `npm test`。

### P1 — 设置与 picker

6. `src/claudeSettings.ts`（新，纯 Node）：路径解析、读取/校验、键集合、深度 diff、原子替换、备份/清理。
7. `src/claudeCodeService.ts`（新）：接管/回滚/重建 picker、归属表、版本检测、墓碑调度。
8. `src/localize.ts` + `package.nls*.json` + `package.json`：命令、设置项、通知文案（中英）。
9. `src/extension.ts`：注册命令；`activate()` 时若 `claudeCode.enabled` 且代理就绪则对账一次（幂等）。
10. `docs/ARCHITECTURE.md` / `README.md` / `TODO.md`：模块地图、命令表、边界说明。

### P2 — 诊断与打磨

11. usage 面板按协议区分（`messages` / `responses` / `chat`），Claude Code 流量可单独筛选。
12. 目录变化通知里附带“重建 Claude Code picker”动作。
13. 设置写入前的预览（Webview 或 diff 文本），让用户先看到将要改哪些键。

## 8. 参考

- OpenCode Go（端点、会话要求、隐私限制）：https://opencode.ai/docs/console/go/
- OpenCode Harnesses → Claude Code：https://opencode.ai/docs/console/harnesses/claude-code/
- Console Inference API（端点表、认证、成本字段）：https://opencode.ai/docs/console/api/inference/
- Claude Code settings reference（`modelPicker`、`modelOverrides`、`modelSettings`）：https://code.claude.com/docs/en/settings-reference
- Claude Code model config（`[1m]`、`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、未知模型窗口）：https://code.claude.com/docs/en/model-config
- cc-switch（同类实现的实测经验）：`G:\MyProject\cc-switch`
  - `src-tauri/src/live/project/claude.rs`：settings 投影、热撤销墓碑、认证键冲突
  - `src-tauri/src/proxy/forwarder/opencode.rs`：`x-opencode-session` 与会话指纹
  - `src-tauri/src/proxy/model_mapper.rs`：角色档位映射、`[1m]` 剥离
  - `src-tauri/src/mode/controller.rs`：`modelPicker` + `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
