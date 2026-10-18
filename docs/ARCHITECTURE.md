# 架构与维护指南

本文根据当前 `src/` 实现整理，面向修改代码或排查行为差异的维护者。用户向说明以 `README.md` 为准。

## 模块地图

| 模块 | 职责 |
|---|---|
| `src/extension.ts` | 扩展入口、命令注册、启动预热、首次运行引导 |
| `src/codexConfig.ts` | 带 VS Code 设置感知的配置门面 |
| `src/codexConfigFile.ts` | `config.toml` 定位、备份、写入、回滚、当前位置读取 |
| `src/tomlEdit.ts` | 纯函数式按行编辑，不依赖 `vscode` |
| `src/modelList.ts` | 模型发现编排、实时请求、持久缓存、并发合并 |
| `src/modelInfo.ts` | 模型 ID 提取、元数据合并、展示格式 |
| `src/modelsDev.ts` | models.dev 拉取、镜像回退、provider/global 元数据索引 |
| `src/hardcodedModels.ts` | 官方端点表的内置快照 |
| `src/picker.ts` | 原生 QuickPick 选择器与推理强度二级选择 |
| `src/catalog.ts` | Codex 模型目录条目构建与无 BOM 原子写入 |
| `src/catalogSync.ts` | 目录同步、模型应用、`codex doctor` 校验与回滚 |
| `src/codexCli.ts` | Codex 可执行文件探测、`debug models`、`doctor` |
| `src/proxyController.ts` | 本地代理生命周期、设置变更响应、provider 地址切换 |
| `src/proxy/server.ts` | 回环 HTTP 服务、Responses 转发、Chat Completions 转换 |
| `src/proxy/messages.ts` | Anthropic Messages 转换与 thinking 块处理 |
| `src/statusBar.ts` | 合并状态栏项、额度轮询、代理状态与操作入口 |
| `src/goUsage.ts` | `/usage` 拉取、宽容解析、缓存与倒计时格式 |
| `src/apiKey.ts` | SecretStorage、环境变量与终端环境变量辅助 |
| `src/localize.ts` | 以英文原文为键的 zh-CN 字典 |

## 启动流程

1. `activate()` 初始化日志器。
2. 创建状态栏项，启动额度轮询；若代理开启，状态栏保持可见。
3. 注册全部命令。
4. 异步初始化代理：
   - 仅当 `codexgo.proxyEnabled` 为 `true`、已配置 OpenCode Go provider 且存在 API 密钥时自动启动。
   - 启动成功后把 provider 的 `base_url` 改为回环地址。
   - 没有密钥时恢复直连地址并将代理状态设为 `off`。
5. 异步预热模型列表。失败只会降级，不阻塞激活。
6. 首次运行且没有密钥时打开 walkthrough。

## 配置编辑约束

`tomlEdit.ts` 不使用 TOML 解析后再序列化的方式，因为那会破坏注释、格式和未知键。

- 顶层键只扫描第一个表头之前的区域，因此不会误改 `[profiles.*]`。
- 更新已有键时保留缩进和行尾注释。
- 保留原文件主导换行符（CRLF 或 LF）。
- `model` 和 `model_provider` 总会写入。
- `model_reasoning_effort` 仅在调用方提供时处理：`null` 删除，字符串写入，`undefined` 保持原样。
- `model_catalog_json` 只由目录同步或移除目录命令管理。
- 始终写入单个 `[model_providers.opencode-go]`，并删除旧版 `opencode-go-responses` 与 `opencode-go-chat` 块。

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
   - 未知模型默认按 `chat` 处理，并在界面标记为 `assumed protocol`。

并发控制：

- `prepareModelList()` 同一时刻只运行一趟发现流程。
- 正常刷新受 `codexgo.modelsDevUpdateInterval` 限制，最低 30 秒。
- `force: true` 绕过 TTL。
- models.dev 加载失败后至少 60 秒才重试，且不会清掉已有良好缓存。

## 选择器与目录同步

### 扩展选择器

`picker.ts` 直接写 Codex 顶层配置：

- 代理已监听时，`responses`、`chat`、`anthropic` 三类模型都可选。
- 代理未监听时，只允许 `responses` 模型；其他模型归入 `Not usable in the current mode`。
- 写入配置时 `wireApi` 固定为 `responses`，因为 Codex 0.162+ 已移除 `wire_api = "chat"`。
- 推理强度只展示模型声明且扩展支持的档位，不再硬编码四档。
- 选择 `Default` 会删除 `model_reasoning_effort`。
- 扩展选择器只写磁盘配置，不调用 app-server 更新线程；新默认值在新建对话、重启 Codex 或重载窗口后生效。

### Codex 自带选择器

