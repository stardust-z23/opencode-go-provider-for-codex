/**
 * 「把 OpenCode Go 模型放进 Codex 自带选择器」的编排逻辑。
 *
 * Codex 的选择器（CLI 的 `/model`、VS Code Codex 界面）由 app-server 的
 * `model/list` RPC 提供，该 RPC 读取顶层 `model_catalog_json` 指向的文件。
 * 本模块负责：
 *
 *   1. 拉取实时模型列表（手动刷新），
 *   2. 只保留网关通过 `/responses` 提供的模型（当前 Codex 唯一能懂的协议）。
 *      全程不发请求：模型列表本身就声明了协议（见 `hardcodedModels.ts`），
 *   3. 用本机 Codex 自带的模板把它们转成目录（条目结构与已安装版本始终一致），
 *   4. 写入目录并设置 `model_catalog_json`（照例先做带时间戳的配置备份），
 *   5. 校验配置仍能加载，不能则回滚。
 *
 * **新**目录需要重启 Codex 才会被读取（app-server 在启动时缓存）；在已列出
 * 的模型之间切换是实时的，无需重启。
 */

import * as path from "path";
import * as vscode from "vscode";
import {
	ApiKeyContext,
	getEnvKeyName,
	resolveApiKey,
	setApiKeyCommand,
	showEnvSetupHelp,
} from "./apiKey";
import {
	CATALOG_FILE_NAME,
	buildCatalogEntries,
	readCatalogFile,
	removeCatalogFile,
	restoreCatalogFile,
	serializeCatalog,
	writeCatalogFile,
} from "./catalog";
import { checkConfigLoads, exportCatalogTemplate, findCodexExecutables, TemplateLookup } from "./codexCli";
import { applySelection, getConfigLocation, getMaxBackups, readCurrent } from "./codexConfig";
import { readConfigText, restoreConfigText, updateConfigText } from "./codexConfigFile";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { describeModelFetchError, prepareModelList } from "./modelList";
import { refreshStatusBar } from "./statusBar";
import { removeTopLevelKey } from "./tomlEdit";
import { ensureProxyStarted, getProxyBaseUrl, isProxyActive } from "./proxyController";

export interface CatalogSyncContext extends ApiKeyContext {
	globalState: vscode.Memento;
}

/** 解析显式指定的可执行文件（设置项 `codexgo.codexExecutable`）。 */
function getCodexExecutableSetting(): string {
	const raw = vscode.workspace.getConfiguration("codexgo").get<string>("codexExecutable", "");
	return raw?.trim() ?? "";
}

/** 生成目录在 `CODEX_HOME` 下的绝对路径。 */
export function catalogPathFor(home: string): string {
	return path.join(home, CATALOG_FILE_NAME);
}

/**
 * `codexgo.syncModelCatalog`：手动执行「拉取模型列表并把可用模型放进 Codex
 * 选择器」的命令。
 */
