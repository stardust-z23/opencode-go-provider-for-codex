/**
 * 原生 QuickPick 模型选择器。
 *
 * 界面风格刻意与 OpenCode Go Provider for Copilot 保持一致：不用 webview，
 * 而是 QuickPick 分组、徽标、过滤输入、工具栏按钮，外加第二步的推理强度选择。
 *
 * 行为细节：
 * - 分组：Codex 真正可用的模型（Responses API）与其他模型。未开启
 *   `codexgo.showDeprecatedModels` 时隐藏已弃用模型。
 * - 当前模型带对勾标记。
 * - 进入次级流程时选择器保持打开；`handoff` 标志会压掉由此产生的
 *   「已取消」隐藏事件（QuickPick 的经典陷阱：`hide()` 总会触发
 *   `onDidHide`）。
 * - 不支持的模型绝不会写入配置，只提供复制模型 ID 的选项。
 */

import * as vscode from "vscode";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { formatPrice, formatTokenCount, ModelInfo } from "./modelInfo";
import { CODEX_EFFORT_DESCRIPTIONS, filterCodexEfforts } from "./catalog";
import { prepareModelList, resetModelDiscoveryState } from "./modelList";
import { ApiKeyContext, getEnvKeyName, resolveApiKey, setApiKeyCommand, showEnvSetupHelp } from "./apiKey";
import { applySelection, openCodexConfigFile, readCurrent } from "./codexConfig";
import { CodexWireApi, providerIdForWireApi } from "./tomlEdit";
import { refreshStatusBar } from "./statusBar";
import { ensureProxyStarted, getProxyBaseUrl, isProxyActive } from "./proxyController";

const EFFORT_LABELS: Record<string, string> = {
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
	ultra: "Ultra",
};

type PickerOutcome = "picked" | "cancelled" | "refresh" | "setKey" | "openConfig" | "again";

interface ModelPickItem extends vscode.QuickPickItem {
	model?: ModelInfo;
}

export interface PickerContext extends ApiKeyContext {
	globalState: vscode.Memento;
}

/** `codexgo.selectModel`：循环式选择器，工具栏操作（刷新等）后会重新打开。 */
export async function selectModelCommand(ctx: PickerContext): Promise<void> {
	// 先提醒配置密钥：没有密钥就拿不到实时列表，选择器只能显示目录 /
	// 内置兜底数据。
	const keyInfo = await resolveApiKey(ctx.secrets);
	if (keyInfo.source === "none") {
		const setNow = await vscode.window.showWarningMessage(
			l10n("No API key configured. Set one to load the live model list."),
			l10n("Set API Key"),
		);
		if (setNow) {
			await setApiKeyCommand(ctx);
			resetModelDiscoveryState();
		}
	}

	for (;;) {
		const outcome = await showPickerOnce(ctx);
		if (outcome === "refresh") {
			resetModelDiscoveryState();
			continue;
		}
		if (outcome === "setKey") {
			await setApiKeyCommand(ctx);
			resetModelDiscoveryState();
			continue;
		}
		if (outcome === "openConfig") {
			await openCodexConfigFile();
			continue;
		}
		if (outcome === "again") {
			continue;
		}
		return;
	}
}

async function showPickerOnce(ctx: PickerContext): Promise<PickerOutcome> {
	const models = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: l10n("Loading OpenCode Go models…") },
		() => prepareModelList({}, new vscode.CancellationTokenSource().token, ctx.secrets, ctx.globalState),
	);
	return await nativePick(ctx, models);
}

