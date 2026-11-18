# 更新日志

## 0.1.24 (2026-11-18)

- **使用统计面板增加立即刷新按钮。** 新请求和额度变化仍由现有推送机制即时更新；点击顶部刷新按钮会强制重载本地 JSONL 统计，并同时刷新 Go 套餐额度。

## 0.1.23 (2026-11-18)

- **新增使用统计面板。** 状态栏点击改为打开统计面板，保留原有额度展示与悬停操作，并增加 `...` 维护菜单。面板只统计实际经过本扩展本地代理的推理请求，不扫描 Codex 历史会话。
- **记录轻量请求元数据。** 按日写入扩展 `globalStorageUri` 下的 JSONL，默认保留 30 天、最多 50 MB；记录模型、Tokens、缓存、总耗时、状态和稳定会话标识，不保存 prompt、响应正文或工具结果。
- **新增缓存命中与骤降提示。** 概览和请求表展示新增输入、缓存命中、缓存写入、输出、reasoning、缓存命中率、成功率和总耗时；同一会话缓存命中明显下降时标记为“疑似缓存骤降”。
- **状态栏显示当前会话缓存命中率。** 原有额度百分比、颜色阈值、倒计时和自动刷新保持不变。统计路径不改变任何发往上游的请求内容，不影响请求前缀缓存。

## 0.1.22 (2026-11-16)

- **修复 `call_id` 修复本身破坏前缀缓存的问题。** 不再为每一段历史生成随机 `call_id`，而是为真正成对的空 ID 调用/结果生成基于内容的确定性 ID；无对应调用的 `function_call_output`（如新版 Codex 的 `codex_apps_*` 页面快照）会延后到工具结果批次结束后降级成普通 user 消息，不再伪造工具关联或改变后续缓存前缀。
- **新增缓存安全回归测试。** 同一历史重复修复必须得到完全相同的请求体；新增调用、reasoning 修复和孤儿输出降级后，原有历史前缀必须保持逐字节一致。

## 0.1.21 (2026-11-13)

- **修复空 `call_id` 导致的新对话失败。** Responses、Chat Completions 与 Anthropic Messages 共用同一套工具调用归一化逻辑；空或缺失的 `call_id` 会在转发前补齐为同一个非空 ID，避免 OpenCode Go 返回 `input[N].call_id: expected a non-empty string`。
- **修复 DeepSeek thinking + tools 的跨轮 reasoning 恢复。** 代理现在会优先从上一轮响应缓存恢复真实的 `reasoning_content`，包括 Codex 重放 assistant 工具调用的场景。DeepSeek 官方要求请求携带 tools 时每个历史 assistant 消息都带该字段；若原始 reasoning 已不可得，代理按社区实测可行的方式补空字符串 `""`，不再用 `"tool call"` 之类的伪推理内容，也不再在本地提前返回错误。

## 0.1.20 (2026-11-02)

- **严格对齐 DeepSeek thinking mode。** DeepSeek + tools 请求不再用伪装的 `reasoning_content` 兜底；历史响应会保留完整输出项，供 `previous_response_id` 恢复。若历史 assistant 轮次缺少完整 reasoning，代理返回明确 400。
- **补齐关闭思考与 Anthropic 参数。** Chat Completions 的 `none` 改为 `thinking: {type: "disabled"}`；DeepSeek 的 Anthropic 请求改用 `thinking: {type: "enabled"}` 与 `output_config.effort`，不再使用 `budget_tokens`。

## 0.1.19 (2026-10-21)

- **移除启动时的模型列表预热。** 扩展内置模型选择器早已删除，启动预热既不更新 Codex catalog，也不重建 Codex 自带选择器，只会额外请求 models.dev 与 OpenCode Go `/models`。模型发现现在仅在用户执行目录同步时运行。
- **收紧代理模型路由。** 代理只按需读取一次 models.dev 元数据来获取协议和思考档位，不再经由完整模型发现路径触发 `/models` 请求或周期性刷新。
- **清理失效状态与设置。** 移除无订阅者的代理状态事件、始终为真的状态栏显示判断、目录同步后无关联的额度刷新，以及旧模型选择器遗留的 `showUnsupportedModels` / `showDeprecatedModels` 设置。

## 0.1.18 (2026-10-21)

- **额度百分比恢复整数显示。** 上游 `/usage` 实际返回整数，保留一位小数只会产生无意义的 `.0`；状态栏、悬停表格和摘要恢复为整数格式，原始值与显示值的日志保留用于诊断。

## 0.1.17 (2026-10-21)

