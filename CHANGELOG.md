# 更新日志

## 未发布

- **文档：补充「对话完全没有响应」的排查说明。** 模型上游卡住（网关只发 keep-alive）或模型在所在地区不可用（`403 ... not supported`）都会表现为毫无响应，README 现在给出了判断方法与备选模型。

- **状态栏额度显示（样式参考 OpenCode Go Monitor）。** 新增 `GET <base>/usage` 额度拉取：缓存 5 分钟，失败时沿用旧缓存，HTTP 401 表示该密钥没有可用的 Go 套餐。状态栏新增一个额度项，正文形如 `OC Go Rolling: 2% · 4h 52m`；悬停用 Markdown 表格列出滚动 / 周 / 月三个窗口的进度条、百分比与重置倒计时，并显示最近更新时间——表格按列对齐，进度条不会因标签长短而错位，也不会出现等宽代码块里 `█`/`░` 字高不一致的问题。配色取三个窗口中最差的用量：达到 `codexgo.usageWarningThreshold`（默认 80）变黄，达到 `codexgo.usageErrorThreshold`（默认 95）变红；正文显示哪个窗口由 `codexgo.usageDisplayWindow` 决定，轮询间隔由 `codexgo.usageRefreshInterval` 控制（默认 5 分钟），`codexgo.showUsage` 可整体关闭。未配置密钥 / 密钥被拒 / 端点异常时分别显示 `OC Go: add API key` / `OC Go: invalid key` / `OC Go: error`，点击即可设置密钥或重试；另新增命令「查看 OpenCode Go 额度」。
- **清理无用代码。** 删除未被引用的 `lastApiFetchFailed()`、`isCatalogLoaded()`，以及 `extension.ts` 中未使用的 `l10n` 导入。
- **修复：模型只输出纯文本、不调用工具。** 目录条目克隆自 Codex 自带条目（`codex debug models`），而在 Codex 0.162 上第一条可用条目是第一方 GPT-6 条目：`use_responses_lite: true` 会把工具定义从请求顶层的 `tools` 数组搬进 `additional_tools` 输入项，而该格式只有 OpenAI 自家后端会读；`tool_mode: "code_mode_only"` 则把真实工具换成单个自由格式的 JS `exec` 工具。第三方网关（如 OpenCode Go）两者都不认，模型因此收不到任何工具，只能把调用语法当普通文本输出（DeepSeek 会把原始的工具调用标记直接泄漏进正文）。现在生成的条目一律使用经典 Responses 传输：强制关闭 `use_responses_lite`、清空 `experimental_supported_tools`，并移除第一方专属的 `tool_mode` / `multi_agent_*` / `node_repl_*` 字段；模板挑选也会优先选择经典传输的条目（当本机 Codex 提供时）。受影响的目录请重新执行「将 OpenCode Go 模型同步到 Codex」重新生成。
- **OpenCode Go 模型进入 Codex 自带的选择器。** 新增命令「将 OpenCode Go 模型同步到 Codex」：拉取实时模型列表，只保留通过 `/responses` 提供服务的模型（Codex 0.162+ 唯一支持的协议），用本机 Codex 自带的一条已知可用条目（`codex debug models`）构建模型目录，写到 `config.toml` 同目录，并让顶层 `model_catalog_json` 指向它。不做探测、不发额外请求：协议信息来自模型列表本身。目录中只包含这些模型：`model_catalog_json` 是替换而非追加 Codex 内置列表。`codex doctor` 检查失败时会回滚目录与 `config.toml`。
- **修正协议映射。** 只要网关有 `<family>.res` 端点，就会通过 `/responses` 提供该模型，这比文档里「AI SDK package」一列要宽。已用 Codex 自身的日志验证：`deepseek-v4.1-flash` 在 `/responses` 上返回 `200 OK`（端点 `deepseek.res`），而 `gpt-6-luna` 虽是 Responses 模型却返回 `403 Country, region, or territory not supported`。因此内置快照把 DeepSeek 系列标为 `responses`；此前标为 `chat`，会把可用的模型从 Codex 中隐藏掉。
- 新增命令「改用 Codex 内置模型列表」：移除 `model_catalog_json` 并删除生成的目录文件。
- 新增设置 `codexgo.codexExecutable`，可直接指定 Codex 可执行文件，而不用自动探测。
- **破坏性变更：** Codex 0.162 彻底移除了 `wire_api = "chat"`，因此扩展现在只写入一个 `opencode-go` provider（`wire_api = "responses"`），并删除过时的 `opencode-go-responses` / `opencode-go-chat` 区块。0.1.0 写出的配置仍可正常加载。
- 选择器现在把 Codex 可用的模型（Responses API）排在前面；仅支持 Chat Completions 与 Anthropic 的模型移到单独分组，带 `unavailable` 标记且只能复制模型 ID。
- 为目录构建器补充单元测试（`scripts/test-catalog.mjs`）。

- **本地代理与统一状态栏** —— 新增仅本机可访问的 Responses → Chat Completions 代理（默认开启），支持流式工具调用、`reasoning_text` 回传修复与 Codex 会话头透传；状态栏移除重复的模型选择器，改为合并显示额度和代理状态，点击一键开关。

- **模型协议修正** —— 按 OpenCode Go 官方端点表，DeepSeek 系列恢复为 Chat Completions 模型，经本地代理使用；不再强制标记为 Responses。

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
