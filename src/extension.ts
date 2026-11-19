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
import {
	autoSyncModelCatalogForNewModels,
	removeModelCatalogCommand,
	syncModelCatalogCommand,
	type CatalogSyncContext,
} from "./catalogSync";
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
import { l10n, l10nFormat } from "./localize";
import { ModelCenterService, type ModelCenterUpdateEvent } from "./modelCenterService";
import { registerModelCenter } from "./modelCenterPanel";

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
	const catalogContext: CatalogSyncContext = {
		...apiKeyContext,
		globalState: context.globalState,
	};
	const modelCenter = new ModelCenterService({
		storageRoot: context.globalStorageUri.fsPath,
		autoSyncCatalog: () => autoSyncModelCatalogForNewModels(catalogContext),
		onDidFindUpdates: (event) => showModelCenterUpdates(event),
	});
	try {
		await modelCenter.initialize();
	} catch (error) {
		logger.warn("modelCenter.initialize.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	context.subscriptions.push(
		modelCenter,
		vscode.commands.registerCommand("codexgo.setApiKey", async () => {
			await setApiKeyCommand(apiKeyContext);
			await syncProxyWithSetting(true);
		}),
		vscode.commands.registerCommand("codexgo.syncModelCatalog", () =>
			syncModelCatalogCommand(catalogContext),
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
		registerModelCenter(context, modelCenter),
	);
	void initializeProxy(context).catch((error) => {
		logger.error("proxy.initialize.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
	modelCenter.start();

	void showWelcomeIfNeeded(context);

	context.subscriptions.push({
		dispose: () => logger.dispose(),
	});
}

function showModelCenterUpdates(event: ModelCenterUpdateEvent): void {
	const parts: string[] = [];
	if (event.addedModelIds.length > 0) {
		parts.push(
			event.addedModelIds.length === 1
				? l10n("1 new model")
				: l10nFormat(
						"{0} new models",
						String(event.addedModelIds.length),
					),
		);
	}
	const otherChanges =
		event.changes.length - event.addedModelIds.length;
	if (otherChanges > 0) {
		parts.push(
			otherChanges === 1
				? l10n("1 model change")
				: l10nFormat("{0} model changes", String(otherChanges)),
		);
	}
	if (event.news.length > 0) {
		parts.push(
			event.news.length === 1
				? l10n("1 official news update")
				: l10nFormat(
						"{0} official news updates",
						String(event.news.length),
					),
		);
	}
	if (event.autoSync?.status === "failed") {
		parts.push(l10n("catalog auto-sync failed"));
	}
	if (parts.length === 0) {
		return;
	}
	const message = l10nFormat("OpenCode Go: {0}.", parts.join(", "));
	const open = l10n("Open model center");
	const reload = l10n("Reload window");
	const actions =
		event.autoSync?.status === "synced" ? [open, reload] : [open];
	void vscode.window.showInformationMessage(message, ...actions).then((picked) => {
		if (picked === open) {
			void vscode.commands.executeCommand("codexgo.openModelCenter");
		} else if (picked === reload) {
			void vscode.commands.executeCommand("workbench.action.reloadWindow");
		}
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
