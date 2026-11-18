/**
 * 扩展入口。
 * 激活时只初始化状态栏、代理、首次运行引导页和一组聚焦命令；模型发现按需
 * 在目录同步命令中执行。
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { initStatusBar } from "./statusBar";
import { ApiKeyContext, getApiKeyLinkCommand, resolveApiKey, setApiKeyCommand } from "./apiKey";
import { openCodexConfigFile } from "./codexConfig";
import { removeModelCatalogCommand, syncModelCatalogCommand } from "./catalogSync";
import { refreshGoUsageNow } from "./statusBar";
import {
	disposeProxy,
	initializeProxy,
	syncProxyWithSetting,
} from "./proxyController";
import { registerUsageDashboard } from "./usagePanel";
import { disposeUsageStore, setUsageStore } from "./usageService";
import { UsageStore } from "./usageStore";
import { setExtensionVersion } from "./utils";

/** 记录引导页是否已展示过的 Memento 键。 */
const WELCOME_SHOWN_KEY = "codexgo.welcomeShown";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const extensionVersion = String(context.extension.packageJSON.version ?? "unknown");
	setExtensionVersion(extensionVersion);
	logger.init();
	logger.info("extension.activate", {
		version: extensionVersion,
	});

	const usageStore = new UsageStore(context.globalStorageUri.fsPath, {
		onError: (message, detail) => logger.warn(message, detail),
	});
	setUsageStore(usageStore);
	try {
		await usageStore.initialize();
	} catch (error) {
		logger.warn("usageStore.initialize.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	initStatusBar(context);

	const apiKeyContext: ApiKeyContext = {
		secrets: context.secrets,
	};

	context.subscriptions.push(
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
		vscode.commands.registerCommand("codexgo.openCodexConfig", () => openCodexConfigFile()),
		vscode.commands.registerCommand("codexgo.openSettings", () =>
			vscode.commands.executeCommand(
				"workbench.action.openSettings",
				"@ext:codexgo.opencode-go-provider-for-codex",
			),
		),
		registerUsageDashboard(context, usageStore),
	);
	void initializeProxy(context).catch((error) => {
		logger.error("proxy.initialize.failed", {
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
	await disposeUsageStore();
	// 资源释放由 context.subscriptions 负责。
}