export async function syncModelCatalogCommand(ctx: CatalogSyncContext): Promise<void> {
	const keyInfo = await resolveApiKey(ctx.secrets);
	const apiKey = keyInfo.key;
	if (!apiKey) {
		const setNow = await vscode.window.showWarningMessage(
			l10n("No API key configured. Set one to pull the model list."),
			l10n("Set API Key"),
		);
		if (setNow) {
			await setApiKeyCommand(ctx);
		}
		return;
	}
	await ensureProxyStarted(false);

	const candidates = findCodexExecutables(getCodexExecutableSetting());
	if (candidates.length === 0) {
		logger.warn("catalog.sync.noCodex", {});
		vscode.window.showErrorMessage(l10n("Codex executable not found. Install the Codex CLI or the Codex VS Code extension, or set `codexgo.codexExecutable`."));
		return;
	}

	const location = getConfigLocation();
	const catalogPath = catalogPathFor(location.home);

	const outcome = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: l10n("Syncing OpenCode Go models into Codex…"),
			cancellable: true,
		},
		async (progress, token) => {
			progress.report({ message: l10n("Fetching the model list…") });
			let models;
			try {
				models = await prepareModelList({ force: true }, token, ctx.secrets, ctx.globalState);
			} catch (err) {
				return { kind: "error" as const, message: describeModelFetchError(err) };
			}
			if (models.length === 0) {
				return { kind: "error" as const, message: l10n("OpenCode Go returned no models.") };
			}
			if (token.isCancellationRequested) {
				return { kind: "cancelled" as const };
			}

			// 不做探测：Codex 只懂 Responses API，而模型列表已经声明了网关通过
			// 它提供哪些模型（映射是怎么来的见 `hardcodedModels.ts`）。
			const proxyActive = isProxyActive();
			const usable = models.filter(
				(model) =>
					model.supported &&
					(model.wireApi === "responses" ||
						(proxyActive && (model.wireApi === "chat" || model.wireApi === "anthropic"))),
			);
			const excluded = models.length - usable.length;
			if (usable.length === 0) {
				return { kind: "none" as const, counted: excluded };
			}
			logger.info("catalog.sync.selected", {
				usable: usable.map((model) => model.id).join(","),
				excluded: String(excluded),
			});

			progress.report({ message: l10n("Building the Codex model catalog…") });
			const lookup = await resolveTemplate(candidates);
			if (!lookup.template || !lookup.executable) {
				return {
					kind: "error" as const,
					message: l10nFormat(
						"Could not read the Codex model catalog template (`codex debug models`). {0}",
						lookup.error ?? candidates[0],
					),
				};
			}
			const { template, executable } = lookup;

			const catalogText = serializeCatalog(buildCatalogEntries(usable, template));
			const previousCatalog = await readCatalogFile(catalogPath);
			const previousConfig = await readConfigText(location);
			await writeCatalogFile(catalogPath, catalogText);

			const current = await readCurrent();
			const modelId = usable.some((model) => model.id === current.modelId)
				? (current.modelId as string)
				: usable[0].id;
			const result = await applySelection({
				modelId,
				wireApi: "responses",
				envKey: getEnvKeyName(),
				catalogFileName: CATALOG_FILE_NAME,
				baseUrl: proxyActive ? getProxyBaseUrl() : undefined,
			});
			await refreshStatusBar();

			const health = await checkConfigLoads(executable, location.home);
			if (!health.ok) {
				logger.error("catalog.sync.rollback", { detail: health.detail ?? "" });
				await restoreCatalogFile(catalogPath, previousCatalog);
				if (previousConfig !== undefined) {
					await restoreConfigText(previousConfig, location);
				}
				return { kind: "rollback" as const, detail: health.detail ?? "" };
			}

			logger.info("catalog.sync.done", {
				catalog: catalogPath,
				usable: usable.map((model) => model.id).join(","),
				excluded: String(excluded),
			});
			return {
				kind: "ok" as const,
				count: usable.length,
				excluded,
				configPath: result.configPath,
				changed: result.changed,
			};
		},
	);

	switch (outcome.kind) {
		case "ok": {
			logger.info("catalog.sync.applied", { count: outcome.count, excluded: outcome.excluded });
			const reload = l10n("Reload Window");
			const openConfig = l10n("Open Codex config.toml");
			const message = l10nFormat(
				"Synced {0} usable models into Codex's model picker ({1} skipped). Restart Codex or reload VS Code to see them.",
				String(outcome.count),
				String(outcome.excluded),
			);
			const picked = await vscode.window.showInformationMessage(message, reload, openConfig);
			if (picked === reload) {
				await vscode.commands.executeCommand("workbench.action.reloadWindow");
			} else if (picked === openConfig) {
				const document = await vscode.workspace.openTextDocument(vscode.Uri.file(outcome.configPath));
				await vscode.window.showTextDocument(document);
			}
			await showEnvSetupHelpIfNeeded(ctx);
			return;
		}
		case "none":
			logger.warn("catalog.sync.noneUsable", { excluded: outcome.counted });
			vscode.window.showWarningMessage(
				l10n("No OpenCode Go models are usable in the current mode. Enable the local proxy for Chat Completions and Anthropic Messages models, then sync again."),
			);
			return;
		case "cancelled":
			logger.info("catalog.sync.cancelled", {});
			return;
		case "rollback":
			vscode.window.showErrorMessage(
				l10nFormat(
					"Codex rejected the generated model catalog, so nothing was changed. Details: {0}",
					outcome.detail || l10n("unknown error"),
				),
			);
			return;
		default:
			vscode.window.showErrorMessage(
				l10nFormat("Failed to sync the model catalog: {0}", outcome.message),
			);
			return;
	}
}

/**
 * 找出一个真正能产出目录模板的可执行文件。
 *
 * Codex 扩展把所有平台的二进制并排放在一起，因此第一个候选不一定能运行；
 * 而当初它跑不起来时，用户只能看到一句笼统的「无法读取模板」，毫无线索。
 */
async function resolveTemplate(
	candidates: readonly string[],
): Promise<TemplateLookup & { executable?: string }> {
	let error: string | undefined;
	for (const executable of candidates) {
		const lookup = await exportCatalogTemplate(executable);
		if (lookup.template) {
			return { template: lookup.template, executable };
		}
		error = lookup.error;
		logger.warn("catalog.sync.templateFailed", { executable, error: lookup.error ?? "" });
	}
	logger.error("catalog.sync.noTemplate", { candidates: candidates.join("; "), error: error ?? "" });
	return { error };
}

async function showEnvSetupHelpIfNeeded(ctx: CatalogSyncContext): Promise<void> {
	if (!process.env[getEnvKeyName()]?.trim()) {
		const setup = l10n("Setup Instructions");
		const picked = await vscode.window.showWarningMessage(
			l10nFormat(
				"{0} is not set in the environment Codex sees. Codex may fail to authenticate — set it and restart VS Code.",
				getEnvKeyName(),
			),
			setup,
		);
		if (picked === setup) {
			await showEnvSetupHelp(ctx);
		}
	}
}

/**
 * `codexgo.removeModelCatalog`：移除 `model_catalog_json` 与生成的目录文件，
 * 让 Codex 回到内置模型列表。
 */
export async function removeModelCatalogCommand(): Promise<void> {
	const location = getConfigLocation();
	const catalogPath = catalogPathFor(location.home);
	const result = await updateCatalogSelection(location);
	const removed = await removeCatalogFile(catalogPath);
	await refreshStatusBar();
	logger.info("catalog.removed", { removed, changed: result.changed });

	if (!result.changed && !removed) {
		vscode.window.showInformationMessage(l10n("Codex is already using its built-in model list."));
		return;
	}
	const reload = l10n("Reload Window");
	const picked = await vscode.window.showInformationMessage(
		l10n("Restored Codex's built-in model list. Restart Codex or reload VS Code to apply."),
		reload,
	);
	if (picked === reload) {
		await vscode.commands.executeCommand("workbench.action.reloadWindow");
	}
}

async function updateCatalogSelection(location: ReturnType<typeof getConfigLocation>) {
	return await updateConfigText((text) => removeTopLevelKey(text, "model_catalog_json"), {
		location,
		maxBackups: getMaxBackups(),
	});
}
