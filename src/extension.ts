/**
 * 扩展入口。
 * 命令与激活布局沿用 OpenCode Go Provider for Copilot：激活时预热模型发现、
 * 首次运行的引导页、状态栏，以及一小组聚焦的命令。
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { l10nFormat } from "./localize";
import { initStatusBar } from "./statusBar";
import { describeModelFetchError, prepareModelList, resetModelDiscoveryState } from "./modelList";
import { selectModelCommand } from "./picker";
import { ApiKeyContext, getApiKeyLinkCommand, resolveApiKey, setApiKeyCommand } from "./apiKey";
import { openCodexConfigFile } from "./codexConfig";
import { removeModelCatalogCommand, syncModelCatalogCommand } from "./catalogSync";
import { refreshGoUsageNow } from "./statusBar";
import {
	disposeProxy,
	initializeProxy,
	syncProxyWithSetting,
	toggleProxyCommand,
} from "./proxyController";

/** 记录引导页是否已展示过的 Memento 键。 */
const WELCOME_SHOWN_KEY = "codexgo.welcomeShown";

export function activate(context: vscode.ExtensionContext): void {
	logger.init();
	logger.info("extension.activate", {
		version: String(context.extension.packageJSON.version ?? "unknown"),
	});

	initStatusBar(context);

	const apiKeyContext: ApiKeyContext = {
		secrets: context.secrets,
		environmentVariableCollection: context.environmentVariableCollection,
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("codexgo.selectModel", () =>
			selectModelCommand({ ...apiKeyContext, globalState: context.globalState }),
		),

		vscode.commands.registerCommand("codexgo.refreshModels", async () => {
			try {
				resetModelDiscoveryState();
				const models = await prepareModelList(
					{ force: true },
					new vscode.CancellationTokenSource().token,
					context.secrets,
					context.globalState,
				);
				vscode.window.showInformationMessage(
					l10nFormat("OpenCode Go model list refreshed ({0} models).", String(models.length)),
				);
			} catch (err) {
				logger.error("models.refresh.failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				vscode.window.showErrorMessage(
					l10nFormat("Failed to refresh the model list: {0}", describeModelFetchError(err)),
				);
			}
		}),

		vscode.commands.registerCommand("codexgo.setApiKey", async () => {
			await setApiKeyCommand(apiKeyContext);
			await syncProxyWithSetting(true);
		}),
		vscode.commands.registerCommand("codexgo.syncModelCatalog", () =>
			syncModelCatalogCommand({ ...apiKeyContext, globalState: context.globalState }),
		),
		vscode.commands.registerCommand("codexgo.removeModelCatalog", () => removeModelCatalogCommand()),
		vscode.commands.registerCommand("codexgo.getApiKey", () => getApiKeyLinkCommand()),
		vscode.commands.registerCommand("codexgo.checkUsage", () => refreshGoUsageNow()),
		vscode.commands.registerCommand("codexgo.toggleProxy", () => toggleProxyCommand()),
		vscode.commands.registerCommand("codexgo.openCodexConfig", () => openCodexConfigFile()),
		vscode.commands.registerCommand("codexgo.openSettings", () =>
			vscode.commands.executeCommand(
				"workbench.action.openSettings",
				"@ext:codexgo.opencode-go-provider-for-codex",
			),
		),
	);
	void initializeProxy(context).catch((error) => {
		logger.error("proxy.initialize.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});

	// 每次激活都预热模型发现（不阻塞、发了就不管），与参考扩展一致。
	// 失败会静默降级到缓存 / 内置列表；选择器打开时会重建列表。
	void prepareModelList(
		{},
		new vscode.CancellationTokenSource().token,
		context.secrets,
		context.globalState,
	).catch((error) => {
		logger.error("models.warmup.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});

	void showWelcomeIfNeeded(context);

	context.subscriptions.push({
		dispose: () => logger.dispose(),
	});
}

/**
 * 首次激活且未配置 API 密钥时展示引导页。标志会持久化，因此不会再次出现。
 */
async function showWelcomeIfNeeded(context: vscode.ExtensionContext): Promise<void> {
	try {
		if (context.globalState.get(WELCOME_SHOWN_KEY)) {
			return;
		}
		const keyInfo = await resolveApiKey(context.secrets);
		if (keyInfo.source !== "none") {
			await context.globalState.update(WELCOME_SHOWN_KEY, true);
			return;
		}
		await vscode.commands.executeCommand(
			"workbench.action.openWalkthrough",
			`${context.extension.id}#codexGoGettingStarted`,
			false,
		);
		await context.globalState.update(WELCOME_SHOWN_KEY, true);
	} catch (error) {
		logger.warn("welcome.failed", { error: String(error) });
	}
}

export async function deactivate(): Promise<void> {
	await disposeProxy();
	// 资源释放由 context.subscriptions 负责。
}