`catalogSync.ts` 通过 `model_catalog_json` 把模型加入 Codex 的 `model/list` RPC：

1. 强制刷新模型列表。
2. 按当前代理状态筛选可用模型。
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

`resolveWireApi()` 先查当前模型列表，再退回内置快照，最后默认 `chat`。

### 认证与请求限制

- 请求必须来自回环地址。
- `Authorization` Bearer 必须与扩展解析出的密钥一致；也接受代理管理的占位值。
- 请求体上限为 32 MiB。
- 非 `responses` 模型不支持远程压缩，`/responses/compact` 或 compaction trigger 返回 `501`。

### Responses 修复

OpenCode Go 的思考模型要求回传原始 `reasoning_text`。Codex 可能只保留 `summary_text` 并把 `content` 设为 `null`，代理会：

- 把 `summary_text` 改成 `reasoning_text`；
- 或在 `content` 为空时从 `summary` 重建 `reasoning_text`。

### Chat 历史恢复

Chat Completions 上游要求 assistant 的 `tool_calls` 与对应 `tool` 结果相邻，并且 thinking 模型通常要求该 assistant 消息带非空 `reasoning_content`。Codex 后续请求可能只发送 `previous_response_id + function_call_output`，因此代理维护一个有界的响应历史缓存：

- 记录代理返回的 `function_call` / `custom_tool_call` 与 reasoning 文本；
- 当请求只带工具结果时，把缺失的 assistant tool call 与 reasoning 插回工具结果之前；
- `reasoning` 项优先前向附挂到下一条 assistant / tool call；
- 只有输入结束或 user 等回合边界到达时，剩余 reasoning 才回挂到最后一条 assistant；
- 最终仍缺 `reasoning_content` 的 assistant tool-call 消息补上占位值，避免上游拒绝整个请求。

### 推理档位映射

Codex 的模型选择器会用内部可见档位列表过滤目录，默认不包含 `max` 和 `minimal`，且默认隐藏 `ultra`。目录同步因此把 `max` 投影到稳定的可见档 `xhigh`，并在模型没有 `low` 时把 `minimal` 映射为 `low`；落到同一槽位的档位会去重。代理收到 `xhigh` 或 `low` 后按模型声明还原为上游 `max` / `minimal`。模型同时声明 `xhigh` 和 `max` 时，用户看到的唯一 `XHigh` 槽位在选择后发送上游 `max`。

## 状态栏与额度

状态栏是单个合并项，命令为 `codexgo.checkUsage`。

- 点击刷新额度。
- 代理开关位于悬停窗口中的 Proxy 区块。
- 正文显示 `codexgo.usageDisplayWindow` 指定的窗口。
- 倒计时每分钟重绘一次，不触发网络请求。
- 颜色取三个窗口中的最差用量，分别受 warning/error 阈值控制。
- 额度缓存 5 分钟；拉取失败保留旧快照。
- HTTP 401 表示没有可用 Go 套餐或密钥无效；其他失败显示通用错误。

## API 密钥

有两个使用方：

1. 扩展自身：优先 SecretStorage，其次 `codexgo.apiKeyEnvVar` 指定的环境变量。
2. Codex：只读取 provider `env_key` 指定的环境变量。

因此保存密钥后仍需让 Codex 进程看到同名环境变量。命令提供 VS Code 终端环境和用户级设置两种辅助方式。

## 测试

| 命令 | 覆盖范围 |
|---|---|
| `npm test` | 编译后运行 TOML、模型合并、目录、额度、Chat 代理、Anthropic 代理测试 |
| `npm run test:e2e` | 本机 Codex CLI + 假上游，验证完整 Responses 桥接 |
| `npm run test:live` | 真实 OpenCode Go，多轮 Codex 对话 |
| `npm run test:binding` | 真实 Anthropic thinking 签名与前缀变化回归 |

`test:live` 和 `test:binding` 需要 `OPENCODE_GO_API_KEY`。`test:e2e` 需要本机 `codex` 可执行文件。

## 已知边界

- TOML 编辑器不跟踪多行字符串，因此多行字符串里看似表头的行可能被误判。Codex 配置通常不包含这种内容。
- 未知模型的协议是启发式推断，界面会标记 `assumed protocol`。
- 新目录或目录内容变化后，Codex app-server 需要重启或重载窗口才能读取。
- 若目录同步在原本没有 `config.toml` 的机器上创建了配置，随后 `codex doctor` 拒绝该配置，当前实现会恢复旧目录，但不会删除这次新建的 `config.toml`。这是一个待修复的回滚边界。
- Chat Completions 与 Anthropic Messages 模型不支持远程压缩。
- 地区限制不是协议属性，模型仍会列出，实际调用时由网关返回错误。
