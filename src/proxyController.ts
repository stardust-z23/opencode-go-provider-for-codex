import * as vscode from "vscode";
import { ApiKeyContext, resolveApiKey, setApiKeyCommand } from "./apiKey";
import { LocalProxyServer, ProxyWireApi, startLocalProxy } from "./proxy";
import { applyProviderEndpoint, readCurrent } from "./codexConfig";
import { HARDCODED_GO_MODELS } from "./hardcodedModels";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { prepareModelList } from "./modelList";
import { OPENCODE_GO_BASE_URL, OPENCODE_GO_PROVIDER } from "./tomlEdit";

export type LocalProxyState = "off" | "starting" | "on" | "error";

export interface LocalProxyStatus {
	state: LocalProxyState;
	address: string;
	port: number;
	baseUrl: string;
	lastError?: string;
}

const DEFAULT_PROXY_PORT = 15722;
const MIN_PROXY_PORT = 1024;
const MAX_PROXY_PORT = 65535;

let extensionContext: vscode.ExtensionContext | undefined;
let proxyServer: LocalProxyServer | undefined;
let status: LocalProxyStatus = {
	state: "off",
	address: "127.0.0.1",
	port: DEFAULT_PROXY_PORT,
	baseUrl: `http://127.0.0.1:${DEFAULT_PROXY_PORT}/v1`,
};
let operation: Promise<void> = Promise.resolve();
const statusEmitter = new vscode.EventEmitter<LocalProxyStatus>();

export const onDidChangeProxyStatus = statusEmitter.event;

/** 初始化本地代理；若设置已开启，则在扩展激活时自动恢复服务。 */
export async function initializeProxy(ctx: vscode.ExtensionContext): Promise<void> {
	extensionContext = ctx;
	ctx.subscriptions.push(statusEmitter);
	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("codexgo.proxyEnabled")) {
				const enabled = isProxySettingEnabled();
				if (enabled && (status.state === "off" || status.state === "error")) {
					void runProxyOperation(() => enableProxy(false));
				} else if (!enabled && (status.state === "on" || status.state === "starting")) {
					void runProxyOperation(() => disableProxy(false));
				}
			} else if (
				event.affectsConfiguration("codexgo.proxyPort") &&
				isProxySettingEnabled()
			) {
				void runProxyOperation(() => restartProxy());
			}
			if (event.affectsConfiguration("codexgo.apiKeyEnvVar") && isProxySettingEnabled()) {
				void runProxyOperation(async () => {
					await applyProviderEndpoint(proxyBaseUrl(getConfiguredPort()));
				});
			}
		}),
	);

	if (isProxySettingEnabled()) {
		if (await hasOpenCodeProviderConfigured()) {
			const keyInfo = await resolveApiKey(ctx.secrets);
			if (keyInfo.key) {
				await runProxyOperation(() => enableProxy(false));
			} else {
				await restoreDirectEndpointBestEffort();
				updateStatus({ state: "off", port: getConfiguredPort() });
			}
		} else {
			updateStatus({ state: "off", port: getConfiguredPort() });
		}
	} else {
		updateStatus({ state: "off", port: getConfiguredPort() });
	}
}

/** 一键切换本地代理（状态栏点击入口）。 */
export async function toggleProxyCommand(): Promise<void> {
	if (!extensionContext) {
		return;
	}
	await runProxyOperation(async () => {
		if (status.state === "on" || status.state === "starting") {
			await disableProxy(true);
		} else {
			await enableProxy(true);
		}
	});
}

/** Re-evaluate the proxy after the API key changed. */
export async function syncProxyWithSetting(userInitiated = false): Promise<void> {
	if (!extensionContext) {
		return;
	}
	await runProxyOperation(async () => {
		const keyInfo = await resolveApiKey(extensionContext!.secrets);
		if (!keyInfo.key && (status.state === "on" || status.state === "starting")) {
			await stopServer();
			await restoreDirectEndpointBestEffort();
			updateStatus({ state: "off", port: getConfiguredPort(), lastError: undefined });
			return;
		}
		if (isProxySettingEnabled()) {
			if (
				(status.state === "off" || status.state === "error") &&
				(await hasOpenCodeProviderConfigured())
			) {
				await enableProxy(userInitiated);
			}
		} else if (status.state === "on" || status.state === "starting") {
			await disableProxy(false);
		}
	});
}

