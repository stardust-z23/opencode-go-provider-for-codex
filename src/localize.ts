/**
 * 基于字典的本地化（沿用 OpenCode Go Provider for Copilot 的做法：不需要
 * `vscode.l10n` 语言包，而是用英文原文作键的 zh-CN 表，依据
 * `vscode.env.language` 选择）。
 */

import * as vscode from "vscode";

const zhCN: Record<string, string> = {
	// ── 状态栏 ──
	"OpenCode Go for Codex": "OpenCode Go for Codex",
	"Codex: {0}": "Codex：{0}",
	"Codex: not configured": "Codex：未配置",
	"Model": "模型",
	"Provider": "提供商",
	"Config file": "配置文件",
	"API key": "API 密钥",
	"configured": "已配置",
	"not configured": "未配置",
	"Reasoning effort": "推理强度",
	"Click to open the model picker.": "点击打开模型选择器。",

	// ── 选择器 ──
	"Select OpenCode Go Model for Codex": "为 Codex 选择 OpenCode Go 模型",
	"Type to filter by name or model ID": "输入以按名称或模型 ID 过滤",
	"Refresh": "刷新",
	"Set API Key": "设置 API 密钥",
	"Open Codex config.toml": "打开 Codex config.toml",
	"Usable with Codex": "Codex 可用",
	"Not usable by this Codex build": "当前 Codex 构建不可用",
	"Not usable in the current mode": "当前模式不可用",
	"unavailable": "不可用",
	"No models found. Try refreshing the model list.": "未找到模型。请尝试刷新模型列表。",
	"Loading OpenCode Go models…": "正在加载 OpenCode Go 模型…",
	"Free": "免费",
	"deprecated": "已弃用",
	"vision": "视觉",
	"reasoning": "推理",
	"assumed protocol": "协议为推测",
	"{0} ctx": "{0} 上下文",
	"{0} / {1} per 1M": "{0} / {1} 每百万 token",
	"Select Reasoning Effort": "选择推理强度",
	"Pick how hard the model should think before answering.": "选择模型回答前的思考深度。",
	"Default (leave model_reasoning_effort unset)": "默认（不设置 model_reasoning_effort）",
	"Minimal": "最低",
	"Low": "低",
	"Medium": "中",
	"High": "高",
	"Fastest responses; least thinking.": "响应最快，几乎不思考。",
	"Slightly more thinking than minimal.": "比最低稍多思考。",
	"Balanced thinking and speed.": "思考与速度均衡。",
	"Deepest thinking; slowest responses.": "思考最深，响应最慢。",
	"The model “{0}” uses a protocol this extension cannot adapt. Nothing was changed.": "模型「{0}」使用的协议当前扩展无法适配。未做任何更改。",
	"Copy Model ID": "复制模型 ID",
	"Model ID copied to clipboard.": "模型 ID 已复制到剪贴板。",
	"The model “{0}” is only served over the Chat Completions API, which Codex 0.162+ no longer supports. Nothing was changed.": "模型「{0}」仅通过 Chat Completions API 提供服务，Codex 0.162+ 已不再支持该协议。未做任何更改。",

	// ── 应用结果 ──
	"Codex config created: “{0}” (provider: {1}).": "已创建 Codex 配置：「{0}」（提供商：{1}）。",
	"Codex config updated: “{0}” (provider: {1}).": "已更新 Codex 配置：「{0}」（提供商：{1}）。",
	"Codex is already configured to use “{0}”.": "Codex 已配置为使用「{0}」。",
	"Codex config backed up to: {0}": "Codex 配置已备份至：{0}",
	"{0} is not set in the environment Codex sees. Codex may fail to authenticate — set it and restart VS Code.": "Codex 所读取的环境中未设置 {0}。Codex 可能无法完成认证——请设置该变量并重启 VS Code。",
	"Setup Instructions": "设置说明",

	// ── API 密钥 ──
	"OpenCode Go API Key": "OpenCode Go API 密钥",
	"Update your OpenCode Go API key": "更新您的 OpenCode Go API 密钥",
	"Enter your OpenCode Go API key": "输入您的 OpenCode Go API 密钥",
	"OpenCode Go API key saved.": "OpenCode Go API 密钥已保存。",
	"OpenCode Go API key cleared.": "OpenCode Go API 密钥已清除。",
	"Set for VS Code Terminals": "为 VS Code 终端设置",
	"Copy Environment Setup Command": "复制环境变量设置命令",
	"Environment variable {0} set for this workspace's VS Code terminals. Restart terminals to apply it. Note: the Codex extension process reads a user-level environment variable — see the README.": "已为本工作区的 VS Code 终端设置环境变量 {0}。重启终端后生效。注意：Codex 扩展进程读取的是用户级环境变量——详见 README。",
	"Copied. Paste it into a terminal, then restart VS Code so Codex can read {0}.": "已复制。请粘贴到终端执行，然后重启 VS Code 以便 Codex 读取 {0}。",
	"Codex reads the API key from an environment variable": "Codex 通过环境变量读取 API 密钥",
	"Codex resolves {0} from its own process environment, so a key stored only in VS Code's SecretStorage is not enough. Set a user-level environment variable and restart VS Code:\n\n{1}\n\nAlternatively, use “Set for VS Code Terminals” for terminals started by VS Code (the Codex extension process itself still needs the user-level variable).": "Codex 从自身进程环境读取 {0}，因此仅保存在 VS Code SecretStorage 中的密钥还不够。请设置用户级环境变量并重启 VS Code：\n\n{1}\n\n也可以在命令中选择「为 VS Code 终端设置」（但 Codex 扩展进程本身仍需要用户级变量）。",
	"Copy Setup Command": "复制设置命令",

	// ── 额度 ──
	"OpenCode Go usage": "OpenCode Go 额度",
	"OpenCode Go status": "OpenCode Go 状态",
	"OpenCode Go local proxy": "OpenCode Go 本地代理",
	"Proxy: {0}": "代理：{0}",
	"on": "开启",
	"off": "关闭",
	"starting": "启动中",
	"error": "错误",
	"Address": "地址",
	"Last error": "最近错误",
	"Click to toggle the local proxy.": "点击切换本地代理。",
	"Click the status item to refresh usage.": "点击状态栏可刷新额度。",
	"Actions": "操作",
	"Turn proxy on": "开启代理",
	"Turn proxy off": "关闭代理",
	"Check usage": "刷新额度",
	"Set API key": "设置密钥",
	"Sync models": "同步模型",
	"Open config.toml": "打开 config.toml",
	"OpenCode Go local proxy is already running.": "OpenCode Go 本地代理已在运行。",
	"Set an OpenCode Go API key before enabling the local proxy.": "启用本地代理前请先设置 OpenCode Go API 密钥。",
	"OpenCode Go local proxy enabled. Restart Codex to reload the model list.": "OpenCode Go 本地代理已启用。请重启 Codex 以重新加载模型列表。",
	"Could not start the OpenCode Go local proxy: {0}": "无法启动 OpenCode Go 本地代理：{0}",
	"OpenCode Go local proxy disabled. Codex is back on the direct endpoint.": "OpenCode Go 本地代理已关闭，Codex 已恢复直连地址。",
	"Could not disable the OpenCode Go local proxy: {0}": "无法关闭 OpenCode Go 本地代理：{0}",
	"Could not restart the OpenCode Go local proxy: {0}": "无法重启 OpenCode Go 本地代理：{0}",
	"OC Go": "OC Go",
	"OpenCode Go": "OpenCode Go",
	"OpenCode Go: add API key": "OpenCode Go：添加 API 密钥",
	"OpenCode Go: loading...": "OpenCode Go：加载中…",
	"OpenCode Go: invalid key": "OpenCode Go：密钥无效",
	"OpenCode Go: error": "OpenCode Go：错误",
	"OpenCode Go {0}: {1}": "OpenCode Go {0}：{1}",
	"Restart Extension Host": "重启扩展宿主",
	"The model “{0}” needs the OpenCode Go local proxy. Enable it from the status bar and try again.": "模型「{0}」需要 OpenCode Go 本地代理。请从状态栏启用后重试。",
	"Rolling": "滚动",
	"Weekly": "周",
	"Monthly": "月",
	"limit": "已用尽",
	"Window": "窗口",
	"Usage": "用量",
	"Resets in": "重置倒计时",
	"Updated {0}": "更新于 {0}",
	"Last updated:": "最后更新：",
	"Auto refresh:": "自动更新：",
	"OC Go: add API key": "OC Go：添加 API 密钥",
	"OC Go: loading...": "OC Go：加载中…",
	"OC Go: invalid key": "OC Go：密钥无效",
	"OC Go: error": "OC Go：错误",
	"OC Go {0}: {1}": "OC Go {0}：{1}",
	"OpenCode Go - {0} Usage: {1}": "OpenCode Go - {0} 用量：{1}",
	"No OpenCode Go API key configured. Click to add one.": "未配置 OpenCode Go API 密钥，点击添加。",
	"The active API key was rejected (401/403). Click to set a new one.": "当前 API 密钥被拒绝（401/403），点击重新设置。",
	"OpenCode Go usage is unavailable: {0}": "OpenCode Go 额度不可用：{0}",
	"Go usage is temporarily unavailable.": "Go 额度暂时不可用。",
	"After the Go quota runs out, usage falls back to your balance.": "Go 额度用尽后会回落到账户余额。",
	"OpenCode Go usage: {0}": "OpenCode Go 额度：{0}",

	// ── 模型目录同步 ──
	"Syncing OpenCode Go models into Codex…": "正在将 OpenCode Go 模型同步到 Codex…",
	"Fetching the model list…": "正在获取模型列表…",
	"Building the Codex model catalog…": "正在生成 Codex 模型目录…",
	"Synced {0} usable models into Codex's model picker ({1} skipped). Restart Codex or reload VS Code to see them.": "已将 {0} 个可用模型同步到 Codex 的模型选择器（跳过 {1} 个）。请重启 Codex 或重新加载 VS Code 以生效。",
	"Restored Codex's built-in model list. Restart Codex or reload VS Code to apply.": "已恢复 Codex 内置模型列表。请重启 Codex 或重新加载 VS Code 以生效。",
	"Codex is already using its built-in model list.": "Codex 正在使用内置模型列表。",
	"No API key configured. Set one to pull the model list.": "未配置 API 密钥。请先设置密钥以拉取模型列表。",
	"OpenCode Go returned no models.": "OpenCode Go 未返回任何模型。",
	"None of the OpenCode Go models are served over the Responses API, which Codex requires. See the log for details.": "没有任何 OpenCode Go 模型通过 Responses API 提供服务，而 Codex 只能使用该协议。详见日志。",
	"No OpenCode Go models are usable in the current mode. Enable the local proxy for Chat Completions and Anthropic Messages models, then sync again.": "当前模式下没有可用的 OpenCode Go 模型。请启用本地代理以支持 Chat Completions 与 Anthropic Messages 模型，然后重新同步。",
	"Codex executable not found. Install the Codex CLI or the Codex VS Code extension, or set `codexgo.codexExecutable`.": "未找到 Codex 可执行文件。请安装 Codex CLI 或 Codex VS Code 扩展，或设置 `codexgo.codexExecutable`。",
	"Could not read the Codex model catalog template (`codex debug models`). {0}": "无法读取 Codex 模型目录模板（`codex debug models`）。{0}",
	"Codex rejected the generated model catalog, so nothing was changed. Details: {0}": "Codex 拒绝了生成的模型目录，未做任何更改。详情：{0}",
	"Failed to sync the model catalog: {0}": "同步模型目录失败：{0}",
	"unknown error": "未知错误",
	"Reload Window": "重新加载窗口",

	// ── 命令 / 错误 ──
	"OpenCode Go model list refreshed ({0} models).": "OpenCode Go 模型列表已刷新（{0} 个模型）。",
	"Failed to refresh the model list: {0}": "刷新模型列表失败：{0}",
	"The API key was rejected by OpenCode Go (HTTP {0}). Check the key and your Go subscription.": "OpenCode Go 拒绝了该 API 密钥（HTTP {0}）。请检查密钥与 Go 订阅状态。",
	"OpenCode Go returned an empty model list.": "OpenCode Go 返回了空的模型列表。",
	"Could not reach OpenCode Go ({0}).": "无法连接 OpenCode Go（{0}）。",
	"Model list request failed: {0}": "模型列表请求失败：{0}",
	"Codex config file not found. Select a model first — the file is created when you apply one.": "未找到 Codex 配置文件。请先选择模型——应用时会自动创建该文件。",
	"Codex config file not found: {0}": "未找到 Codex 配置文件：{0}",
	"No API key configured. Set one to load the live model list.": "未配置 API 密钥。请先设置密钥以加载实时模型列表。",
};

function isZh(): boolean {
	return vscode.env.language.toLowerCase().startsWith("zh");
}

/** 取键对应的本地化文本（没有译文时回退为键本身）。 */
export function l10n(key: string): string {
	if (isZh() && zhCN[key]) {
		return zhCN[key];
	}
	return key;
}

/** 用 `{0}`、`{1}` 等占位符格式化本地化文本。 */
export function l10nFormat(template: string, ...args: string[]): string {
	let text = l10n(template);
	for (let i = 0; i < args.length; i++) {
		text = text.split(`{${i}}`).join(args[i]);
	}
	return text;
}
