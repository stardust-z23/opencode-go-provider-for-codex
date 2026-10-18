# 更新日志

## 0.1.6 (2026-10-19)

- **文档：整理 GitHub 首页与维护说明。** README 保持快速开始简短，详细命令、配置、代理和排查说明继续放在可展开区域；补充扩展选择器与 Codex 自带选择器的生效边界，明确扩展选择器写入的是后续对话默认值，当前会话实时切换应使用 Codex 自带选择器。
- **文档：去重并校正模型与地区限制说明。** 更新架构文档、引导页和中英文文案，使目录同步、推理档位映射、代理路由与当前实现保持一致。

## 0.1.5 (2026-10-19)

- **修复：重启后 Codex 自带选择器又只剩两档。** Codex 默认隐藏 `ultra`，因此 0.1.4 生成的 `max -> ultra` 映射虽然写入了目录，却会在选择器渲染时被过滤。现在统一把上游 `max` 投影到默认可见且稳定的 `XHigh`，重复槽位会去重；本地代理再把 `xhigh` 还原为上游 `max`。模型同时声明 `xhigh` 和 `max` 时，唯一的 `XHigh` 槽位代表上游 `max`。
- **同步完善 `minimal` 映射。** 模型没有 `low` 时继续把 `minimal` 投影为 `Low`，代理在请求时还原为上游 `minimal`，并补充 Chat 代理的映射测试。

## 0.1.4 (2026-10-18)

- **改进：使用 Codex 的更高可见档位完成映射。** 目录同步现在把上游 `max` 映射为 Codex 可见的 `ultra`，这样同时声明 `xhigh` 和 `max` 的模型也能保留两个独立槽位；当模型没有 `low` 时，把 `minimal` 映射为 `low`。本地代理再把 `ultra` / `low` 还原为上游 `max` / `minimal`。

## 0.1.3 (2026-10-18)

- **修复：Codex 自带选择器看不到 `Max`。** Codex 的内部可见档位列表默认不包含 `max`，导致 OpenCode Go 目录里声明的 `max` 被过滤。现在目录同步会把「上游只声明 `max`、未声明 `xhigh`」的模型映射为 Codex 可见的 `xhigh`；本地代理再把 `xhigh` 还原为上游 `max`。模型如果同时声明 `xhigh` 和 `max`，则保留两者，不会把不同档位挤成一个。

## 0.1.2 (2026-10-18)

- **修复：模型推理档位只显示到 `high`。** 扩展选择器此前把可选档位硬编码为 `minimal` / `low` / `medium` / `high`，导致 models.dev 返回的 `max`、`xhigh`、`ultra` 被过滤掉。例如 OpenCode Go 的 `deepseek-v4.1-flash` 实际支持 `low` / `high` / `max`，界面却只显示到 `high`。现在选择器直接使用模型声明的档位，目录同步在模板默认值不可用时也会回落到已声明的最高档。

## 0.1.1 (2026-10-18)

- **修复：thinking 模型的 `reasoning_content` 跨轮丢失。** Codex 后续请求可能只带 `previous_response_id + function_call_output`，或把 `reasoning` 项排在 assistant 消息 / 工具输出之后；旧代理会丢掉真实思考，或把没有 `reasoning_content` 的 `tool_calls` 消息发给上游，触发 `The reasoning_content in the thinking mode must be passed back to the API`。本地代理现在维护有界的 Codex Chat 历史缓存，在缺少工具调用时恢复原始 `function_call` 与 reasoning；pending reasoning 会前向附挂到下一条 assistant / tool call，真正尾随的 reasoning 回挂到上一条 assistant，并在回合边界消费而不会泄漏到下一轮。作为跨轮恢复失败时的最终兜底，缺少思考内容的 assistant tool-call 消息会补上占位 `reasoning_content`。
- **文档：按当前实现重写。** README、引导页和设置说明现在区分原生 Responses、经本地代理的 Chat Completions / Anthropic Messages、目录同步与模型选择各自的写入范围；同时补充状态栏点击行为、测试矩阵、离线降级链和回滚边界。新增 `docs/ARCHITECTURE.md`，记录模块地图、启动流程与代理路由。

