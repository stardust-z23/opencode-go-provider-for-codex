# TODO

## Claude Code adapter

Status: planned, not implemented.

Goal: let the Claude Code CLI and VS Code extension use OpenCode Go through the existing loopback proxy while keeping the real OpenCode API key in VS Code SecretStorage.

### Decision

- Prefer native Anthropic Messages pass-through, not a full Messages-to-Responses rewrite.
- OpenCode Go documents that every text model works through its translated Anthropic Messages endpoint.
- Use explicit Claude Code `modelPicker` configuration to expose all selectable OpenCode Go text models.
- Do not rely on gateway model discovery as the primary model-list mechanism. Claude Code filters discovered IDs and only keeps IDs containing `claude` or `anthropic`.
- Keep the real OpenCode key in SecretStorage. Write only a derived low-value proxy token to Claude Code settings.

### Confirmed compatibility facts

- Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL`.
- The OpenCode Go Anthropic base is `https://opencode.ai/inference/go/anthropic`.
- The local Claude Code base should be `http://127.0.0.1:<codexgo.proxyPort>`, without `/v1`.
- The VS Code extension and CLI share `~/.claude/settings.json`, so provider and model-picker configuration can be shared.
- `modelPicker` is a top-level user or managed settings key. It supports `options` and `replaceBuiltInOptions`.
- `modelPicker` requires Claude Code v2.1.242 or later.
- `behavesAs` on a picker row requires Claude Code v2.1.257 or later.
- Each picker row accepts a provider-format model ID and optional `label`, `description`, and `behavesAs`.
- `replaceBuiltInOptions: true` hides built-in models, discovered models, and custom-option rows. Only the configured rows, `Default`, and the current session model remain.
- Gateway discovery requests `GET /v1/models?limit=1000` with a default three-second timeout.
- Gateway discovery is disabled unless `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- Gateway discovery ignores returned IDs that contain neither `claude` nor `anthropic`, so it cannot enumerate arbitrary OpenCode IDs such as `deepseek-v4.1-flash`, `gpt-6-luna`, or `minimax-m3`.
- `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` control default, role aliases, background tasks, and subagents. They do not replace the picker list.
- Claude Code reads environment settings at startup. First-time takeover requires a new session or VS Code window reload.

### P0: Anthropic Messages proxy

- [ ] Add `POST /v1/messages` to the local proxy.
- [ ] Preserve native Anthropic Messages JSON and SSE instead of converting through Responses.
- [ ] Forward `anthropic-version`, `anthropic-beta`, request IDs, and custom Anthropic headers.
- [ ] Accept the derived local proxy token through `Authorization: Bearer`.
- [ ] Inject the real OpenCode Go key upstream using the authentication header documented by OpenCode.
- [ ] Preserve text, image, document/PDF, tool use, tool result, thinking, redacted thinking, and signature blocks.
- [ ] Preserve SSE ordering through `message_start`, `content_block_*`, `message_delta`, and `message_stop`.
- [ ] Preserve SSE ping/comment frames needed to avoid idle timeouts.
- [ ] Detect assistant role changes, model switches, and unsupported provider metadata without mutating normal requests.
- [ ] Add loopback auth tests, JSON tests, SSE tests, and an upstream error passthrough test.

### P0: Session and authentication

- [ ] Resolve the OpenCode session ID from:
  - [ ] `x-claude-code-session-id`
  - [ ] `claude-code-session-id`
  - [ ] `metadata.user_id` JSON or legacy `_session_` form
  - [ ] `metadata.session_id`
- [ ] Forward the resolved ID as `x-opencode-session`.
- [ ] Reuse the stable conversation fingerprint when no Claude Code session ID is present.
- [ ] Keep accepting `x-opencode-session`, `session_id`, `x-session-id`, `session-id`, and `thread-id`.
- [ ] Add a test proving that two turns in one conversation reuse the same upstream session header.
- [ ] Add a test proving that two different conversations do not share a fingerprint.

### P1: Claude settings integration

- [ ] Resolve the Claude Code settings path from `CLAUDE_CONFIG_DIR` or `~/.claude/settings.json`.
- [ ] Preserve all unknown top-level keys, including `enabledPlugins`, hooks, permissions, status line, marketplaces, and unrelated `env` entries.
- [ ] Update only owned keys instead of replacing the whole JSON file.
- [ ] Create a timestamped backup before the first real change.
- [ ] Use atomic write and validate the result before replacing the original file.
- [ ] Track ownership so restore removes only keys written by this extension.
- [ ] Do not set both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY`.
- [ ] Use `ANTHROPIC_AUTH_TOKEN` with the derived proxy token.
- [ ] Set `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`.
- [ ] Add a command to configure/repair Claude Code integration.
- [ ] Add a command to restore the previous Claude Code configuration.
- [ ] Show a clear reload/new-session requirement after first takeover.
- [ ] Add idempotence, backup, restore, and malformed-settings tests.

### P1: Model list and picker

- [ ] Build the selectable list from the same account-filtered OpenCode Go models used by the Codex catalog.
- [ ] Exclude decision and embedding models.
- [ ] Include display names and short descriptions from the official model catalog.
- [ ] Write `modelPicker` in `~/.claude/settings.json`.
- [ ] Use `replaceBuiltInOptions: true` so the UI lists the OpenCode catalog instead of unrelated Claude models.
- [ ] Add one row per text model:
  - [ ] `model`: OpenCode model ID
  - [ ] `label`: human-readable model name
  - [ ] `description`: concise provider/context description
  - [ ] `behavesAs`: optional, only when a safe known Claude behavior profile is selected
