<div align="center">

# OpenCode Go Provider for Codex

[English](#english) | [中文](#中文)

</div>

## English

> [!IMPORTANT]
> This is not affiliated with, officially maintained by, or endorsed by OpenAI (Codex) or Anomaly (OpenCode). It is a third-party convenience tool.

Fetch, preview and select [OpenCode Go](https://opencode.ai/go) models for **Codex** (CLI or VS Code extension) through a native VS Code UI — then apply the selection to Codex's `config.toml` safely.

The extension is modeled on the patterns of [OpenCode Go Provider for Copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) (localization, logger, model discovery, hardened fallbacks), adapted to Codex configuration.

### What it does

- **Fetch** — pulls the live model list from `https://opencode.ai/inference/go/v1/models` (with your API key) and enriches it with [models.dev](https://models.dev) metadata: context length, pricing, reasoning options, vision, deprecation, protocol.
- **Sync** — turns every model usable in the current mode (native Responses models, plus Chat Completions and Anthropic Messages models while the local proxy is on) into a Codex model catalog, and points `model_catalog_json` at it so they show up in *Codex's own* model picker. Sends no inference requests; reversible with one command.
- **Select** — native QuickPick that leads with the models Codex can actually run, with search, badges (free / reasoning / vision / unavailable / deprecated), the current model check-marked, and toolbar buttons (refresh / set key / open config).
- **Apply** — writes `model`, `model_provider`, `model_catalog_json` and (optionally) `model_reasoning_effort` to Codex's `config.toml`, plus the matching `[model_providers.*]` block. A timestamped backup is created before every write.
- **Local proxy** — starts a loopback bridge for Chat Completions and Anthropic Messages upstreams so those models work in Codex. It replays the `reasoning_text` thinking state that OpenCode Go requires, preserves Codex session headers, and translates streaming tool calls. The proxy is the default path and can be toggled from the status bar.
- **Status** — one status bar item combines the OpenCode Go plan usage with the proxy state: `OpenCode Go Rolling: 42% · 2h 13m · Proxy: on`. Clicking the item refreshes usage; the countdown repaints every minute without a network request. The hover window carries the rolling / weekly / monthly progress bars, reset timers, proxy address, last error, the proxy toggle in the proxy block, and actions for refreshing usage, setting the key, syncing models, opening `config.toml`, or restarting the extension host.

### Quick start

1. Subscribe to OpenCode Go at [opencode.ai/auth](https://opencode.ai/auth) and copy an API key.
2. `Ctrl+Shift+P` → **OpenCode Go for Codex: Set OpenCode Go API Key**.
3. `Ctrl+Shift+P` → **OpenCode Go for Codex: Sync OpenCode Go Models to Codex** — installs the usable OpenCode Go models into Codex's own picker (no inference requests are sent).
4. `Ctrl+Shift+P` → **OpenCode Go for Codex: Select Model for Codex**, pick a model.
5. Make the key visible to Codex (see below), then **restart VS Code**.

> [!IMPORTANT]
> **Codex reads the API key from an environment variable, not from VS Code.** The extension writes `env_key = "OPENCODE_GO_API_KEY"` into the provider block; Codex resolves that variable from *its own* process environment. A key stored only in SecretStorage powers the model list but is invisible to Codex. After saving your key the command offers:
> - **Set for VS Code Terminals** — adds the variable to terminals spawned by VS Code (good for Codex CLI in the integrated terminal; restart the terminal).
> - **Copy Environment Setup Command** — e.g. `setx OPENCODE_GO_API_KEY "..."` on Windows (user-level, permanent). Run it, then restart VS Code so the Codex extension process inherits it.

### What gets written

```toml
model = "deepseek-v4.1-flash"
model_provider = "opencode-go"
model_catalog_json = "opencode-go-models.json"

[model_providers.opencode-go]
name = "OpenCode Go"
base_url = "https://opencode.ai/inference/go/v1"
env_key = "OPENCODE_GO_API_KEY"
wire_api = "responses"
```

> [!NOTE]
> Codex 0.162+ accepts **only** `wire_api = "responses"`; `wire_api = "chat"` was hard-removed ([openai/codex#7782](https://github.com/openai/codex/pull/7782)) and now makes the whole config fail to load. The extension therefore maintains a single `opencode-go` provider and always writes `responses`. Leftover `[model_providers.opencode-go-responses]` / `[model_providers.opencode-go-chat]` blocks from older versions are deleted on the next apply.

### Codex's own model picker

Codex's picker (the CLI `/model` command and the model list in the Codex VS Code extension) is not extensible through settings: it is fed by the app-server `model/list` RPC, which reads the file named by the top-level `model_catalog_json` key. That key **replaces** the built-in list rather than extending it, which is why the catalog contains the usable OpenCode Go models only — the built-in Codex models are not merged in.

**OpenCode Go for Codex: Sync OpenCode Go Models to Codex** does the whole job:

1. pulls the live model list;
2. keeps the models usable in the current mode — native Responses models, plus Chat Completions and Anthropic Messages models when the local proxy is running;
3. takes a known-good catalog entry from the Codex installation you actually have (`codex debug models`) and rewrites the per-model fields, so the entry schema always matches your Codex version. The first-party-only transports a stock entry may carry (`use_responses_lite`, code-mode `tool_mode`, first-party `experimental_supported_tools`) are stripped, because a third-party gateway cannot see the tools they move out of the request;
4. writes `<CODEX_HOME>/opencode-go-models.json` (UTF-8, no BOM) and sets `model_catalog_json`;
5. runs `codex doctor`, and **rolls the catalog and `config.toml` back if Codex rejects the result**, so a bad catalog can never survive.

> [!IMPORTANT]
> A *new* catalog is only read when Codex starts (the app-server caches it), so a sync needs a Codex restart or a VS Code window reload — the notification offers the reload. **Switching between models that are already listed is live** and needs no restart.

**OpenCode Go for Codex: Use Codex's Built-in Model List** removes `model_catalog_json` and deletes the generated file, returning Codex to its stock list.

### Which OpenCode Go models work with Codex?

| OpenCode Go endpoint | AI SDK package | Verdict |
|---|---|---|
| `/go/v1/responses` | `@ai-sdk/openai` | ✅ direct, or through the local proxy |
| `/go/v1/chat/completions` | `@ai-sdk/openai-compatible` | ✅ through the local proxy; ❌ direct (Codex 0.162+ removed Chat Completions) |
| `/go/v1/messages` | `@ai-sdk/anthropic` | ✅ through the local proxy; ❌ direct (Codex has no Anthropic Messages support) |

The built-in snapshot in `src/hardcodedModels.ts` mirrors the official OpenCode Go endpoint table: DeepSeek is a Chat Completions model and is served through the local proxy, while Grok, Luna and Muse Spark remain native Responses models. A region-blocked model stays listed; selecting it returns the gateway's `403` at runtime.

Region blocks are a runtime property of your account's location, not of the protocol, so a region-blocked model stays listed; if you pick one, OpenCode Go returns `403` and Codex reports it.

In the extension's own picker, Chat Completions and Anthropic Messages models become usable while the local proxy is running. Models in either group while the proxy is off are grouped under **Not usable by the current mode** (hidden when `codexgo.showUnsupportedModels` is off).

### Safety

- **Surgical edits, never a rewrite.** The config file is edited line-by-line; comments, formatting, unknown keys, other providers and `[profiles.*]` blocks are left untouched. The default `model` / `model_provider` / `model_reasoning_effort` **top-level** keys are the only global keys touched.
- **Backups.** `config.toml.bak-<timestamp>` is created before every change; only the newest `codexgo.maxBackups` (default 5) are kept.
- **Idempotent.** Selecting the model that is already configured performs no write and no backup.
- The extension only sets a profile-agnostic default — if you launch Codex with `--profile`, that profile's own `model` keys are not modified.

### Commands

| Command | Description |
|---|---|
| `OpenCode Go for Codex: Select Model for Codex` | Open the picker (also the status bar click action). |
| `OpenCode Go for Codex: Set OpenCode Go API Key` | Store / update / clear the key; offers env-var setup helpers. |
| `OpenCode Go for Codex: Get OpenCode Go API Key` | Open the OpenCode auth page. |
| `OpenCode Go for Codex: Check OpenCode Go Usage` | Refresh the plan usage shown in the status bar. |
| `OpenCode Go for Codex: Toggle OpenCode Go Local Proxy` | Start or stop the loopback proxy and repoint the provider between the local and direct endpoints. |
| `OpenCode Go for Codex: Update Model List (forced)` | Force a refresh of catalog + live list. |
| `OpenCode Go for Codex: Sync OpenCode Go Models to Codex` | Put the models usable in the current mode into Codex's own model picker (no probing, no inference requests). |
| `OpenCode Go for Codex: Use Codex's Built-in Model List` | Remove `model_catalog_json` and the generated catalog file. |
| `OpenCode Go for Codex: Open Codex config.toml` | Open the config file in the editor. |
| `OpenCode Go for Codex: Open OpenCode Go for Codex Settings` | Extension settings. |

### Settings

| Setting | Default | Description |
|---|---|---|
| `codexgo.apiKeyEnvVar` | `OPENCODE_GO_API_KEY` | Environment variable name written to `env_key`. |
| `codexgo.codexHome` | *(empty)* | Config directory; empty = `CODEX_HOME` → `~/.codex`. |
| `codexgo.codexExecutable` | *(empty)* | Codex executable used for `codex debug models` and `codex doctor`; empty = auto-detect CLI or the Codex extension's bundled binary. |
| `codexgo.maxBackups` | `5` | Timestamped backups to keep (1–50). |
| `codexgo.showUnsupportedModels` | `true` | Show models that need a disabled local proxy or are otherwise unavailable. |
| `codexgo.showDeprecatedModels` | `false` | Show catalog-deprecated models. |
| `codexgo.modelsDevMirrorUrl` | `https://modelsdev-mirror.onesoft.top/catalog.json` | models.dev mirror fallback; empty disables. |
| `codexgo.modelsDevMirrorToken` | *(empty)* | Token for the mirror (`x-mirror-token`). |
| `codexgo.modelsDevUpdateInterval` | `60000` | Refresh interval (ms, min 30000). |
| `codexgo.showUsage` | `true` | Show the OpenCode Go plan usage status bar item. |
| `codexgo.usageRefreshInterval` | `5` | Usage refresh interval in minutes (1–60). |
| `codexgo.usageDisplayWindow` | `rolling` | Window shown in the status bar text: `rolling` / `weekly` / `monthly`. |
| `codexgo.usageWarningThreshold` | `80` | Usage % at which the item turns yellow (worst of the three windows). |
| `codexgo.usageErrorThreshold` | `95` | Usage % at which the item turns red (worst of the three windows). |
| `codexgo.proxyEnabled` | `true` | Run the loopback Chat Completions / Anthropic Messages proxy and keep the provider pointed at it. Turning it off restores the direct endpoint. |
| `codexgo.proxyPort` | `15722` | Loopback proxy port (1024-65535). |

### Offline behaviour

Model data degrades through a chain, never to an empty list:
live API list → last persisted API list (14-day cap, survives restarts) → models.dev catalog (official → mirror) → built-in snapshot of the docs endpoint table.

### Troubleshooting

- **Codex still says it cannot authenticate** — the `env_key` variable is not in Codex's environment. Set it at user level and fully **restart VS Code** (processes inherit the environment at launch; `setx` does not affect running windows).
- **HTTP 401/403 when refreshing the model list** — the key is invalid or the Go subscription is inactive; re-run *Set API Key*. Note the model list uses the same endpoint family as inference.
- **No live models, only catalog/built-in** — offline or blocked; check the Output panel (*OpenCode Go for Codex*) for the fetch chain log, or configure a mirror.
- **The synced models do not appear in Codex's picker** — a new catalog is read at Codex start-up only. Restart Codex or reload the VS Code window; switching between already-listed models is live.
- **"Codex rejected the generated model catalog"** — the config was rolled back, nothing is broken. Check that `codexgo.codexExecutable` points at a working `codex` if you use a custom build.
- **The model answers in plain text instead of calling tools** — a catalog synced by an older build inherited OpenAI-only transports from the Codex template, so the tools never reached the gateway. Re-run *Sync OpenCode Go Models to Codex* with this version to regenerate the catalog.
- **Codex ignores the change** — Codex reads its config at startup; reload/restart the Codex session or VS Code window.
- **`codexHome` in a portable setup** — if you launch Codex with a custom `CODEX_HOME`, set `codexgo.codexHome` to the same directory.
- **Reasoning effort** — only `minimal` / `low` / `medium` / `high` are offered (the values Codex accepts); "Default" removes `model_reasoning_effort` entirely.
- **`The reasoning_text in the thinking mode must be passed back to the API`** — Codex kept the thinking text as `summary_text` but sent `content: null` on the next turn. Keep the local proxy enabled; it restores the `reasoning_text` item before forwarding to OpenCode Go.
- **The usage item shows `OpenCode Go: add API key` / `OpenCode Go: invalid key` / `OpenCode Go: error`** — no key is configured, the key was rejected (401/403), or the endpoint is unreachable. Click the item to refresh; hover it for the reason and the set-key action.
- **Chat shows no reply at all** — the selected model's upstream can be stuck (the gateway answers `200` and only sends `: keep-alive`, with no events) or the model may be blocked in your region (the Codex log shows `403 ... not supported`, e.g. `gpt-5.6-luna`, `gpt-6-luna`, `muse-spark-*` outside their supported regions). Switch to another model (`grok-4.6` / `grok-4.7` are good fallbacks) or retry later — nothing needs reconfiguring. Note that the two upstream routes are independent: a model can be healthy on `/chat/completions` while `/responses` hangs. Proxies such as cc-switch translate Codex's Responses requests into Chat Completions, so they keep working in exactly that case; Codex 0.162 removed `wire_api = "chat"`, so this extension has no direct Chat Completions route to fall back to.

### Development

```bash
npm install
npm run compile   # or: npm run watch
npm test          # unit tests for the TOML editor + model merge
npm run build     # package a .vsix with vsce
```

Press `F5` to launch an Extension Development Host. The unit tests run in plain Node against the compiled modules that have no `vscode` dependency (`out/tomlEdit.js`, `out/modelInfo.js`, `out/codexConfigFile.js`, `out/catalog.js`).

---

## 中文

> [!IMPORTANT]
> 本项目与 OpenAI（Codex）和 Anomaly（OpenCode）均无隶属或官方背书关系，仅为第三方便捷工具。

通过 VS Code 原生界面**拉取、预览并选择** [OpenCode Go](https://opencode.ai/go) 模型，供 **Codex**（CLI 或 VS Code 扩展）使用，并把选择安全地写入 Codex 的 `config.toml`。

实现参考了 [OpenCode Go Provider for Copilot](https://github.com/OnesoftQwQ/opencode-go-copilot) 的模式（本地化、日志、模型发现、坚硬的降级链），并针对 Codex 配置做了适配。

### 功能

- **拉取** — 用你的 API 密钥从 `https://opencode.ai/inference/go/v1/models` 获取实时模型列表，并用 [models.dev](https://models.dev) 元数据补充：上下文长度、价格、推理选项、视觉、弃用状态、协议。
- **同步** — 把当前模式下可用的模型（原生 Responses 模型，加上代理开启时的 Chat Completions 与 Anthropic Messages 模型）生成为 Codex 模型目录，并让 `model_catalog_json` 指向它，从而出现在 **Codex 自带的选择器**里；不发送推理请求，一条命令即可撤销。
- **选择** — 原生 QuickPick，优先展示 Codex 真正能用的模型，支持搜索、徽章（免费 / 推理 / 视觉 / 不可用 / 已弃用）、当前模型打勾、工具栏按钮（刷新 / 设置密钥 / 打开配置文件）。
- **应用** — 将 `model`、`model_provider`、`model_catalog_json`（可选 `model_reasoning_effort`）及对应 `[model_providers.*]` 块写入 Codex `config.toml`；每次写入前自动创建带时间戳的备份。
- **本地代理** —— 在扩展宿主中启动仅本机可访问的 Chat Completions / Anthropic Messages 桥接服务，让只支持这两种协议的模型也能在 Codex 中使用；代理会回传 OpenCode Go 要求的 `reasoning_text` 思考状态、保留 Codex 会话头，并转换流式工具调用。代理是默认路径，可从状态栏一键开关。
- **状态栏** —— 将 OpenCode Go 套餐用量与代理状态合并为一个状态栏项：`OpenCode Go Rolling: 42% · 2h 13m · Proxy: on`。点击状态栏刷新额度；倒计时每分钟重绘一次，不会重新请求网络。悬停窗口内显示滚动 / 周 / 月三个窗口的进度条、重置时间、代理地址、最近错误；代理开关位于 Proxy 区块内，操作区还提供刷新额度、设置密钥、同步模型、打开 `config.toml` 和重启扩展宿主。

### 快速开始

1. 在 [opencode.ai/auth](https://opencode.ai/auth) 订阅 OpenCode Go 并复制 API 密钥。
2. `Ctrl+Shift+P` → **OpenCode Go for Codex: 设置 OpenCode Go API 密钥**。
3. `Ctrl+Shift+P` → **OpenCode Go for Codex: 将 OpenCode Go 模型同步到 Codex** —— 把当前可用的 OpenCode Go 模型写入 Codex 自带的选择器（不发送推理请求）。
4. `Ctrl+Shift+P` → **OpenCode Go for Codex: 为 Codex 选择模型**，选择模型。
5. 让 Codex 能看到密钥（见下），然后**重启 VS Code**。

> [!IMPORTANT]
> **Codex 从环境变量读取密钥，而不是从 VS Code。** 扩展会写入 `env_key = "OPENCODE_GO_API_KEY"`，Codex 从**它自己的进程环境**解析该变量。仅存在 SecretStorage 中的密钥能用于拉取模型列表，但 Codex 看不到。保存密钥后命令会提供：
> - **为 VS Code 终端设置** — 为 VS Code 拉起的终端注入该变量（适合在集成终端运行 Codex CLI；需重启终端）。
> - **复制环境变量设置命令** — 例如 Windows 的 `setx OPENCODE_GO_API_KEY "..."`（用户级、永久）。执行后重启 VS Code，使 Codex 扩展进程继承新环境。

### 写入的内容

```toml
model = "deepseek-v4.1-flash"
model_provider = "opencode-go"
model_catalog_json = "opencode-go-models.json"

[model_providers.opencode-go]
name = "OpenCode Go"
base_url = "https://opencode.ai/inference/go/v1"
env_key = "OPENCODE_GO_API_KEY"
wire_api = "responses"
```

> [!NOTE]
> Codex 0.162+ **只** 接受 `wire_api = "responses"`；`wire_api = "chat"` 已被硬性移除（[openai/codex#7782](https://github.com/openai/codex/pull/7782)），保留它会导致整个配置无法加载。因此扩展只维护一个 `opencode-go` provider，并始终写入 `responses`；旧版本留下的 `[model_providers.opencode-go-responses]` / `[model_providers.opencode-go-chat]` 块会在下次应用时被删除。

### Codex 自带的选择器

Codex 的选择器（CLI 的 `/model` 命令、Codex VS Code 扩展中的模型列表）无法通过设置扩展：它由 app-server 的 `model/list` RPC 提供，而该 RPC 读取顶层 `model_catalog_json` 指向的文件。该键是**替换**内置列表而非追加，因此目录中只包含可用的 OpenCode Go 模型——不会混入 Codex 内置模型。

**OpenCode Go for Codex: 将 OpenCode Go 模型同步到 Codex** 一次完成全部工作：

1. 拉取实时模型列表；
2. 只保留当前模式下可用的模型 —— 原生 Responses 模型，以及本地代理运行时的 Chat Completions 与 Anthropic Messages 模型；
3. 从你**本机实际安装的** Codex 取一条已知可用的目录条目（`codex debug models`），再覆盖其中的模型字段，从而保证条目结构与你的 Codex 版本完全一致；同时会剥离模板里可能带有的第一方专属传输字段（`use_responses_lite`、代码模式 `tool_mode`、第一方 `experimental_supported_tools`），因为第三方网关看不到这些字段搬走的工具定义；
4. 写入 `<CODEX_HOME>/opencode-go-models.json`（UTF-8、无 BOM）并设置 `model_catalog_json`；
5. 运行 `codex doctor`；**若 Codex 拒绝该配置，则把目录文件与 `config.toml` 一起回滚**，坏目录绝不会留在磁盘上。

> [!IMPORTANT]
> **新**目录只在 Codex 启动时读取（app-server 会缓存），因此同步后需要重启 Codex 或重新加载 VS Code 窗口——提示消息中会提供「重新加载窗口」。而在**已列出的模型之间切换是实时的**，无需重启。

**OpenCode Go for Codex: 改用 Codex 内置模型列表** 会移除 `model_catalog_json` 并删除生成的目录文件，让 Codex 回到自带的列表。

### 哪些模型可用于 Codex？

| OpenCode Go 端点 | AI SDK 包 | 结论 |
|---|---|---|
| `/go/v1/responses` | `@ai-sdk/openai` | ✅ 可直连，也可经本地代理 |
| `/go/v1/chat/completions` | `@ai-sdk/openai-compatible` | ✅ 经本地代理可用；❌ 直连不可用（Codex 0.162+ 已移除 Chat Completions） |
| `/go/v1/messages` | `@ai-sdk/anthropic` | ✅ 经本地代理可用；❌ 直连不可用（Codex 不支持 Anthropic Messages） |

`src/hardcodedModels.ts` 中的内置快照现在与 OpenCode Go 官方端点表保持一致：DeepSeek 属于 Chat Completions 模型，经本地代理转换；Grok、Luna 与 Muse Spark 仍是原生 Responses 模型。被地区限制的模型仍会列出，选中后由网关在运行时返回 `403`。

地区限制是账号所在地的运行时属性，而非协议属性，因此被地区限制的模型仍会出现在列表中；一旦选中，OpenCode Go 返回 `403`，Codex 会直接报错。

在扩展自带的选择器中，本地代理开启时 Chat Completions 与 Anthropic Messages 模型都可用；代理关闭时这两类模型归入 **「当前模式不可用」** 分组（关闭 `codexgo.showUnsupportedModels` 时隐藏）。

### 安全性

- **外科手术式编辑，绝不整文件重写。** 配置逐行修改；注释、格式、未知键、其他 provider 与 `[profiles.*]` 均不受影响。只改顶层 `model` / `model_provider` / `model_reasoning_effort`。
- **自动备份。** 每次修改前生成 `config.toml.bak-<时间戳>`；仅保留最新 `codexgo.maxBackups`（默认 5）个。
- **幂等。** 选择与当前一致的模型时不写入、不产生备份。
- 只设置默认（profile 无关）的顶层配置——使用 `codex --profile` 时，各 profile 自己的 `model` 键不会被修改。

### 命令

| 命令 | 说明 |
|---|---|
| `OpenCode Go for Codex: 为 Codex 选择模型` | 打开选择器（状态栏点击同样触发）。 |
| `OpenCode Go for Codex: 设置 OpenCode Go API 密钥` | 保存 / 更新 / 清除密钥，并提供环境变量设置辅助。 |
| `OpenCode Go for Codex: 获取 OpenCode Go API 密钥` | 打开 OpenCode 认证页面。 |
| `OpenCode Go for Codex: 查看 OpenCode Go 额度` | 刷新状态栏中显示的套餐用量。 |
| `OpenCode Go for Codex: 切换 OpenCode Go 本地代理` | 启动或停止本地代理，并在本地地址与直连地址之间切换 provider。 |
| `OpenCode Go for Codex: 更新模型列表（强制）` | 强制刷新目录与实时列表。 |
| `OpenCode Go for Codex: 将 OpenCode Go 模型同步到 Codex` | 把当前模式下可用的模型写入 Codex 自带的选择器（不做探测、不发推理请求）。 |
| `OpenCode Go for Codex: 改用 Codex 内置模型列表` | 移除 `model_catalog_json` 并删除生成的目录文件。 |
| `OpenCode Go for Codex: 打开 Codex config.toml` | 在编辑器中打开配置文件。 |
| `OpenCode Go for Codex: 打开 OpenCode Go for Codex 设置` | 扩展设置。 |

### 设置项

| 设置 | 默认值 | 说明 |
|---|---|---|
| `codexgo.apiKeyEnvVar` | `OPENCODE_GO_API_KEY` | 写入 `env_key` 的环境变量名。 |
| `codexgo.codexHome` | *（空）* | 配置目录；空 = `CODEX_HOME` → `~/.codex`。 |
| `codexgo.codexExecutable` | *（空）* | 用于执行 `codex debug models` 与 `codex doctor` 的 Codex 可执行文件；留空则自动探测 CLI 或 Codex 扩展自带的二进制文件。 |
| `codexgo.maxBackups` | `5` | 保留的备份数量（1–50）。 |
| `codexgo.showUnsupportedModels` | `true` | 显示需要启用本地代理或当前不可用的模型。 |
| `codexgo.showDeprecatedModels` | `false` | 显示目录中已弃用的模型。 |
| `codexgo.modelsDevMirrorUrl` | `https://modelsdev-mirror.onesoft.top/catalog.json` | models.dev 镜像回退；留空禁用。 |
| `codexgo.modelsDevMirrorToken` | *（空）* | 镜像令牌（`x-mirror-token`）。 |
| `codexgo.modelsDevUpdateInterval` | `60000` | 刷新间隔（毫秒，最小 30000）。 |
| `codexgo.showUsage` | `true` | 是否在状态栏显示 OpenCode Go 套餐额度。 |
| `codexgo.usageRefreshInterval` | `5` | 额度刷新间隔（分钟，1–60）。 |
| `codexgo.usageDisplayWindow` | `rolling` | 状态栏正文显示哪个窗口：`rolling` / `weekly` / `monthly`。 |
| `codexgo.usageWarningThreshold` | `80` | 额度项变黄的用量百分比（取三个窗口中最差的一个）。 |
| `codexgo.usageErrorThreshold` | `95` | 额度项变红的用量百分比（取三个窗口中最差的一个）。 |
| `codexgo.proxyEnabled` | `true` | 运行仅本机可访问的 Chat Completions / Anthropic Messages 代理，并让 provider 指向它；关闭后恢复直连地址。 |
| `codexgo.proxyPort` | `15722` | 本地代理监听端口（1024-65535）。 |

### 离线行为

模型数据按链条降级，永远不会为空列表：
实时 API 列表 → 上次持久化的列表（14 天上限，重启仍可用）→ models.dev 目录（官方 → 镜像）→ 内置的文档端点表快照。

### 故障排查

- **Codex 提示无法认证** —— `env_key` 变量不在 Codex 的环境中。请设置用户级变量并**完全重启 VS Code**（进程在启动时继承环境，`setx` 不影响已运行的窗口）。
- **刷新模型列表返回 401/403** —— 密钥无效或 Go 订阅未生效；重新执行「设置 API 密钥」。模型列表与推理共用同一端点族。
- **没有实时模型，只有目录/内置列表** —— 离线或被拦截；查看输出面板（*OpenCode Go for Codex*）中的降级链日志，或配置镜像。
- **同步后 Codex 的选择器里没有新模型** —— 新目录仅在 Codex 启动时读取；请重启 Codex 或重新加载 VS Code 窗口。已列出的模型之间切换是实时的。
- **提示「Codex 拒绝了生成的模型目录」** —— 配置已被回滚，未造成损坏。若使用自定义构建，请确认 `codexgo.codexExecutable` 指向可用的 `codex`。
- **Codex 没有生效** —— Codex 在启动时读取配置；请重载 Codex 会话或重启 VS Code 窗口。
- **自定义 `CODEX_HOME`** —— 若用自定义目录启动 Codex，请把 `codexgo.codexHome` 设为同一目录。
- **推理强度** —— 仅提供 Codex 接受的值 `minimal` / `low` / `medium` / `high`；选择「默认」会移除 `model_reasoning_effort`。
- **提示 `The reasoning_text in the thinking mode must be passed back to the API`** —— Codex 把思考内容保留为 `summary_text`，下一轮却发送 `content: null`。请保持本地代理开启；代理会在转发前恢复 `reasoning_text`。
- **额度项显示 `OpenCode Go: add API key` / `OpenCode Go: invalid key` / `OpenCode Go: error`** —— 尚未配置密钥、密钥被拒绝（401/403），或端点不可达。点击该项可刷新；悬停可看到具体原因和设置密钥操作。
- **对话完全没有响应** —— 所选模型的上游可能卡住（网关返回 `200`，但只发 `: keep-alive`，没有任何事件），或者该模型在你所在地区不可用（Codex 日志里会出现 `403 ... not supported`，例如 `gpt-5.6-luna`、`gpt-6-luna`、`muse-spark-*`）。换一个模型（`grok-4.6` / `grok-4.7` 是稳妥的备选）或稍后重试即可，配置不需要改。注意两条上游路由是相互独立的：模型可能在 `/chat/completions` 上正常，而 `/responses` 卡住。cc-switch 这类代理会把 Codex 的 Responses 请求翻译成 Chat Completions，所以在那种情况下它仍然能用；而 Codex 0.162 已移除 `wire_api = "chat"`，本扩展没有可以直接回退的 Chat Completions 通道。
- **模型只输出纯文本、不调用工具** —— 旧版本生成的目录从 Codex 模板继承了 OpenAI 专属传输字段，工具定义因此没有到达网关。用当前版本重新执行「将 OpenCode Go 模型同步到 Codex」即可重新生成目录。

### 开发

```bash
npm install
npm run compile   # 或 npm run watch
npm test          # TOML 编辑器 + 模型合并的单元测试
npm run build     # 用 vsce 打包 .vsix
```

按 `F5` 启动扩展开发宿主。单元测试在纯 Node 中运行于不依赖 `vscode` 的编译产物（`out/tomlEdit.js`、`out/modelInfo.js`、`out/codexConfigFile.js`、`out/catalog.js`）。
