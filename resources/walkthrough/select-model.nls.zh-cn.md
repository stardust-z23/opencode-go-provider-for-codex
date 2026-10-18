## 为 Codex 选择模型

运行下面的命令并选择模型。扩展会把 `model` 与 `model_provider` 写入 Codex 的 `config.toml`，写入前自动创建带时间戳的备份。

[选择模型…](command:codexgo.selectModel)

- 原生 **Responses** 模型可由 Codex 直连使用。
- 通过 **Chat Completions** 或 **Anthropic Messages** 提供的模型经本地代理解析后使用；代理默认启用，可从状态栏悬停窗口切换。
- Codex 0.162+ 已不再接受 `wire_api = "chat"`，因此扩展始终写入 Responses provider。
- 此选择器写入的是之后对话的默认值；要在已打开的会话中切换，请使用 Codex 自带的选择器。

若要让模型出现在 Codex 自带的 `/model` 选择器中，请先运行 **将 OpenCode Go 模型同步到 Codex**。