async function nativePick(ctx: PickerContext, models: ModelInfo[]): Promise<PickerOutcome> {
	const config = vscode.workspace.getConfiguration("codexgo");
	const showUnsupported = config.get<boolean>("showUnsupportedModels", true);
	const showDeprecated = config.get<boolean>("showDeprecatedModels", false);
	const current = await readCurrent();

	const visible = showDeprecated ? models : models.filter((model) => !model.deprecated);
	// 「只保留可用的」：Responses API 是 Codex 目前唯一支持的线上协议，
	// 而判断哪些模型声明了它并不需要发请求。
	const proxyActive = isProxyActive();
	const isUsable = (model: ModelInfo): boolean =>
		model.supported &&
		(model.wireApi === "responses" ||
			(proxyActive && (model.wireApi === "chat" || model.wireApi === "anthropic")));
	const usableModels = visible.filter(isUsable);
	const unusableModels = visible.filter((model) => !isUsable(model));

	const items: ModelPickItem[] = [];
	const pushGroup = (label: string, group: ModelInfo[], usable: boolean): void => {
		if (group.length === 0) {
			return;
		}
		items.push({ label, kind: vscode.QuickPickItemKind.Separator });
		for (const model of [...group].sort((a, b) => a.name.localeCompare(b.name))) {
			items.push(toItem(model, current.modelId, usable));
		}
	};
	pushGroup(l10n("Usable with Codex"), usableModels, true);
	if (showUnsupported) {
		pushGroup(l10n("Not usable in the current mode"), unusableModels, false);
	}
	if (items.length === 0) {
		items.push({ label: l10n("No models found. Try refreshing the model list.") });
	}

	const refreshButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon("refresh"),
		tooltip: l10n("Refresh"),
	};
	const keyButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon("key"),
		tooltip: l10n("Set API Key"),
	};
	const configButton: vscode.QuickInputButton = {
		iconPath: new vscode.ThemeIcon("file-code"),
		tooltip: l10n("Open Codex config.toml"),
	};

	return await new Promise<PickerOutcome>((resolve) => {
		const picker = vscode.window.createQuickPick<ModelPickItem>();
		// 防止我们在有意切换到次级流程（推理强度选择、工具栏操作、应用）时
		// 触发 onDidHide。
		let handingOff = false;

		picker.title = l10n("Select OpenCode Go Model for Codex");
		picker.placeholder = l10n("Type to filter by name or model ID");
		picker.matchOnDescription = true;
		picker.matchOnDetail = true;
		picker.ignoreFocusOut = true;
		picker.items = items;
		picker.buttons = [refreshButton, keyButton, configButton];

		picker.onDidHide(() => {
			if (handingOff) {
				return;
			}
			picker.dispose();
			resolve("cancelled");
		});

		picker.onDidTriggerButton((button) => {
			if (handingOff) {
				return;
			}
			handingOff = true;
			picker.hide();
			picker.dispose();
			resolve(button === refreshButton ? "refresh" : button === keyButton ? "setKey" : "openConfig");
		});

		picker.onDidAccept(() => {
			if (handingOff) {
				return;
			}
			const model = picker.selectedItems[0]?.model;
			if (!model) {
				return; // 分隔符或占位项：保持选择器打开
			}
			handingOff = true;
			picker.hide();
			void handlePick(ctx, model)
				.then((outcome) => {
					picker.dispose();
					resolve(outcome);
				})
				.catch((err) => {
					logger.error("picker.unhandled", { error: err instanceof Error ? err.message : String(err) });
					picker.dispose();
					resolve("cancelled");
				});
		});

		picker.show();
	});
}

function toItem(model: ModelInfo, currentModelId: string | undefined, usable: boolean): ModelPickItem {
	const badges: string[] = [model.wireApi];
	if (!usable) {
		badges.push(l10n("unavailable"));
	}
	if (model.free) {
		badges.push(l10n("Free"));
	}
	if (model.deprecated) {
		badges.push(l10n("deprecated"));
	}
	if (model.vision) {
		badges.push(l10n("vision"));
	}
	if (model.reasoning) {
		badges.push(l10n("reasoning"));
	}
	if (!model.protocolKnown) {
		badges.push(l10n("assumed protocol"));
	}

	const parts: string[] = [badges.join(" · ")];
	if (model.contextLength) {
		parts.push(l10nFormat("{0} ctx", formatTokenCount(model.contextLength)));
	}
	if (model.cost && ((model.cost.input ?? 0) > 0 || (model.cost.output ?? 0) > 0)) {
		parts.push(l10nFormat("{0} / {1} per 1M", formatPrice(model.cost.input), formatPrice(model.cost.output)));
	}

	return {
		label: `${currentModelId === model.id ? "$(check) " : ""}${model.name}`,
		description: model.id,
		detail: parts.join("  ·  "),
		model,
	};
}

