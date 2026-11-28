## Configure Claude Code (optional)

Claude Code speaks Anthropic Messages, so it can share the same loopback proxy and the same OpenCode Go key. This step writes only the keys this extension owns into `~/.claude/settings.json`, with a timestamped backup first.

[Configure Claude Code…](command:codexgo.configureClaudeCode)

- `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` point at the loopback proxy; the real key never leaves SecretStorage.
- The Opus/Sonnet/Haiku/Fable tiers map to OpenCode Go models from the settings.
- `modelPicker` lists every OpenCode Go text model in `/model`, with 1M-context rows marked.
- Hooks, permissions, plugins and every other key are left untouched, and **Restore Claude Code Settings** puts the owned keys back.
- Claude Code reads settings at startup, so reload the window or start a new session afterwards.
