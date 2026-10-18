## Select a model for Codex

Run the command below and pick a model. The extension writes `model` and `model_provider` into your Codex `config.toml`, creating a timestamped backup first.

[Select Model…](command:codexgo.selectModel)

- Models served over the native **Responses** API work directly.
- Models served over **Chat Completions** or **Anthropic Messages** work through the local proxy, which is enabled by default and can be toggled from the status bar tooltip.
- Codex 0.162+ no longer accepts `wire_api = "chat"`, so the extension always writes a Responses provider.
- This picker writes defaults for future conversations. To switch an open conversation, use Codex's own model picker.

To add the models to Codex's own `/model` picker, run **Sync OpenCode Go Models to Codex** first.
