# 架构与维护指南

本文根据当前 `src/` 实现整理，面向修改代码或排查行为差异的维护者。用户向说明以 `README.md` 为准。

## 模块地图

| 模块 | 职责 |
|---|---|
| `src/extension.ts` | 扩展入口、命令注册、首次运行引导 |
| `src/codexConfig.ts` | 带 VS Code 设置感知的配置门面 |
| `src/codexConfigFile.ts` | `config.toml` 定位、备份、写入、回滚、当前位置读取 |
| `src/tomlEdit.ts` | 纯函数式按行编辑，不依赖 `vscode` |
| `src/modelList.ts` | 模型发现编排、实时请求、持久缓存、并发合并 |
| `src/modelInfo.ts` | 模型 ID 提取、元数据合并、展示格式 |
| `src/modelsDev.ts` | models.dev 拉取、镜像回退、provider/global 元数据索引 |
| `src/hardcodedModels.ts` | 官方端点表的内置快照 |
| `src/protocolVariants.ts` | 多协议模型的 Codex 别名与基础模型映射 |
| `src/catalog.ts` | Codex 模型目录条目构建与无 BOM 原子写入 |
| `src/catalogSync.ts` | 目录同步、模型应用、`codex doctor` 校验与回滚 |
| `src/codexCli.ts` | Codex 可执行文件探测、`debug models`、`doctor` |
| `src/proxyController.ts` | 常驻本地代理生命周期、provider token 轮换与端口切换 |
| `src/proxy/server.ts` | 回环 HTTP 服务、Responses 转发、Chat Completions 转换 |
| `src/proxy/messages.ts` | Anthropic Messages 转换与 thinking 块处理 |
| `src/statusBar.ts` | 套餐额度状态栏项与轮询 |
| `src/goUsage.ts` | `/usage` 拉取、宽容解析、缓存与倒计时格式 |
| `src/usageStats.ts` | 不依赖 `vscode` 的 usage 归一化、聚合、趋势和缓存骤降判定 |
| `src/usageStore.ts` | 30 天 JSONL 持久化、内存索引、轻量清理与缓存状态汇总 |
| `src/usagePanel.ts` | 使用统计 Webview、筛选、维护菜单与消息桥 |
| `src/usageService.ts` | 当前扩展实例的 usage store 单例 |
| `src/apiKey.ts` | SecretStorage 与旧环境变量的一次性迁移 |
| `src/localize.ts` | 以英文原文为键的 zh-CN 字典 |

## 启动流程

1. `activate()` 初始化日志器与 usage store。
2. 创建状态栏项并启动额度轮询。
3. 注册全部命令和使用统计面板命令。
4. 异步初始化常驻代理：
   - 已配置 OpenCode Go provider 且存在 API 密钥时自动启动。
   - 旧版通过环境变量提供的密钥会先迁移到 SecretStorage。
   - 启动成功后把 provider 的 `base_url` 和派生 bearer token 写入配置。
5. 首次运行且没有密钥时打开 walkthrough。模型发现只在用户执行目录同步时运行。

## 配置编辑约束

`tomlEdit.ts` 不使用 TOML 解析后再序列化的方式，因为那会破坏注释、格式和未知键。

- 顶层键只扫描第一个表头之前的区域，因此不会误改 `[profiles.*]`。
- 更新已有键时保留缩进和行尾注释。
- 保留原文件主导换行符（CRLF 或 LF）。
- `model` 和 `model_provider` 由目录同步在需要应用默认模型时写入。
- `model_reasoning_effort` 已不再由扩展写入；现有值会保持原样。
- `model_catalog_json` 只由目录同步或移除目录命令管理。
- 始终写入单个 `[model_providers.opencode-go]`；正常路径写入派生的 `experimental_bearer_token`，并删除旧版 `env_key`、`opencode-go-responses` 与 `opencode-go-chat` 块。

`codexConfigFile.updateConfigText()` 的行为：

1. 读取旧文本；文件不存在时按空文本编辑。
2. 若新文本与旧文本相同，返回 `changed: false`，不写盘、不备份。
3. 文件已存在时先复制为 `config.toml.bak-<timestamp>`。
4. 写入后按 `codexgo.maxBackups` 清理旧备份。

## 模型发现

模型 ID 和元数据来自不同来源：

1. **模型 ID**
   - 有密钥时请求 `/inference/go/v1/models`。
   - 请求失败后使用本次进程内的上次成功结果，或 `globalState` 中 14 天内的持久化结果。
   - 仍无 ID 时使用 models.dev 的 `opencode-go` provider 模型。
   - 最后使用 `hardcodedModels.ts` 的内置快照。
