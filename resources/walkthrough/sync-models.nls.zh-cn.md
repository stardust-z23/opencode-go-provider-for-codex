## 把模型同步到 Codex

运行下面的命令，把受支持的 OpenCode Go 模型安装到 Codex 自带的选择器。需要修改时，扩展会先创建带时间戳的备份再写入 `config.toml`。

[同步 OpenCode Go 模型…](command:codexgo.syncModelCatalog)

- 后台代理负责认证、原生 Responses 修复、Chat Completions 与 Anthropic Messages。
- OpenCode Go 真实密钥只保存在 VS Code SecretStorage。
- 同步后，请在 Codex 自带的选择器中选择或切换模型。
- 目录变化后需要重启 Codex 或重新加载 VS Code。
