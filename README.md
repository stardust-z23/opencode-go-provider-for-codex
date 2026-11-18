<div align="center">

# OpenCode Go Provider for Codex

[English](#english) | [中文](#中文)

</div>

## English

> [!IMPORTANT]
> This is not affiliated with, officially maintained by, or endorsed by OpenAI (Codex) or Anomaly (OpenCode). It is a third-party convenience tool.

Fetch, preview and select [OpenCode Go](https://opencode.ai/go) models for **Codex** (CLI or VS Code extension) through a native VS Code UI — then apply the selection to Codex's `config.toml` safely.

The extension is modeled on the patterns of [OpenCode Go Provider for Copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (localization, logger, model discovery, hardened fallbacks), adapted to Codex configuration.

### At a glance

- Live OpenCode Go model list enriched with [models.dev](https://models.dev) metadata.
- One-command sync into Codex's own `/model` picker, writing `config.toml` with backups, comments and formatting preserved.
- Always-on loopback proxy for authentication, native Responses repair, and Chat Completions / Anthropic Messages translation.
- Plan usage and quick actions in the VS Code status bar.

### Quick start

1. Subscribe to OpenCode Go at [opencode.ai/auth](https://opencode.ai/auth) and copy an API key.
2. `Ctrl+Shift+P` → **OpenCode Go for Codex: Set OpenCode Go API Key**.
3. `Ctrl+Shift+P` → **OpenCode Go for Codex: Sync OpenCode Go Models to Codex** — installs the usable OpenCode Go models into Codex's own picker (no inference requests are sent).
4. **Restart VS Code** so Codex reloads `config.toml`, then choose a model from Codex's own picker.

> The extension starts the loopback proxy automatically. A user-level environment variable is not required; the upstream key stays in VS Code SecretStorage.

<details>
<summary><strong>Details</strong> — click to expand models, config, proxy, commands, settings, troubleshooting and development</summary>

### What it does

- **Fetch** — pulls the live model list from `https://opencode.ai/inference/go/v1/models` (with your API key) and enriches it with [models.dev](https://models.dev) metadata: context length, pricing, reasoning options, vision, deprecation, protocol.
- **Sync** — turns every supported model into a Codex model catalog and points `model_catalog_json` at it so they show up in *Codex's own* model picker. Sends no inference requests; reversible with one command.
- **Apply** — catalog sync writes the top-level `model` and `model_provider`, the `[model_providers.opencode-go]` block, and `model_catalog_json`. Existing files are backed up before a real change, and identical writes are skipped.
- **Local proxy** — always starts a loopback bridge while the extension is active. Native Responses requests are repaired and forwarded; Chat Completions and Anthropic Messages are translated in both directions. It replays the `reasoning_text` thinking state that OpenCode Go requires, restores missing `reasoning_content` and tool-call history across Chat turns, preserves Codex session headers, and translates streaming tool calls. Codex authenticates to the proxy with a derived, low-value token; the real upstream key never leaves SecretStorage.
- **Status** — the status bar item shows OpenCode Go plan usage, e.g. `OpenCode Go Rolling: 42% · 2h 13m`. Clicking refreshes usage; the countdown repaints every minute without a network request. The hover window keeps the actions for check usage, set key, sync models, open `config.toml`, and restart the extension host.

### What gets written

```toml
model = "deepseek-v4.1-flash"
model_provider = "opencode-go"
# Written by "Sync OpenCode Go Models to Codex"
model_catalog_json = "opencode-go-models.json"

[model_providers.opencode-go]
name = "OpenCode Go"
base_url = "http://127.0.0.1:15722/v1"
experimental_bearer_token = "<derived local proxy token>"
requires_openai_auth = false
wire_api = "responses"
```

`base_url` always points at the background loopback proxy. The bearer token is derived from the upstream key and is accepted only by that local proxy; it cannot authenticate to OpenCode Go. `model_catalog_json` is added only by catalog sync; selecting a model on its own leaves that key alone. A non-default proxy port changes the loopback URL accordingly.

> [!NOTE]
> Codex 0.162+ accepts **only** `wire_api = "responses"`; `wire_api = "chat"` was hard-removed ([openai/codex#7782](https://github.com/openai/codex/pull/7782)) and now makes the whole config fail to load. The extension therefore maintains a single `opencode-go` provider and always writes `responses`. Leftover `[model_providers.opencode-go-responses]` / `[model_providers.opencode-go-chat]` blocks from older versions are deleted on the next apply.

### Model selection

The extension no longer ships a QuickPick model picker. Use **Codex's own picker** for both defaults and live switching: catalog sync installs the models and applies a usable top-level model, while Codex's app-server updates the active thread immediately.

### Codex's own model picker

Codex's picker (the CLI `/model` command and the model list in the Codex VS Code extension) is not extensible through settings: it is fed by the app-server `model/list` RPC, which reads the file named by the top-level `model_catalog_json` key. That key **replaces** the built-in list rather than extending it, which is why the catalog contains the usable OpenCode Go models only — the built-in Codex models are not merged in.

**OpenCode Go for Codex: Sync OpenCode Go Models to Codex** does the whole job:

1. pulls the live model list;
2. keeps every model supported by the background proxy;
3. takes a known-good catalog entry from the Codex installation you actually have (`codex debug models`) and rewrites the per-model fields, so the entry schema always matches your Codex version. The first-party-only transports a stock entry may carry (`use_responses_lite`, code-mode `tool_mode`, first-party `experimental_supported_tools`) are stripped, because a third-party gateway cannot see the tools they move out of the request;
4. writes `<CODEX_HOME>/opencode-go-models.json` (UTF-8, no BOM), sets `model_catalog_json`, and keeps the current model when it is still usable or applies the first usable model otherwise;
5. runs `codex doctor` and restores the previous catalog and, when a config file already existed, the previous `config.toml` if Codex rejects the result.

> [!IMPORTANT]
> A *new* catalog is only read when Codex starts (the app-server caches it), so a sync needs a Codex restart or a VS Code window reload — the notification offers the reload. **Switching between models that are already listed is live** and needs no restart.

**OpenCode Go for Codex: Use Codex's Built-in Model List** removes `model_catalog_json` and deletes the generated file, returning Codex to its stock list.

### Which OpenCode Go models work with Codex?

| OpenCode Go endpoint | AI SDK package | Verdict |
|---|---|---|
| `/go/v1/responses` | `@ai-sdk/openai` | ✅ through the local proxy |
| `/go/v1/chat/completions` | `@ai-sdk/openai-compatible` | ✅ through the local proxy; ❌ direct (Codex 0.162+ removed Chat Completions) |
| `/go/v1/messages` | `@ai-sdk/anthropic` | ✅ through the local proxy; ❌ direct (Codex has no Anthropic Messages support) |

The built-in snapshot in `src/hardcodedModels.ts` mirrors the official OpenCode Go endpoint table: the base DeepSeek IDs use Chat Completions and are served through the local proxy, while Grok, Luna and Muse Spark remain native Responses models. Region blocks depend on your account location rather than the protocol, so a blocked model stays listed and the gateway returns `403` when selected.

The local proxy is always active while the extension is running, so every supported endpoint is available in Codex's own picker.

### DeepSeek protocol choices

Both DeepSeek models were verified live on all three OpenCode Go endpoints, including streaming text, `tool_choice: "auto"`, tool-result follow-ups, reasoning output, two-turn Codex conversations and a real Codex shell tool call. Catalog sync therefore exposes three explicit choices per model:

| Upstream model | Codex model ID | Protocol |
|---|---|---|
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | Chat Completions |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-responses` | Responses |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-anthropic` | Anthropic Messages |
| `deepseek-v4-pro` | `deepseek-v4-pro` | Chat Completions |
| `deepseek-v4-pro` | `deepseek-v4-pro-responses` | Responses |
| `deepseek-v4-pro` | `deepseek-v4-pro-anthropic` | Anthropic Messages |

The original IDs remain the backward-compatible Chat Completions entries. The `-responses` and `-anthropic` IDs are aliases: Codex sends the alias to the loopback proxy, and the proxy rewrites the upstream `model` field back to the base DeepSeek ID.

DeepSeek's thinking mode rejects a forced `tool_choice` such as `{ "type": "function", "name": "..." }`; Codex uses `auto`, which is supported on all three routes. OpenCode Go also does not implement `/responses/compact` for DeepSeek (`404`), so the Responses alias does not provide remote compaction. Use Codex's normal local history handling instead of selecting the Responses alias solely for server-side compaction.

### Safety

- **Surgical edits, never a rewrite.** The config file is edited line-by-line; comments, formatting, unknown keys, other providers and `[profiles.*]` blocks are left untouched. The extension only touches the top-level keys it owns: `model`, `model_provider`, `model_reasoning_effort`, and `model_catalog_json` for catalog commands.
- **Scoped provider updates.** Auth or port changes rewrite only the `[model_providers.opencode-go]` block. Provider blocks owned by older versions are removed on the next apply.
- **Backups.** When `config.toml` already exists, `config.toml.bak-<timestamp>` is created before a real change; only the newest `codexgo.maxBackups` (default 5) are kept. A missing config file is created without a backup.
- **Idempotent.** Selecting the model that is already configured performs no write and no backup.
- The extension only sets a profile-agnostic default — if you launch Codex with `--profile`, that profile's own `model` keys are not modified.

### Commands

| Command | Description |
|---|---|
| `OpenCode Go for Codex: Set OpenCode Go API Key` | Store / update / clear the key in VS Code SecretStorage. |
| `OpenCode Go for Codex: Get OpenCode Go API Key` | Open the OpenCode auth page. |
| `OpenCode Go for Codex: Check OpenCode Go Usage` | Refresh the plan usage shown in the status bar (also the status bar click action). |
| `OpenCode Go for Codex: Sync OpenCode Go Models to Codex` | Put every model supported by the background proxy into Codex's own model picker and apply a usable top-level model (no probing, no inference requests). |
| `OpenCode Go for Codex: Use Codex's Built-in Model List` | Remove `model_catalog_json` and the generated catalog file. |
| `OpenCode Go for Codex: Open Codex config.toml` | Open the config file in the editor. |
| `OpenCode Go for Codex: Open OpenCode Go for Codex Settings` | Extension settings. |

### Settings

| Setting | Default | Description |
|---|---|---|
| `codexgo.codexHome` | *(empty)* | Config directory; empty = `CODEX_HOME` → `~/.codex`. |
| `codexgo.codexExecutable` | *(empty)* | Codex executable used for `codex debug models` and `codex doctor`; empty = auto-detect CLI or the Codex extension's bundled binary. |
| `codexgo.maxBackups` | `5` | Timestamped backups to keep (1–50). |
| `codexgo.modelsDevMirrorUrl` | `https://modelsdev-mirror.onesoft.top/catalog.json` | models.dev mirror fallback; empty disables. |
| `codexgo.modelsDevMirrorToken` | *(empty)* | Token for the mirror (`x-mirror-token`). |
| `codexgo.modelsDevUpdateInterval` | `60000` | models.dev metadata refresh interval during directory sync (ms, min 30000). |
| `codexgo.showUsage` | `true` | Show plan usage in the status bar item. |
| `codexgo.usageRefreshInterval` | `5` | Usage refresh interval in minutes (1–60). |
| `codexgo.usageDisplayWindow` | `rolling` | Window shown in the status bar text: `rolling` / `weekly` / `monthly`. |
| `codexgo.usageWarningThreshold` | `80` | Usage % at which the item turns yellow (worst of the three windows). |
| `codexgo.usageErrorThreshold` | `95` | Usage % at which the item turns red (worst of the three windows). |
| `codexgo.proxyPort` | `15722` | Loopback proxy port (1024-65535). |

### Offline behaviour

Model IDs and metadata degrade independently:

- **Model IDs:** live `/models` → last successful list persisted in `globalState` (14-day cap) → models.dev `opencode-go` provider IDs → built-in snapshot.
- **Metadata:** the built-in table supplies known protocol and free-model flags; models.dev supplies names, context length, pricing, reasoning levels, vision and deprecation status. A models.dev failure keeps the last good in-memory catalog and retries no sooner than 60 seconds later.

### Troubleshooting

- **Codex still says it cannot authenticate** — confirm the API key was saved, then reload VS Code so the extension can start the proxy and rewrite the provider token.
- **HTTP 401/403 when refreshing the model list** — the key is invalid or the Go subscription is inactive; re-run *Set API Key*. Note the model list uses the same endpoint family as inference.
- **No live models, only cached/catalog/built-in data** — offline or blocked; check the Output panel (*OpenCode Go for Codex*) for the fetch chain log, or configure a mirror.
- **The synced models do not appear in Codex's picker** — a new catalog is read at Codex start-up only. Restart Codex or reload the VS Code window; switching between already-listed models is live.
- **"Codex rejected the generated model catalog"** — the previous catalog and any pre-existing `config.toml` were restored. Check that `codexgo.codexExecutable` points at a working `codex` if you use a custom build.
- **The model answers in plain text instead of calling tools** — a catalog synced by an older build inherited OpenAI-only transports from the Codex template, so the tools never reached the gateway. Re-run *Sync OpenCode Go Models to Codex* with this version to regenerate the catalog.
- **Codex ignores the change** — Codex reads its config at startup; reload/restart the Codex session or VS Code window.
- **`codexHome` in a portable setup** — if you launch Codex with a custom `CODEX_HOME`, set `codexgo.codexHome` to the same directory.
- **Reasoning effort** — use Codex's own picker. It only exposes stable visible slots, so catalog sync maps upstream `max` to `XHigh` and maps `minimal` to `Low` when the model has no `low` level. The local proxy restores `xhigh` to upstream `max` and `low` to `minimal`. When a model declares both `xhigh` and `max`, the single `XHigh` slot means upstream `max`. The extension no longer writes `model_reasoning_effort`; edit `config.toml` directly if you need a fixed default.
- **`The reasoning_text / reasoning_content in the thinking mode must be passed back to the API`** — reload VS Code so the always-on local proxy is running; it repairs native `reasoning_text` and restores complete cached Chat history. For DeepSeek thinking-mode requests carrying tools, every historical assistant message must include `reasoning_content`: the proxy first restores the original cached reasoning, then uses an empty string only if it is no longer available. A made-up reasoning sentence is never inserted.
- **`input[N].call_id: expected a non-empty string`** — Codex replayed a tool call or tool result with an empty `call_id`. The proxy now derives a deterministic ID for a genuine call/output pair. Outputs without a matching call, including newer Codex `codex_apps_*` page snapshots, are deferred and replayed as user messages instead of receiving a fabricated random ID. This keeps request prefixes cacheable; reload VS Code after installing the fixed build, then retry the turn.
- **`proxy.start.failed` reports `EADDRINUSE` on `127.0.0.1:15722`** — another VS Code window already owns the loopback proxy. Codex inference still works while that window remains open because every window uses the same proxy URL and derived token. Extension commands that check the local proxy state, such as catalog sync, may report it as unavailable in a non-owning window; run them in the owning window. If the owning window closes, reload one of the remaining windows so its extension host can bind the port. If the windows need different proxy ports or API keys, use separate VS Code profiles and keep each profile's `codexgo.proxyPort`, `codexgo.codexHome`, and stored key isolated.
- **The usage item shows `OpenCode Go: add API key` / `OpenCode Go: invalid key` / `OpenCode Go: error`** — no key is configured, the usage endpoint returned `401` (invalid key or no active Go plan), or the endpoint is unreachable. Click the item to refresh; hover it for the reason and the set-key action.
- **Chat shows no reply at all** — the selected model's upstream can be stuck (the gateway answers `200` and only sends `: keep-alive`, with no events) or the model may be blocked in your region (the Codex log shows `403 ... not supported`, e.g. `gpt-5.6-luna`, `gpt-6-luna`, `muse-spark-*` outside their supported regions). Switch to another model (`grok-4.6` / `grok-4.7` are good fallbacks) or retry later — nothing needs reconfiguring. The upstream routes are independent: `/responses`, `/chat/completions` and `/messages` can fail or hang separately. Proxies such as cc-switch translate Codex's Responses requests into Chat Completions, so they keep working in exactly that case; Codex 0.162 removed `wire_api = "chat"`, so this extension has no direct Chat Completions route to fall back to.
- **Remote compaction fails** — the proxy returns `501` for `/responses/compact` and compaction triggers when the selected model uses Chat Completions or Anthropic Messages. For DeepSeek, OpenCode Go itself returns `404` on `/responses/compact` even through the Responses alias, so remote compaction is unavailable there.

### Development

```bash
npm install
npm run compile   # or: npm run watch
npm test          # TOML, model merge, catalog, usage, Chat and Anthropic proxy tests
npm run test:e2e  # local Codex CLI + fake upstream end-to-end test
npm run test:live # live OpenCode Go test; requires OPENCODE_GO_API_KEY
npm run test:binding # live Anthropic thinking-signature regression test
npm run build     # package a .vsix with vsce
```

Press `F5` to launch an Extension Development Host. The unit tests run in plain Node against compiled modules that do not import `vscode`, plus the local proxy and usage parsers. `test:live` and `test:binding` call OpenCode Go and require `OPENCODE_GO_API_KEY`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map, startup flow, proxy routing and current design boundaries.

</details>

---

## 中文

> [!IMPORTANT]
> 本项目与 OpenAI（Codex）和 Anomaly（OpenCode）均无隶属或官方背书关系，仅为第三方便捷工具。

通过 VS Code 原生界面**拉取、预览并选择** [OpenCode Go](https://opencode.ai/go) 模型，供 **Codex**（CLI 或 VS Code 扩展）使用，并把选择安全地写入 Codex 的 `config.toml`。

实现参考了 [OpenCode Go Provider for Copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) 的模式（本地化、日志、模型发现、稳健的降级链），并针对 Codex 配置做了适配。

### 概览

- 拉取 OpenCode Go 实时模型列表，并用 [models.dev](https://models.dev) 元数据补充。
- 一条命令把模型同步到 Codex 自带的 `/model` 选择器，写入 `config.toml` 时保留备份、注释与格式。
- 常驻本机回环代理负责认证、原生 Responses 修复，以及 Chat Completions / Anthropic Messages 转换。
- 状态栏显示套餐额度和快捷操作。

### 快速开始

1. 在 [opencode.ai/auth](https://opencode.ai/auth) 订阅 OpenCode Go 并复制 API 密钥。
2. `Ctrl+Shift+P` → **OpenCode Go for Codex: 设置 OpenCode Go API 密钥**。
3. `Ctrl+Shift+P` → **OpenCode Go for Codex: 将 OpenCode Go 模型同步到 Codex** —— 把当前可用的 OpenCode Go 模型写入 Codex 自带的选择器（不发送推理请求）。
4. **重启 VS Code**，让 Codex 重新读取 `config.toml`，然后在 Codex 自带的选择器中选择模型。

> 扩展会自动启动本机回环代理，不需要用户级环境变量；OpenCode Go 的真实密钥只保存在 VS Code SecretStorage。

<details>
<summary><strong>详细说明</strong> —— 点击展开模型、配置、代理、命令、设置、故障排查与开发说明</summary>

### 功能

- **拉取** — 用你的 API 密钥从 `https://opencode.ai/inference/go/v1/models` 获取实时模型列表，并用 [models.dev](https://models.dev) 元数据补充：上下文长度、价格、推理选项、视觉、弃用状态、协议。
- **同步** — 把所有受支持的模型生成为 Codex 模型目录，并让 `model_catalog_json` 指向它，从而出现在 **Codex 自带的选择器**里；不发送推理请求，一条命令即可撤销。
- **应用** — 目录同步写入顶层 `model`、`model_provider`、`[model_providers.opencode-go]` 块和 `model_catalog_json`。只有内容真正变化时才备份并写入，相同内容会直接跳过。
- **本地代理** —— 扩展激活期间常驻本机回环桥接服务：原生 Responses 请求经修复后转发，Chat Completions 与 Anthropic Messages 在请求和响应两个方向上转换。代理会回传 OpenCode Go 要求的 `reasoning_text` 思考状态、跨轮恢复缺失的 `reasoning_content` 与工具调用历史、保留 Codex 会话头，并转换流式工具调用。Codex 使用派生的低价值 token 访问代理，真实上游密钥不会离开 SecretStorage。
- **状态栏** —— 显示 OpenCode Go 套餐额度，例如 `OpenCode Go Rolling: 42% · 2h 13m`。点击状态栏刷新额度；倒计时每分钟重绘一次，不会重新请求网络。悬停窗口保留查看额度、设置密钥、同步模型、打开 `config.toml` 和重启扩展宿主操作。

### 写入的内容

```toml
model = "deepseek-v4.1-flash"
model_provider = "opencode-go"
# 由「将 OpenCode Go 模型同步到 Codex」写入
model_catalog_json = "opencode-go-models.json"

[model_providers.opencode-go]
name = "OpenCode Go"
base_url = "http://127.0.0.1:15722/v1"
experimental_bearer_token = "<派生的本地代理 token>"
requires_openai_auth = false
wire_api = "responses"
```

`base_url` 始终指向后台本机回环代理。bearer token 从上游密钥派生，只被该本地代理接受，不能用于认证 OpenCode Go。`model_catalog_json` 只由目录同步写入，单独选择模型不会改动该键。修改 `codexgo.proxyPort` 后，回环 URL 会随端口变化。

> [!NOTE]
> Codex 0.162+ **只** 接受 `wire_api = "responses"`；`wire_api = "chat"` 已被硬性移除（[openai/codex#7782](https://github.com/openai/codex/pull/7782)），保留它会导致整个配置无法加载。因此扩展只维护一个 `opencode-go` provider，并始终写入 `responses`；旧版本留下的 `[model_providers.opencode-go-responses]` / `[model_providers.opencode-go-chat]` 块会在下次应用时被删除。

### 模型选择

扩展不再提供自己的 QuickPick。模型选择统一使用 **Codex 自带的选择器**：目录同步安装模型并应用一个可用的顶层默认模型，正在进行的会话由 Codex app-server 实时更新。

### Codex 自带的选择器

Codex 的选择器（CLI 的 `/model` 命令、Codex VS Code 扩展中的模型列表）无法通过设置扩展：它由 app-server 的 `model/list` RPC 提供，而该 RPC 读取顶层 `model_catalog_json` 指向的文件。该键是**替换**内置列表而非追加，因此目录中只包含可用的 OpenCode Go 模型——不会混入 Codex 内置模型。

**OpenCode Go for Codex: 将 OpenCode Go 模型同步到 Codex** 一次完成全部工作：

1. 拉取实时模型列表；
2. 保留后台代理支持的全部模型；
3. 从你**本机实际安装的** Codex 取一条已知可用的目录条目（`codex debug models`），再覆盖其中的模型字段，从而保证条目结构与你的 Codex 版本完全一致；同时会剥离模板里可能带有的第一方专属传输字段（`use_responses_lite`、代码模式 `tool_mode`、第一方 `experimental_supported_tools`），因为第三方网关看不到这些字段搬走的工具定义；
4. 写入 `<CODEX_HOME>/opencode-go-models.json`（UTF-8、无 BOM），设置 `model_catalog_json`，并在当前模型仍可用时保留它，否则应用第一个可用模型；
5. 运行 `codex doctor`；若 Codex 拒绝该配置，则恢复此前的目录文件；若同步前已存在 `config.toml`，也一并恢复。

> [!IMPORTANT]
> **新**目录只在 Codex 启动时读取（app-server 会缓存），因此同步后需要重启 Codex 或重新加载 VS Code 窗口——提示消息中会提供「重新加载窗口」。而在**已列出的模型之间切换是实时的**，无需重启。

**OpenCode Go for Codex: 改用 Codex 内置模型列表** 会移除 `model_catalog_json` 并删除生成的目录文件，让 Codex 回到自带的列表。

### 哪些模型可用于 Codex？

| OpenCode Go 端点 | AI SDK 包 | 结论 |
|---|---|---|
| `/go/v1/responses` | `@ai-sdk/openai` | ✅ 经本地代理 |
| `/go/v1/chat/completions` | `@ai-sdk/openai-compatible` | ✅ 经本地代理可用；❌ 直连不可用（Codex 0.162+ 已移除 Chat Completions） |
| `/go/v1/messages` | `@ai-sdk/anthropic` | ✅ 经本地代理可用；❌ 直连不可用（Codex 不支持 Anthropic Messages） |

`src/hardcodedModels.ts` 中的内置快照现在与 OpenCode Go 官方端点表保持一致：DeepSeek 的基础 ID 走 Chat Completions，经本地代理转换；Grok、Luna 与 Muse Spark 仍是原生 Responses 模型。地区限制取决于账号所在地而不是协议，因此受限模型仍会列出，选中后由网关返回 `403`。

扩展激活期间本地代理始终运行，因此 Codex 自带选择器中所有受支持的端点都可使用。

### DeepSeek 协议选择

两个 DeepSeek 模型都已在 OpenCode Go 的三种端点上完成实测，覆盖流式文本、`tool_choice: "auto"`、工具结果回传、推理输出、Codex 两轮对话，以及真实的 Codex shell 工具调用。因此目录同步会为每个模型提供三个明确选项：

| 上游模型 | Codex 模型 ID | 协议 |
|---|---|---|
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash` | Chat Completions |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-responses` | Responses |
| `deepseek-v4.1-flash` | `deepseek-v4.1-flash-anthropic` | Anthropic Messages |
| `deepseek-v4-pro` | `deepseek-v4-pro` | Chat Completions |
| `deepseek-v4-pro` | `deepseek-v4-pro-responses` | Responses |
| `deepseek-v4-pro` | `deepseek-v4-pro-anthropic` | Anthropic Messages |

原来的 ID 继续保留为向后兼容的 Chat Completions 条目。`-responses` 与 `-anthropic` 是别名：Codex 把别名发给本机代理，代理再把上游 `model` 字段改回基础 DeepSeek ID。

DeepSeek 的 thinking 模式不接受强制 `tool_choice`（例如 `{ "type": "function", "name": "..." }`）；Codex 使用 `auto`，三种协议均支持。OpenCode Go 目前也没有为 DeepSeek 实现 `/responses/compact`（返回 `404`），所以 Responses 别名并不提供远程压缩；不要只为服务端压缩而选择它。

### 安全性

- **外科手术式编辑，绝不整文件重写。** 配置逐行修改；注释、格式、未知键、其他 provider 与 `[profiles.*]` 均不受影响。扩展只改自己管理的顶层键：`model`、`model_provider`、`model_reasoning_effort`，以及目录命令使用的 `model_catalog_json`。
- **局部 provider 更新。** 认证或端口变化只重写 `[model_providers.opencode-go]` 块；旧版本遗留的 provider 块会在下次应用时清除。
- **自动备份。** `config.toml` 已存在时，真正修改前会生成 `config.toml.bak-<时间戳>`；仅保留最新 `codexgo.maxBackups`（默认 5）个。文件原本不存在时会直接创建，不产生备份。
- **幂等。** 选择与当前一致的模型时不写入、不产生备份。
- 只设置默认（profile 无关）的顶层配置——使用 `codex --profile` 时，各 profile 自己的 `model` 键不会被修改。

### 命令

| 命令 | 说明 |
|---|---|
| `OpenCode Go for Codex: 设置 OpenCode Go API 密钥` | 在 VS Code SecretStorage 中保存 / 更新 / 清除密钥。 |
| `OpenCode Go for Codex: 获取 OpenCode Go API 密钥` | 打开 OpenCode 认证页面。 |
| `OpenCode Go for Codex: 查看 OpenCode Go 额度` | 刷新状态栏中显示的套餐用量（状态栏点击同样触发）。 |
| `OpenCode Go for Codex: 将 OpenCode Go 模型同步到 Codex` | 把后台代理支持的全部模型写入 Codex 自带的选择器，并应用一个可用的顶层模型（不做探测、不发推理请求）。 |
| `OpenCode Go for Codex: 改用 Codex 内置模型列表` | 移除 `model_catalog_json` 并删除生成的目录文件。 |
| `OpenCode Go for Codex: 打开 Codex config.toml` | 在编辑器中打开配置文件。 |
| `OpenCode Go for Codex: 打开 OpenCode Go for Codex 设置` | 扩展设置。 |

### 设置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| `codexgo.codexHome` | *（空）* | 配置目录；空 = `CODEX_HOME` → `~/.codex`。 |
| `codexgo.codexExecutable` | *（空）* | 用于执行 `codex debug models` 与 `codex doctor` 的 Codex 可执行文件；留空则自动探测 CLI 或 Codex 扩展自带的二进制文件。 |
| `codexgo.maxBackups` | `5` | 保留的备份数量（1–50）。 |
| `codexgo.modelsDevMirrorUrl` | `https://modelsdev-mirror.onesoft.top/catalog.json` | models.dev 镜像回退；留空禁用。 |
| `codexgo.modelsDevMirrorToken` | *（空）* | 镜像令牌（`x-mirror-token`）。 |
| `codexgo.modelsDevUpdateInterval` | `60000` | 目录同步期间 models.dev 元数据的刷新间隔（毫秒，最小 30000）。 |
| `codexgo.showUsage` | `true` | 是否在状态栏项中显示套餐额度。 |
| `codexgo.usageRefreshInterval` | `5` | 额度刷新间隔（分钟，1–60）。 |
| `codexgo.usageDisplayWindow` | `rolling` | 状态栏正文显示哪个窗口：`rolling` / `weekly` / `monthly`。 |
| `codexgo.usageWarningThreshold` | `80` | 额度项变黄的用量百分比（取三个窗口中最差的一个）。 |
| `codexgo.usageErrorThreshold` | `95` | 额度项变红的用量百分比（取三个窗口中最差的一个）。 |
| `codexgo.proxyPort` | `15722` | 本地代理监听端口（1024-65535）。 |

### 离线行为

模型 ID 与元数据分别降级：

- **模型 ID：** 实时 `/models` → `globalState` 中上次成功的列表（14 天上限，重启仍可用）→ models.dev 的 `opencode-go` provider ID → 内置快照。
- **元数据：** 内置表提供已知协议与免费模型标记；models.dev 提供名称、上下文长度、价格、推理强度、视觉与弃用状态。models.dev 拉取失败时保留上一份内存缓存，并至少在 60 秒后才重试。

### 故障排查

- **Codex 提示无法认证** —— 确认 API 密钥已经保存，然后重载 VS Code，让扩展启动代理并重写 provider token。
- **刷新模型列表返回 401/403** —— 密钥无效或 Go 订阅未生效；重新执行「设置 API 密钥」。模型列表与推理共用同一端点族。
- **没有实时模型，只有缓存/目录/内置列表** —— 离线或被拦截；查看输出面板（*OpenCode Go for Codex*）中的降级链日志，或配置镜像。
- **同步后 Codex 的选择器里没有新模型** —— 新目录仅在 Codex 启动时读取；请重启 Codex 或重新加载 VS Code 窗口。已列出的模型之间切换是实时的。
- **提示「Codex 拒绝了生成的模型目录」** —— 已恢复此前的目录文件；若同步前存在 `config.toml`，也已恢复该文件。若使用自定义构建，请确认 `codexgo.codexExecutable` 指向可用的 `codex`。
- **Codex 没有生效** —— Codex 在启动时读取配置；请重载 Codex 会话或重启 VS Code 窗口。
- **自定义 `CODEX_HOME`** —— 若用自定义目录启动 Codex，请把 `codexgo.codexHome` 设为同一目录。
- **推理强度** —— 请使用 Codex 自带的选择器。该选择器只稳定展示有限的可见档位，因此目录同步会把上游 `max` 映射为 `XHigh`，并在模型没有 `low` 时把 `minimal` 映射为 `Low`；本地代理会在转发时把 `xhigh` 还原为上游 `max`、把 `low` 还原为 `minimal`。模型同时声明 `xhigh` 和 `max` 时，唯一的 `XHigh` 槽位代表上游 `max`。扩展不再写入 `model_reasoning_effort`；如需固定默认值，请直接编辑 `config.toml`。
- **提示 `The reasoning_text / reasoning_content in the thinking mode must be passed back to the API`** —— 重载 VS Code，确保常驻本地代理正在运行；它会修复原生 `reasoning_text` 并恢复完整缓存历史。DeepSeek thinking 模式携带 tools 时，每个历史 assistant 消息都必须带 `reasoning_content`：代理会先恢复缓存中的原始 reasoning；确实不可得时才补空字符串。代理不会插入一段捏造的思考内容。
- **提示 `input[N].call_id: expected a non-empty string`** —— Codex 回放了空 `call_id` 的工具调用或工具结果。代理现在只为真正成对的调用项和结果项生成同一个确定性 ID；没有对应调用的输出（包括新版 Codex 的 `codex_apps_*` 页面快照）会延后并作为普通 user 消息重放，不再伪造随机 ID。这样请求前缀仍可复用缓存。安装修复后的版本并重载 VS Code，然后重试该轮。
- **`proxy.start.failed` 报 `127.0.0.1:15722` 上的 `EADDRINUSE`** —— 另一个 VS Code 窗口已经持有本机代理。只要该窗口仍在运行，Codex 推理仍会正常使用同一个代理 URL 和派生 token。非持有窗口中依赖本地代理状态的扩展命令（例如目录同步）可能提示代理不可用，请在持有窗口执行。持有代理的窗口关闭后，请重载其余任一窗口，让新的扩展宿主重新绑定端口。如果不同窗口需要使用不同代理端口或 API 密钥，请使用独立的 VS Code profile，并隔离各自的 `codexgo.proxyPort`、`codexgo.codexHome` 与已保存密钥。
- **额度项显示 `OpenCode Go: add API key` / `OpenCode Go: invalid key` / `OpenCode Go: error`** —— 尚未配置密钥、额度端点返回 `401`（密钥无效或没有生效的 Go 套餐），或端点不可达。点击该项可刷新；悬停可看到具体原因和设置密钥操作。
- **对话完全没有响应** —— 所选模型的上游可能卡住（网关返回 `200`，但只发 `: keep-alive`，没有任何事件），或者该模型在你所在地区不可用（Codex 日志里会出现 `403 ... not supported`，例如 `gpt-5.6-luna`、`gpt-6-luna`、`muse-spark-*`）。换一个模型（`grok-4.6` / `grok-4.7` 是稳妥的备选）或稍后重试即可，配置不需要改。上游路由彼此独立：`/responses`、`/chat/completions` 与 `/messages` 可能分别失败或卡住。cc-switch 这类代理会把 Codex 的 Responses 请求翻译成 Chat Completions，所以在那种情况下它仍然能用；而 Codex 0.162 已移除 `wire_api = "chat"`，本扩展没有可以直接回退的 Chat Completions 通道。
- **远程压缩失败** —— 所选模型经 Chat Completions 或 Anthropic Messages 时，代理会对 `/responses/compact` 和 compaction trigger 返回 `501`；即使选择 DeepSeek 的 Responses 别名，OpenCode Go 本身也会对该端点返回 `404`。DeepSeek 目前无法使用远程压缩。
- **模型只输出纯文本、不调用工具** —— 旧版本生成的目录从 Codex 模板继承了 OpenAI 专属传输字段，工具定义因此没有到达网关。用当前版本重新执行「将 OpenCode Go 模型同步到 Codex」即可重新生成目录。

### 开发

```bash
npm install
npm run compile   # 或 npm run watch
npm test          # TOML、模型合并、目录、额度、Chat 与 Anthropic 代理测试
npm run test:e2e  # 本机 Codex CLI + 假上游的端到端测试
npm run test:live # 真实 OpenCode Go 测试，需要 OPENCODE_GO_API_KEY
npm run test:binding # Anthropic thinking 签名的真实回归测试
npm run build     # 用 vsce 打包 .vsix
```

按 `F5` 启动扩展开发宿主。单元测试在纯 Node 中运行，覆盖不依赖 `vscode` 的模块，以及本地代理和额度解析器。`test:live` 与 `test:binding` 会访问 OpenCode Go，需要设置 `OPENCODE_GO_API_KEY`。

模块地图、启动流程、代理路由与当前设计边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

</details>