- **额度百分比改为固定一位小数。** 状态栏、悬停表格、摘要和日志统一使用同一格式；原始百分比仍用于 SVG 进度条和颜色阈值。日志现在同时记录原始值与显示值，缓存和刷新间隔不变。

## 0.1.16 (2026-10-21)

- **更新额度面板操作。** “重启扩展宿主”改为“重载窗口”，并执行 `workbench.action.reloadWindow`，以便安装新版 VSIX 后重新扫描扩展。

## 0.1.15 (2026-10-21)

- **调整额度面板文字基线。** 进度条图片改用绝对中线对齐，与左右文字垂直居中；百分比去掉 Markdown 行内代码外壳和背景色，改为普通加粗文本。

## 0.1.14 (2026-10-21)

- **额度进度条改为固定像素 SVG。** 不再依赖 `█` / `░` 或其他字符宽度，避免中文界面字体回退导致三行进度条错位。轨道与填充按浅色、深色和高对比主题生成，并在主题切换时重新渲染。

## 0.1.13 (2026-10-21)

- **额度进度条恢复原始样式。** 实测 `▰` / `▱` 视觉不佳后撤回，继续使用最初的 `█` / `░` 字符进度条；版本号保持不变。

## 0.1.12 (2026-10-21)

- **还原额度表格表头对齐。** 三列表头恢复为原来的 Markdown 默认对齐方式，保留进度条等宽渲染，用于验证表头对齐对整张表格布局的影响。

## 0.1.11 (2026-10-21)

- **修复三行进度条宽度漂移。** 进度条改用等宽格式渲染，避免 `█` 与 `░` 在比例字体下因混合比例不同导致三行实际像素宽度不一致。上一版仅修正表头对齐，未处理进度条字体度量问题。

## 0.1.10 (2026-10-20)

- **修复中文额度面板列对齐。** 表头显式左对齐，与窗口名、进度条和重置倒计时保持一致，不再因 Markdown 默认居中而看起来错位。

## 0.1.9 (2026-10-20)

- **修复 User-Agent 版本漂移。** 代理请求不再硬编码为 `0.1.6`，而是在扩展激活时读取当前 `package.json` 版本。Responses、Chat Completions 与 Anthropic Messages 三条上游路径现在都会上报实际扩展版本。

## 0.1.8 (2026-10-19)

- **DeepSeek 多协议模型条目。** 两个 DeepSeek 模型实测在 OpenCode Go 的 Responses、Chat Completions 与 Anthropic Messages 上均可处理流式文本、`auto` 工具调用、工具结果回传、推理及真实 Codex 工具调用。目录同步现在额外生成 `*-responses` 与 `*-anthropic` 别名；原 ID 继续作为 Chat Completions 兼容条目。
- **协议别名安全回写。** Codex 使用别名选择协议，代理在转发前把上游 `model` 改回基础 DeepSeek ID，并按模型路由选择 `/responses`、`/chat/completions` 或 `/messages`。
- **验证覆盖。** 新增模型合并与代理路由测试；真实 Codex 两轮对话、shell 工具调用、41 条目录解析均通过。
- **说明。** DeepSeek thinking 模式不支持强制 `tool_choice`；Codex 使用 `auto`。OpenCode Go 也没有实现 DeepSeek 的 `/responses/compact`，因此 Responses 别名不提供远程压缩。

## 0.1.7 (2026-10-19)

- **常驻本地代理，不再需要用户级环境变量。** provider 改用派生后的低价值 `experimental_bearer_token` 认证本机回环代理，真实 OpenCode Go 密钥只保存在 VS Code SecretStorage。旧安装中的 `OPENCODE_GO_API_KEY` 只作为首次迁移来源，发现后会复制进 SecretStorage。
- **移除代理开关与状态栏代理 UI。** 扩展激活期间常驻启动回环桥接；状态栏只显示额度。原生 Responses 请求仍会经过代理，用于 `reasoning_text` 修复、档位还原和上游认证重写。
- **移除环境变量辅助入口。** “设置 API 密钥”只写入 SecretStorage；不再提供终端级或用户级环境变量设置提示。
- **移除扩展自带的模型 QuickPick。** 模型选择统一使用 Codex 自带选择器；目录同步仍负责写入默认模型、provider、目录和派生 bearer token。扩展也不再主动写入 `model_reasoning_effort`。
- **移除 `Update Model List (forced)`。** 该命令只刷新扩展内部缓存，不会更新 Codex 的模型目录；目录同步本身已经会强制刷新，因此保留它只会造成误导。

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
