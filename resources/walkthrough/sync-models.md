## Sync the models into Codex

Run the command below to install the supported OpenCode Go models into Codex's own model picker. Codex writes `config.toml` through the extension with a timestamped backup when needed.

[Sync OpenCode Go Models…](command:codexgo.syncModelCatalog)

- The background proxy handles authentication, native Responses repair, Chat Completions, and Anthropic Messages.
- The real OpenCode Go key stays in VS Code SecretStorage.
- After syncing, choose or switch the model from Codex's own model picker.
- Restart Codex or reload VS Code after the catalog changes.