2. **元数据**
   - 内置表优先决定已知协议和免费标记。
   - models.dev 的 provider 条目优先于全局短 ID 条目，提供名称、上下文长度、价格、推理强度、视觉和弃用状态。
   - 未知模型默认按 `chat` 处理。

并发控制：

- 完整 `prepareModelList()` 只由手动目录同步触发，同一时刻只运行一趟。
- 目录同步使用 `force: true`，因此每次都会请求实时模型列表。
- `codexgo.modelsDevUpdateInterval` 只控制 models.dev 元数据缓存，最低 30 秒。
- 代理路由只调用 `ensureCatalogLoadedOnce()` 读取一次元数据，不触发实时模型列表或周期性刷新。
- models.dev 加载失败后至少 60 秒才重试，且不会清掉已有良好缓存。

## 模型选择与目录同步

扩展不再提供自己的 QuickPick。模型选择统一由 Codex 自带的选择器完成，扩展只负责生成目录并在需要时应用一个可用的默认模型。

### Codex 自带选择器

`catalogSync.ts` 通过 `model_catalog_json` 把模型加入 Codex 的 `model/list` RPC：

1. 强制刷新模型列表。
2. 使用常驻代理支持的全部模型；DeepSeek 会额外展开成 Chat Completions、Responses 与 Anthropic Messages 三个目录条目。
3. 从本机 `codex debug models` 选一条结构完整、优先为经典 Responses 传输的模板。
4. 克隆模板并覆盖模型字段。
5. 剥离第一方专属传输字段：
   - `use_responses_lite` 置为 `false`
   - `experimental_supported_tools` 置为空数组
   - 删除 `tool_mode`、`multi_agent_*`、`node_repl_*`
6. 写入 `<CODEX_HOME>/opencode-go-models.json`，然后设置 `model_catalog_json`。
7. 保留当前模型（若仍可用），否则选择第一个可用模型。
8. 运行 `codex doctor`。失败时恢复旧目录文件；若同步前存在 `config.toml`，也恢复旧配置。

`model_catalog_json` 是替换 Codex 内置列表，而不是追加。因此目录里只有 OpenCode Go 模型。

Codex 自带选择器会通过 app-server 更新当前线程，因此已列出的模型和推理档位可以在现有会话中实时切换；只有目录内容变化才需要重启 Codex 或重载窗口。

## 本地代理

代理只监听 `127.0.0.1`，并拒绝非回环来源。默认端口 `15722`，路径前缀为 `/v1`。

### 路由

| 模型协议 | 上游路径 | 处理 |
|---|---|---|
| `responses` | `/responses` | 修复 `summary_text` / `reasoning_text` 后原样流式转发 |
| `chat` | `/chat/completions` | 请求与 SSE 响应双向转换，包括工具调用 |
| `anthropic` | `/messages` | 请求与 SSE 响应双向转换，包括 thinking 块与工具调用 |

`resolveModelRoute()` 先查当前模型列表，再退回协议别名表和内置快照，最后默认 `chat`。若命中别名，路由同时返回 `upstreamModelId`，代理会在转发前把上游 `model` 从别名改回基础模型 ID。

DeepSeek 的别名规则定义在 `protocolVariants.ts`：

- 基础 ID：`deepseek-v4.1-flash`、`deepseek-v4-pro`，保持 Chat Completions。
- Responses 别名：`deepseek-v4.1-flash-responses`、`deepseek-v4-pro-responses`。
- Anthropic 别名：`deepseek-v4.1-flash-anthropic`、`deepseek-v4-pro-anthropic`。

这些别名经过真实 Codex 两轮对话和 shell 工具调用验证。OpenCode Go 尚未实现 DeepSeek 的 `/responses/compact`，因此 Responses 别名不能用于远程压缩。

### 认证与请求限制

- 请求必须来自回环地址。
- `Authorization` Bearer 必须与从上游密钥派生出的本地代理 token 一致。
- 转发到 OpenCode Go 时，代理用 SecretStorage 中的真实上游密钥重写 `Authorization`。
- 请求体上限为 32 MiB。
- 非 `responses` 模型不支持远程压缩，`/responses/compact` 或 compaction trigger 返回 `501`；DeepSeek 的 Responses 别名也会被上游以 `404` 拒绝。

### Responses 修复

OpenCode Go 的思考模型要求回传原始 `reasoning_text`。Codex 可能只保留 `summary_text` 并把 `content` 设为 `null`，代理会：

