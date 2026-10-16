## 设置 OpenCode Go API 密钥

1. 在 [OpenCode 控制台](https://opencode.ai/console)订阅 **OpenCode Go** 并复制 API 密钥。
2. 运行下面的命令并粘贴密钥。

[设置 API 密钥](command:codexgo.setApiKey)

> 密钥会保存到 VS Code SecretStorage 供本扩展拉取模型列表使用。Codex 本身通过 `config.toml` 中 `env_key` 指定的环境变量读取密钥——该命令提供一键设置辅助。