async function handlePick(ctx: PickerContext, model: ModelInfo): Promise<PickerOutcome> {
	if (!model.supported) {
		return await warnAndOfferCopyId(
			l10nFormat(
				"The model “{0}” uses a protocol this extension cannot adapt. Nothing was changed.",
				model.name,
			),
			model,
		);
	}
	if (model.wireApi !== "responses" && !isProxyActive()) {
		return await warnAndOfferCopyId(
			l10nFormat(
				"The model “{0}” needs the OpenCode Go local proxy. Enable it from the status bar and try again.",
				model.name,
			),
			model,
		);
	}

	// 可选的第二步：推理强度（仅当目录声明了 Codex 真正接受的强度时）。
	let reasoningEffort: string | null | undefined;
	const efforts = filterCodexEfforts(model.efforts ?? []);
	if (model.reasoning && efforts.length > 0) {
		reasoningEffort = await pickReasoningEffort(efforts);
		if (reasoningEffort === undefined) {
			return "cancelled"; // 用户在推理强度选择中取消
		}
	}

	await applyAndReport(ctx, model, reasoningEffort);
	return "picked";
}

/** 提示模型无法应用，并提供复制其 ID 的选项。 */
async function warnAndOfferCopyId(message: string, model: ModelInfo): Promise<PickerOutcome> {
	const copyId = l10n("Copy Model ID");
	const picked = await vscode.window.showWarningMessage(message, copyId);
	if (picked === copyId) {
		await vscode.env.clipboard.writeText(model.id);
		vscode.window.showInformationMessage(l10n("Model ID copied to clipboard."));
	}
	return "again";
}

async function pickReasoningEffort(efforts: string[]): Promise<string | null | undefined> {
	interface EffortItem extends vscode.QuickPickItem {
		value: string | null;
	}
	const items: EffortItem[] = [
		{ label: l10n("Default (leave model_reasoning_effort unset)"), value: null },
		...efforts.map((effort) => {
			const description = CODEX_EFFORT_DESCRIPTIONS[effort];
			return {
				label: l10n(EFFORT_LABELS[effort] ?? effort),
				description: effort,
				detail: description ? l10n(description) : undefined,
				value: effort,
			};
		}),
	];
	const picked = await vscode.window.showQuickPick(items, {
		title: l10n("Select Reasoning Effort"),
		placeHolder: l10n("Pick how hard the model should think before answering."),
		ignoreFocusOut: true,
	});
	return picked ? picked.value : undefined;
}

async function applyAndReport(
	ctx: PickerContext,
	model: ModelInfo,
	reasoningEffort: string | null | undefined,
): Promise<void> {
	// Codex 0.162 移除了 Chat Completions provider（`wire_api = "chat"`），
	// 因此本扩展能应用的模型一律使用 Responses API。
	const wireApi: CodexWireApi = "responses";
	const envKey = getEnvKeyName();
	const result = await applySelection({
		modelId: model.id,
		wireApi,
		envKey,
		reasoningEffort,
		baseUrl: isProxyActive() ? getProxyBaseUrl() : undefined,
	});
	await ensureProxyStarted(false);
	await refreshStatusBar();

	const providerId = providerIdForWireApi(wireApi);
	const openConfig = l10n("Open Codex config.toml");
	if (!result.changed) {
		vscode.window.showInformationMessage(l10nFormat("Codex is already configured to use “{0}”.", model.name));
	} else {
		logger.info("picker.applied", {
			modelId: model.id,
			providerId,
			created: result.created,
			backup: result.backupPath ?? "",
		});
		const message = result.created
			? l10nFormat("Codex config created: “{0}” (provider: {1}).", model.name, providerId)
			: l10nFormat("Codex config updated: “{0}” (provider: {1}).", model.name, providerId);
		void vscode.window.showInformationMessage(message, openConfig).then((picked) => {
			if (picked === openConfig) {
				void openCodexConfigFile(result.configPath);
			}
		});
	}

	// 陷阱：Codex 从它自己进程的环境变量读取 `env_key`，只存在
	// SecretStorage 里的密钥对它不可见。
	if (!process.env[envKey]?.trim()) {
		const setup = l10n("Setup Instructions");
		const picked = await vscode.window.showWarningMessage(
			l10nFormat(
				"{0} is not set in the environment Codex sees. Codex may fail to authenticate — set it and restart VS Code.",
				envKey,
			),
			setup,
		);
		if (picked === setup) {
			await showEnvSetupHelp(ctx);
		}
	}
}