- **状态栏额度显示（样式参考 OpenCode Go Monitor）。** 新增 `GET <base>/usage` 额度拉取：缓存 5 分钟，失败时沿用旧缓存，HTTP 401 表示该密钥没有可用的 Go 套餐。状态栏新增一个额度项，正文形如 `OC Go Rolling: 2% · 4h 52m`；悬停用 Markdown 表格列出滚动 / 周 / 月三个窗口的进度条、百分比与重置倒计时，并显示最近更新时间——表格按列对齐，进度条不会因标签长短而错位，也不会出现等宽代码块里 `█`/`░` 字高不一致的问题。配色取三个窗口中最差的用量：达到 `codexgo.usageWarningThreshold`（默认 80）变黄，达到 `codexgo.usageErrorThreshold`（默认 95）变红；正文显示哪个窗口由 `codexgo.usageDisplayWindow` 决定，轮询间隔由 `codexgo.usageRefreshInterval` 控制（默认 5 分钟），`codexgo.showUsage` 可整体关闭。未配置密钥 / 密钥被拒 / 端点异常时分别显示 `OC Go: add API key` / `OC Go: invalid key` / `OC Go: error`，点击即可设置密钥或重试；另新增命令「查看 OpenCode Go 额度」。
- **清理无用代码。** 删除未被引用的 `lastApiFetchFailed()`、`isCatalogLoaded()`，以及 `extension.ts` 中未使用的 `l10n` 导入。
- **修复：模型只输出纯文本、不调用工具。** 目录条目克隆自 Codex 自带条目（`codex debug models`），而在 Codex 0.162 上第一条可用条目是第一方 GPT-6 条目：`use_responses_lite: true` 会把工具定义从请求顶层的 `tools` 数组搬进 `additional_tools` 输入项，而该格式只有 OpenAI 自家后端会读；`tool_mode: "code_mode_only"` 则把真实工具换成单个自由格式的 JS `exec` 工具。第三方网关（如 OpenCode Go）两者都不认，模型因此收不到任何工具，只能把调用语法当普通文本输出（DeepSeek 会把原始的工具调用标记直接泄漏进正文）。现在生成的条目一律使用经典 Responses 传输：强制关闭 `use_responses_lite`、清空 `experimental_supported_tools`，并移除第一方专属的 `tool_mode` / `multi_agent_*` / `node_repl_*` 字段；模板挑选也会优先选择经典传输的条目（当本机 Codex 提供时）。受影响的目录请重新执行「将 OpenCode Go 模型同步到 Codex」重新生成。
- **OpenCode Go 模型进入 Codex 自带的选择器。** 新增命令「将 OpenCode Go 模型同步到 Codex」：拉取实时模型列表，保留原生 Responses 模型，并在本地代理运行时同时保留 Chat Completions 与 Anthropic Messages 模型；用本机 Codex 自带的一条已知可用条目（`codex debug models`）构建模型目录，写到 `config.toml` 同目录，并让顶层 `model_catalog_json` 指向它。若当前模型仍可用则保留，否则应用第一个可用模型。不做探测、不发推理请求：协议信息来自模型列表与内置端点表。`model_catalog_json` 是替换而非追加 Codex 内置列表。`codex doctor` 检查失败时会恢复旧目录，并在同步前存在 `config.toml` 时恢复旧配置。
- **协议映射以官方端点表为准。** 内置快照把 Grok、Luna、Muse Spark 等标为原生 Responses；DeepSeek、GLM、Kimi 等 Chat Completions 模型经本地代理解析；Qwen 3.6+、MiniMax、Claude 等 Anthropic Messages 模型也经本地代理使用。未知模型的协议是启发式推断，选择器会标记 `assumed protocol`。
- 新增命令「改用 Codex 内置模型列表」：移除 `model_catalog_json` 并删除生成的目录文件。
- 新增设置 `codexgo.codexExecutable`，可直接指定 Codex 可执行文件，而不用自动探测。
- **破坏性变更：** Codex 0.162 彻底移除了 `wire_api = "chat"`，因此扩展现在只写入一个 `opencode-go` provider（`wire_api = "responses"`），并删除过时的 `opencode-go-responses` / `opencode-go-chat` 区块。0.1.0 写出的配置仍可正常加载。
- 选择器现在把当前模式下可用的模型排在前面；本地代理关闭时，仅支持 Chat Completions 与 Anthropic Messages 的模型移到单独分组，带 `unavailable` 标记且只能复制模型 ID。
- 为目录构建器补充单元测试（`scripts/test-catalog.mjs`）。

- **本地代理与统一状态栏** —— 新增仅本机可访问的桥接服务（默认开启）：原生 Responses 请求会先修复 `reasoning_text` 再转发，Chat Completions 与 Anthropic Messages 在请求和响应两个方向上转换，支持流式工具调用、thinking 块与 Codex 会话头透传；状态栏移除重复的模型选择器，改为合并显示额度和代理状态，点击刷新额度，代理开关位于悬停窗口。

## 0.1.0

- 首个版本。
- 拉取 OpenCode Go 实时模型列表（`/inference/go/v1/models`），并用 models.dev 元数据补充（上下文长度、价格、推理、视觉、弃用状态）。
- 原生 QuickPick 模型选择器，按协议分组（Chat Completions / Responses / 不支持的 Anthropic）。
- 安全的 Codex `config.toml` 写入器：按行精确编辑、自动创建带时间戳的备份、幂等。
- 自动管理 `wire_api` provider（`opencode-go` 用于 chat，`opencode-go-responses` 用于 responses）。
- 可选的推理强度选择，写入 `model_reasoning_effort`。
- 通过 SecretStorage 管理 API 密钥，并提供设置 Codex 读取的环境变量（`env_key`）的辅助命令。
- 状态栏显示当前配置的模型；点击打开选择器。
- 离线降级链：实时 API 列表 → 持久化缓存 → models.dev 目录 → 内置快照。