- 把 `summary_text` 改成 `reasoning_text`；
- 或在 `content` 为空时从 `summary` 重建 `reasoning_text`。

工具调用历史还会经过 `call_id` 归一化。Codex 可能回放上游曾经返回的空 `call_id`；OpenCode Go 会在推理前用 `input[N].call_id: expected a non-empty string` 拒绝整个请求。代理按 function / custom / local shell / computer 工具族匹配调用项与结果项：优先沿用已有的有效 ID；真正成对的空 ID 调用/结果使用由条目内容派生的确定性 `call_...` ID。不能使用随机 UUID，否则同一段历史在后续请求中会得到不同 ID，导致整段前缀缓存失效。

新版 Codex Desktop 还可能注入没有对应 `function_call` 的 `function_call_output`，例如 `codex_apps_open_page` / `codex_apps_selected_page_part_*` 页面快照。代理不会给这类孤儿结果伪造工具 ID，而是暂存到当前工具结果批次结束后，降级为带 `[tool result without a matching tool call]` 标记的普通 user 消息，保留内容并避免生成非法 `tool, user, tool` 顺序。该策略参考 cc-switch 的 `codex_chat_tool_history` / `transform_codex_chat` 实现。

### Chat 历史恢复

Chat Completions 上游要求 assistant 的 `tool_calls` 与对应 `tool` 结果相邻，并且 thinking 模型通常要求该 assistant 消息带非空 `reasoning_content`。Codex 后续请求可能只发送 `previous_response_id + function_call_output`，因此代理维护一个有界的响应历史缓存：

- 保存代理返回的完整响应项，包括 `function_call` / `custom_tool_call`、assistant 内容和 reasoning 文本；
- 后续请求只有 `previous_response_id` 和新输入时，先恢复完整的上一轮 assistant 输出；
- 当请求只带工具结果时，把缺失的 assistant tool call 与 reasoning 插回工具结果之前；
- `reasoning` 项优先前向附挂到下一条 assistant / tool call；
- 只有输入结束或 user 等回合边界到达时，剩余 reasoning 才回挂到最后一条 assistant；
- 只要请求携带 tools，DeepSeek thinking 模式要求每个历史 assistant 消息都带 `reasoning_content`，包括没有工具调用的轮次。代理优先从上一轮响应缓存恢复真实 reasoning，包括 Codex 只重放工具调用、漏掉 reasoning 项的情况；原始文本确实不可得时补空字符串 `""`。空字符串是社区实测可被 DeepSeek 接受的字段占位，不构成伪造思考内容。
- 其他 Chat 模型缺少工具调用轮次的 reasoning 时继续使用兼容占位；DeepSeek 不使用 `"tool call"` 之类的伪 reasoning 文本。

### 推理档位映射

Codex 的模型选择器会用内部可见档位列表过滤目录，默认不包含 `max` 和 `minimal`，且默认隐藏 `ultra`。目录同步因此把 `max` 投影到稳定的可见档 `xhigh`，并在模型没有 `low` 时把 `minimal` 映射为 `low`；落到同一槽位的档位会去重。代理收到 `xhigh` 或 `low` 后按模型声明还原为上游 `max` / `minimal`。模型同时声明 `xhigh` 和 `max` 时，用户看到的唯一 `XHigh` 槽位在选择后发送上游 `max`。

## 状态栏、额度与使用统计

状态栏显示套餐额度和当前会话缓存命中率；点击命令为 `codexgo.openUsageDashboard`，额度刷新命令仍为 `codexgo.checkUsage`。

- 正文显示 `codexgo.usageDisplayWindow` 指定的窗口。
- 倒计时每分钟重绘一次，不触发网络请求。
- 颜色取三个窗口中的最差用量，分别受 warning/error 阈值控制。
- 额度缓存 5 分钟；拉取失败保留旧快照。
- HTTP 401 表示没有可用 Go 套餐或密钥无效；其他失败显示通用错误。
- 状态栏缓存百分比取最近成功请求的“会话 + 模型”分组，按 Token 加权聚合；无法取得会话头时回退到该模型最近 1 小时。
- 悬停操作与 Webview 顶部 `...` 菜单保留设置 API 密钥、获取密钥、同步/移除模型目录、打开配置/设置和重新加载窗口。

使用统计只采集经本地代理转发并返回 usage 的推理请求，以及上游 HTTP 错误：