/** Start the proxy before an explicit extension action that needs it. */
export async function ensureProxyStarted(userInitiated = false): Promise<void> {
	if (!extensionContext || !isProxySettingEnabled()) {
		return;
	}
	await runProxyOperation(async () => {
		if (status.state === "off" || status.state === "error") {
			await enableProxy(userInitiated);
		}
	});
}

/** 扩展关闭时停止服务，并把 Codex 配置恢复到直连地址。 */
export async function disposeProxy(): Promise<void> {
	const shouldRestore = isProxySettingEnabled();
	await stopServer();
	if (shouldRestore) {
		try {
			await applyProviderEndpoint(OPENCODE_GO_BASE_URL);
		} catch (error) {
			logger.warn("proxy.dispose.restore.failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	updateStatus({ state: "off", port: getConfiguredPort(), lastError: undefined });
}

export function getProxyStatus(): LocalProxyStatus {
	return { ...status };
}

/** 只有服务已监听时，非 Responses 模型才应被视为可用。 */
export function isProxyActive(): boolean {
	return status.state === "on";
}

/** 提供给配置写入、模型选择和目录同步使用的本地 base URL。 */
export function getProxyBaseUrl(): string {
	return status.state === "on" ? status.baseUrl : proxyBaseUrl(getConfiguredPort());
}

async function enableProxy(userInitiated: boolean): Promise<void> {
	if (status.state === "on") {
		if (userInitiated) {
			vscode.window.showInformationMessage(l10n("OpenCode Go local proxy is already running."));
		}
		return;
	}

	const keyInfo = await resolveApiKey(extensionContext!.secrets);
	if (!keyInfo.key) {
		if (userInitiated) {
			const setKey = l10n("Set API Key");
			const picked = await vscode.window.showWarningMessage(
				l10n("Set an OpenCode Go API key before enabling the local proxy."),
				setKey,
			);
			if (picked === setKey && extensionContext) {
				await setApiKeyCommand(apiKeyContext(extensionContext));
			}
		}
		const retry = await resolveApiKey(extensionContext!.secrets);
		if (!retry.key) {
			updateStatus({ state: "off", port: getConfiguredPort(), lastError: undefined });
			return;
		}
	}

	const port = getConfiguredPort();
	updateStatus({ state: "starting", port, lastError: undefined });
	try {
		proxyServer = await startLocalProxy({
			port,
			upstreamBaseUrl: OPENCODE_GO_BASE_URL,
			resolveApiKey: async () => (await resolveApiKey(extensionContext!.secrets)).key,
			resolveWireApi,
			log: (message, detail) => logger.debug("proxy.request", { message, ...detail }),
		});
		updateStatus({
			state: "on",
			address: proxyServer.address,
			port: proxyServer.port,
			lastError: undefined,
		});
		await applyProviderEndpoint(status.baseUrl);
		await persistProxyEnabled(true);
		logger.info("proxy.started", { address: status.address, port: status.port });
		if (userInitiated) {
			vscode.window.showInformationMessage(
				l10n("OpenCode Go local proxy enabled. Restart Codex to reload the model list."),
			);
		}
	} catch (error) {
		await stopServer();
		await restoreDirectEndpointBestEffort();
		const message = error instanceof Error ? error.message : String(error);
		updateStatus({ state: "error", port, lastError: message });
		logger.error("proxy.start.failed", { error: message });
		if (userInitiated) {
			vscode.window.showErrorMessage(
				l10nFormat("Could not start the OpenCode Go local proxy: {0}", message),
			);
		}
	}
}

async function disableProxy(userInitiated: boolean): Promise<void> {
	try {
		await applyProviderEndpoint(OPENCODE_GO_BASE_URL);
		await persistProxyEnabled(false);
		await stopServer();
		updateStatus({ state: "off", port: getConfiguredPort(), lastError: undefined });
		logger.info("proxy.stopped", {});
		if (userInitiated) {
			vscode.window.showInformationMessage(
				l10n("OpenCode Go local proxy disabled. Codex is back on the direct endpoint."),
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateStatus({ state: "error", port: getConfiguredPort(), lastError: message });
		logger.error("proxy.stop.failed", { error: message });
		if (userInitiated) {
			vscode.window.showErrorMessage(
				l10nFormat("Could not disable the OpenCode Go local proxy: {0}", message),
			);
		}
	}
}

async function restartProxy(): Promise<void> {
	await stopServer();
	updateStatus({ state: "starting", port: getConfiguredPort(), lastError: undefined });
	try {
		proxyServer = await startLocalProxy({
			port: getConfiguredPort(),
			upstreamBaseUrl: OPENCODE_GO_BASE_URL,
			resolveApiKey: async () => (await resolveApiKey(extensionContext!.secrets)).key,
			resolveWireApi,
			log: (message, detail) => logger.debug("proxy.request", { message, ...detail }),
		});
		updateStatus({
			state: "on",
			address: proxyServer.address,
			port: proxyServer.port,
			lastError: undefined,
		});
		await applyProviderEndpoint(status.baseUrl);
		logger.info("proxy.restarted", { port: status.port });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await restoreDirectEndpointBestEffort();
		updateStatus({ state: "error", port: getConfiguredPort(), lastError: message });
		logger.error("proxy.restart.failed", { error: message });
		void vscode.window.showErrorMessage(
			l10nFormat("Could not restart the OpenCode Go local proxy: {0}", message),
		);
	}
}

async function stopServer(): Promise<void> {
	const server = proxyServer;
	proxyServer = undefined;
	if (!server) {
		return;
	}
	try {
		await server.close();
	} catch (error) {
		logger.warn("proxy.close.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function restoreDirectEndpointBestEffort(): Promise<void> {
	try {
		await applyProviderEndpoint(OPENCODE_GO_BASE_URL);
	} catch (error) {
		logger.warn("proxy.restoreDirect.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function resolveWireApi(modelId: string): Promise<ProxyWireApi> {
	try {
		const tokenSource = new vscode.CancellationTokenSource();
		try {
			const models = await prepareModelList(
				{},
				tokenSource.token,
				extensionContext!.secrets,
				extensionContext!.globalState,
			);
			const model = models.find((entry) => entry.id === modelId);
			if (model) {
				return model.wireApi;
			}
		} finally {
			tokenSource.dispose();
		}
	} catch (error) {
		logger.warn("proxy.modelLookup.failed", {
			modelId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const hardcoded = HARDCODED_GO_MODELS.find((entry) => entry.id === modelId);
	return hardcoded?.wireApi ?? "chat";
}

function runProxyOperation(next: () => Promise<void>): Promise<void> {
	operation = operation.then(next, next);
	return operation;
}

function isProxySettingEnabled(): boolean {
	return vscode.workspace.getConfiguration("codexgo").get<boolean>("proxyEnabled", true);
}

async function persistProxyEnabled(enabled: boolean): Promise<void> {
	try {
		const configuration = vscode.workspace.getConfiguration("codexgo");
		if (!configuration.inspect<boolean>("proxyEnabled")) {
			logger.warn("proxy.setting.unregistered", { enabled });
			return;
		}
		await configuration.update("proxyEnabled", enabled, vscode.ConfigurationTarget.Global);
	} catch (error) {
		logger.warn("proxy.setting.update.failed", {
			enabled,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function hasOpenCodeProviderConfigured(): Promise<boolean> {
	try {
		return (await readCurrent()).providerId === OPENCODE_GO_PROVIDER;
	} catch {
		return false;
	}
}

function getConfiguredPort(): number {
	const value = vscode.workspace
		.getConfiguration("codexgo")
		.get<number>("proxyPort", DEFAULT_PROXY_PORT);
	return Number.isFinite(value)
		? Math.max(MIN_PROXY_PORT, Math.min(MAX_PROXY_PORT, Math.trunc(value)))
		: DEFAULT_PROXY_PORT;
}

function proxyBaseUrl(port: number): string {
	return `http://127.0.0.1:${port}/v1`;
}

function updateStatus(patch: Partial<LocalProxyStatus> & { state: LocalProxyState }): void {
	const port = patch.port ?? status.port;
	status = {
		...status,
		...patch,
		address: patch.address ?? status.address,
		port,
		baseUrl: patch.baseUrl ?? proxyBaseUrl(port),
	};
	statusEmitter.fire(getProxyStatus());
}

function apiKeyContext(ctx: vscode.ExtensionContext): ApiKeyContext {
	return {
		secrets: ctx.secrets,
		environmentVariableCollection: ctx.environmentVariableCollection,
	};
}
