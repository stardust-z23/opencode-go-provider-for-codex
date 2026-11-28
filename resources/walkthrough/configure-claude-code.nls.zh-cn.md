## 配置 Claude Code（可选）

Claude Code 说的就是 Anthropic Messages，因此可以和 Codex 共用同一个回环代理与同一个 OpenCode Go 密钥。这一步只会写入本扩展自有的键，并在写入前创建带时间戳的备份。

[配置 Claude Code…](command:codexgo.configureClaudeCode)

- `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 指向回环代理；真实密钥不离开 SecretStorage。
- Opus/Sonnet/Haiku/Fable 四档按设置映射到 OpenCode Go 模型。
- `modelPicker` 把全部 OpenCode Go 文本模型列进 `/model`，1M 上下文的行带标记。
- hooks、permissions、插件等其它键一律不动；**恢复 Claude Code 配置** 可把自有键还原。
- Claude Code 在启动时读取设置，因此之后需要重载窗口或开新会话。