- 记录模型、稳定会话头、Tokens、缓存、总耗时和状态；不保存 prompt、响应正文或工具结果。
- 输入按 OpenAI `total input includes cache` 与网关 `input is fresh` 两种实际形态归一化；真实总 Tokens = 新增输入 + 缓存命中 + 缓存写入 + 输出。
- 缓存命中率 = 缓存命中 ÷（新增输入 + 缓存命中 + 缓存写入）。
- 同一会话、同一模型中，前次缓存命中至少 50,000、当前下降到一半以下且绝对减少至少 32,000 时标记“疑似缓存骤降”。
- 按日保存为 `<globalStorage>/usage/YYYY-MM-DD.jsonl`，加载最近 7 天，磁盘最多保留 30 天或 50 MB。
- Webview 使用原生 HTML/CSS/JS，无前端框架；请求表每页固定 20 条，通过 offset/limit 查询全部匹配记录。
- 新 usage 写入和额度状态变化会通过扩展内事件推送到 Webview；顶部立即刷新按钮强制重载本地 JSONL 统计并刷新 Go 额度。
- 时间筛选包含最近 1 小时、过去 4 小时、今天、昨天和最近 7 天；“昨天”按本地自然日边界计算。

## 响应元数据

- 原生 Responses 的 `response.completed` / `response.incomplete` usage 原样透传。
- Chat Completions 会请求 `stream_options.include_usage`，并把 `prompt_tokens` / `completion_tokens`、缓存 token 与 reasoning token 换算成 Responses `usage`。
- Anthropic Messages 会合并 `message_start` 与 `message_delta` 的 usage，并换算成同一结构。
- Codex 因此可以获得每轮 input/output/total token 数。代理同时记录每个上游请求的 trace、会话头、耗时和 usage；扩展持久化最近 30 天的轻量统计，但不记录首 token 延迟或 tokens/s。

## 多窗口与端口

- 每个 VS Code 窗口都会激活扩展并尝试绑定 `127.0.0.1:15722`。
- 第一个窗口成功监听；后续窗口记录 `EADDRINUSE`，但只要首个窗口仍在运行，所有窗口仍可通过同一个代理 URL 和派生 token 正常推理。
- 非持有窗口的 `isProxyActive()` 为 false，因此依赖该判断的扩展命令（例如目录同步）可能显示代理不可用；这些操作应在持有窗口执行。
- 当前没有 leader election 或自动接管。持有端口的窗口关闭后，其他窗口会保持 `error` 状态，需要重载窗口或触发会调用 `ensureProxyStarted()` 的操作。
- 使用独立 VS Code profile 和不同的 `codexgo.proxyPort` / `codexgo.codexHome` 时，各扩展实例可以各自持有代理。

## API 密钥

- 上游 OpenCode Go 密钥只保存在 SecretStorage。
- Codex 使用 provider 中的 `experimental_bearer_token` 访问本机代理。
- 该 token 是对上游密钥做 HMAC-SHA256 派生得到的低价值凭据，只对回环代理有效。
- 旧安装中的 `OPENCODE_GO_API_KEY` 环境变量只作为一次性迁移来源，发现后会复制到 SecretStorage。

## 测试

| 命令 | 覆盖范围 |
|---|---|
| `npm test` | 编译后运行 TOML、模型合并、目录、额度、Chat 代理、Anthropic 代理测试 |
| `npm run test:e2e` | 本机 Codex CLI + 假上游，验证完整 Responses 桥接 |
| `npm run test:live` | 真实 OpenCode Go，多轮 Codex 对话 |
| `npm run test:binding` | 真实 Anthropic thinking 签名与前缀变化回归 |

`test:live` 和 `test:binding` 需要 `OPENCODE_GO_API_KEY`。`test:e2e` 需要本机 `codex` 可执行文件。

## 已知边界

- 当前正常路径要求本地代理常驻；为彻底摆脱用户级环境变量，已移除直连与代理开关。
- TOML 编辑器不跟踪多行字符串，因此多行字符串里看似表头的行可能被误判。Codex 配置通常不包含这种内容。
- 未知模型的协议是启发式推断，界面会标记 `assumed protocol`。
- 新目录或目录内容变化后，Codex app-server 需要重启或重载窗口才能读取。
- 若目录同步在原本没有 `config.toml` 的机器上创建了配置，随后 `codex doctor` 拒绝该配置，当前实现会恢复旧目录，但不会删除这次新建的 `config.toml`。这是一个待修复的回滚边界。
- Chat Completions 与 Anthropic Messages 模型不支持远程压缩。
- 地区限制不是协议属性，模型仍会列出，实际调用时由网关返回错误。
