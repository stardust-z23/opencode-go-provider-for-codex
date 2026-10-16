## Select a model for Codex

Run the command below and pick a model. The extension writes `model` and `model_provider` into your Codex `config.toml`, creating a timestamped backup first.

[Select Model…](command:codexgo.selectModel)

- Models served over **Chat Completions** or **Responses** work with Codex.
- Models using the **Anthropic Messages protocol** cannot be used by Codex — the picker marks them and only offers to copy the model ID.
