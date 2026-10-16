## 为 Codex 选择模型

运行下面的命令并选择模型。扩展会把 `model` 与 `model_provider` 写入 Codex 的 `config.toml`，写入前自动创建带时间戳的备份。

[选择模型…](command:codexgo.selectModel)

- 通过 **Chat Completions** 或 **Responses** 提供的模型可用于 Codex。
- 使用 **Anthropic Messages 协议**的模型无法被 Codex 使用——选择器会明确标注，并只提供复制模型 ID。