- [ ] Add a command to refresh/rebuild the picker after model-catalog changes.
- [ ] Add a notification when the OpenCode model catalog changes while Claude Code integration is enabled.
- [ ] Detect Claude Code versions older than v2.1.242 and fall back to alias mappings.
- [ ] Add a manual acceptance test proving that every selectable text model appears in the VS Code extension picker.

### P1: Default and role mappings

- [ ] Let the user choose a default/main model for this extension.
- [ ] Optionally choose a fast model for the Haiku role.
- [ ] Optionally choose a subagent model.
- [ ] Write:
  - [ ] `ANTHROPIC_MODEL`
  - [ ] `ANTHROPIC_DEFAULT_OPUS_MODEL`
  - [ ] `ANTHROPIC_DEFAULT_SONNET_MODEL`
  - [ ] `ANTHROPIC_DEFAULT_HAIKU_MODEL`
  - [ ] `ANTHROPIC_DEFAULT_FABLE_MODEL`
  - [ ] `CLAUDE_CODE_SUBAGENT_MODEL`
- [ ] Keep role mapping values configurable rather than forcing all roles to the same model.
- [ ] Strip a Claude Code `[1m]` suffix before forwarding the model ID upstream.
- [ ] Preserve the upstream model ID in logs so usage accounting maps back to the selected model.

### P1: Optional model discovery endpoint

- [ ] Implement `GET /v1/models?limit=1000` in Anthropic response shape:
  - [ ] `data`
  - [ ] `has_more`
  - [ ] optional `display_name`
  - [ ] optional `description`
- [ ] Return within three seconds; use cached catalog data and no network request.
- [ ] Do not require discovery when `modelPicker` is present.
- [ ] Test with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- [ ] Document the ID filter limitation in README.

### P2: Context and feature controls

- [ ] Set a safe context window with `CLAUDE_CODE_MAX_CONTEXT_TOKENS` or per-model behavior metadata.
- [ ] Evaluate `CLAUDE_CODE_AUTO_COMPACT_WINDOW` for models whose real context is below Claude Code's assumed window.
- [ ] Evaluate `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.
- [ ] Evaluate `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`.
- [ ] Decide whether a global minimum window or per-model picker behavior is safer.
- [ ] Preserve or disable thinking according to model capabilities.
- [ ] Verify 1M-context markers only when the upstream model truly supports the declared window.
- [ ] Document that decision and embedding models are not picker entries.

### P2: Usage and diagnostics

- [ ] Record Claude Messages proxy usage in the existing local usage store.
- [ ] Distinguish Claude Code traffic from Codex traffic without storing prompts or responses.
- [ ] Log model-role mapping, discovered/model-picker model count, and session source.
- [ ] Keep request bodies and tool results out of persistent logs.
- [ ] Add a diagnostic action that reports whether the proxy is reachable, settings are valid, and the picker version requirement is met.

### P2: Optional endpoints and compatibility

- [ ] Decide whether to implement `POST /v1/messages/count_tokens`.
- [ ] Character-based context estimation is an accepted fallback.
- [ ] Decide whether to respond to the best-effort `HEAD /api/hello` startup probe.
- [ ] Verify behavior with both the Claude Code CLI and the VS Code extension.
- [ ] Verify behavior after VS Code reload, a new conversation, and a model switch inside one conversation.

### Acceptance criteria

- [ ] A fresh install can configure Claude Code with one command without exposing the real OpenCode key.
- [ ] `~/.claude/settings.json` keeps all user plugins, hooks, permissions, marketplaces, and unrelated values.
- [ ] The VS Code Claude Code model picker lists every selectable OpenCode Go text model using readable names.
- [ ] Selecting a model sends its OpenCode model ID to the local proxy.
- [ ] Streaming text, tools, reasoning, images, and PDF documents work.
- [ ] Multiple turns in one conversation keep a stable `x-opencode-session`.
- [ ] Restore returns the owned settings to their previous values without reverting user changes made in the meantime.
- [ ] Codex behavior and cache prefixes remain unchanged when Claude Code support is disabled.

### Open questions

- [ ] Which OpenCode model should be the default main model?
- [ ] Which model should be the default fast/Haiku model?
- [ ] Should role mappings be one global profile or separate profiles for CLI and VS Code?
- [ ] Is `behavesAs` reliable for cross-provider OpenCode IDs, or should it remain opt-in?
- [ ] Should model-picker refresh happen automatically on catalog changes or only after confirmation?
- [ ] Should the extension offer an immediate VS Code window reload after first configuration?

### References

- Claude Code settings: https://code.claude.com/docs/en/settings
- Claude Code VS Code extension: https://code.claude.com/docs/en/vs-code
- Claude Code `modelPicker`: https://code.claude.com/docs/en/settings-reference#modelpicker
- Claude Code model configuration: https://code.claude.com/docs/en/model-config
- Claude Code gateway model discovery: https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery
- OpenCode Go for Claude Code: https://opencode.ai/docs/console/harnesses/claude-code/
- OpenCode Go endpoints: https://opencode.ai/docs/console/go/#endpoints
- Local cc-switch reference:
  - `D:\MyProjects\cc-switch-reference\src-tauri\src\live\project\claude.rs`
  - `D:\MyProjects\cc-switch-reference\src-tauri\src\mode\controller.rs`
  - `D:\MyProjects\cc-switch-reference\src-tauri\src\proxy\handlers.rs`
  - `D:\MyProjects\cc-switch-reference\src-tauri\src\proxy\model_mapper.rs`
