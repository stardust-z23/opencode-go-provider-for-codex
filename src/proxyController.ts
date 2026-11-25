import { randomUUID } from "crypto";
import * as vscode from "vscode";
import {
	ApiKeyContext,
	SECRET_KEY,
	resolveApiKey,
	setApiKeyCommand,
} from "./apiKey";
import { LocalProxyServer, ProxyModelRoute, startLocalProxy } from "./proxy";
import { deriveProxyToken } from "./proxyToken";
import { applyProviderEndpoint, readCurrent } from "./codexConfig";
import { HARDCODED_GO_MODELS } from "./hardcodedModels";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import {
	ensureOfficialCatalogLoadedOnce,
	getOfficialCatalogFacts,
} from "./officialCatalog";
import { protocolAliasForId } from "./protocolVariants";
import { OPENCODE_GO_BASE_URL, OPENCODE_GO_PROVIDER } from "./tomlEdit";
import { getUsageStore } from "./usageService";

type LocalProxyState = "off" | "starting" | "on" | "error";

interface LocalProxyStatus {
	state: LocalProxyState;
	address: string;
	port: number;
	baseUrl: string;
	lastError?: string;
}

const DEFAULT_PROXY_PORT = 15722;
const MIN_PROXY_PORT = 1024;
const MAX_PROXY_PORT = 65535;
const LOOPBACK_PROBE_HEADER = "x-codexgo-loopback-probe";

let extensionContext: vscode.ExtensionContext | undefined;
let proxyServer: LocalProxyServer | undefined;
let status: LocalProxyStatus = {
	state: "off",
	address: "127.0.0.1",
	port: DEFAULT_PROXY_PORT,
	baseUrl: `http://127.0.0.1:${DEFAULT_PROXY_PORT}/v1`,
};
let operation: Promise<void> = Promise.resolve();

/** 初始化本地代理；若设置已开启，则在扩展激活时自动恢复服务。 */
export async function initializeProxy(ctx: vscode.ExtensionContext): Promise<void> {
	extensionContext = ctx;
	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("codexgo.proxyPort")) {
				void runProxyOperation(() => restartProxy());
			}
		}),
	);

	if (await hasOpenCodeProviderConfigured()) {
		const keyInfo = await resolveApiKey(ctx.secrets);
		if (keyInfo.key) {
			if (keyInfo.source === "env") {
				await ctx.secrets.store(SECRET_KEY, keyInfo.key);
				logger.info("apiKey.migrated.envToSecret", {});
			}
			await runProxyOperation(() => enableProxy(false));
		} else {
			updateStatus({ state: "off", port: getConfiguredPort() });
		}
	} else {
		updateStatus({ state: "off", port: getConfiguredPort() });
	}
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
			updateStatus({ state: "off", port: getConfiguredPort(), lastError: undefined });
			return;
		}
		if (keyInfo.key && status.state === "on") {
			await applyProviderEndpoint(status.baseUrl, {
				bearerToken: deriveProxyToken(keyInfo.key),
			});
		}
		if (
			(status.state === "off" || status.state === "error") &&
			(await hasOpenCodeProviderConfigured())
		) {
			await enableProxy(userInitiated);
		}
	});
}

/** Start the proxy before an explicit extension action that needs it. */
export async function ensureProxyStarted(userInitiated = false): Promise<void> {
	if (!extensionContext) {
		return;
	}
	await runProxyOperation(async () => {
		if (status.state === "off" || status.state === "error") {
			await enableProxy(userInitiated);
		}
	});
}

/** 扩展关闭时停止服务；provider 配置保持指向代理，等待下次激活恢复。 */
export async function disposeProxy(): Promise<void> {
	await stopServer();
	updateStatus({ state: "off", port: getConfiguredPort(), lastError: undefined });
}

/** 只有服务已监听时，非 Responses 模型才应被视为可用。 */
export function isProxyActive(): boolean {
	return status.state === "on";
}

/** 提供给配置写入、模型选择和目录同步使用的本地 base URL。 */
function getProxyBaseUrl(): string {
	return status.state === "on" ? status.baseUrl : proxyBaseUrl(getConfiguredPort());
}

/** Provider auth for callers that can use a proxy owned by this or another window. */
export async function getProxyProviderAuth(
	secrets: vscode.SecretStorage,
): Promise<{ baseUrl: string; bearerToken: string } | undefined> {
	if (!(await isProxyReachable())) {
		return undefined;
	}
	const keyInfo = await resolveApiKey(secrets);
	if (!keyInfo.key) {
		return undefined;
	}
	return {
		baseUrl: getProxyBaseUrl(),
		bearerToken: deriveProxyToken(keyInfo.key),
	};
}

async function isProxyReachable(): Promise<boolean> {
	if (isProxyActive()) {
		return true;
	}
	try {
		const nonce = randomUUID();
		const response = await fetch(
			`${proxyBaseUrl(getConfiguredPort())}/health`,
			{
				headers: { [LOOPBACK_PROBE_HEADER]: nonce },
				signal: AbortSignal.timeout(1_500),
			},
		);
		if (!response.ok) {
			return false;
		}
		const payload = (await response.json()) as { status?: unknown };
		return (
			payload.status === "ok" &&
			response.headers.get(LOOPBACK_PROBE_HEADER) === nonce
		);
	} catch {
		return false;
	}
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
			resolveProxyToken: async () => {
				const key = (await resolveApiKey(extensionContext!.secrets)).key;
				return key ? deriveProxyToken(key) : undefined;
			},
			resolveModel: resolveModelRoute,
			log: logProxyEvent,
		});
		updateStatus({
			state: "on",
			address: proxyServer.address,
			port: proxyServer.port,
			lastError: undefined,
		});
		const key = (await resolveApiKey(extensionContext!.secrets)).key;
		if (!key) {
			throw new Error("OpenCode Go API key is not configured");
		}
		await applyProviderEndpoint(status.baseUrl, {
			bearerToken: deriveProxyToken(key),
		});
		logger.info("proxy.started", { address: status.address, port: status.port });
		if (userInitiated) {
			vscode.window.showInformationMessage(
				l10n("OpenCode Go local proxy enabled. Restart Codex to reload the model list."),
			);
		}
	} catch (error) {
		await stopServer();
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

async function restartProxy(): Promise<void> {
	await stopServer();
	updateStatus({ state: "starting", port: getConfiguredPort(), lastError: undefined });
	try {
		proxyServer = await startLocalProxy({
			port: getConfiguredPort(),
			upstreamBaseUrl: OPENCODE_GO_BASE_URL,
			resolveApiKey: async () => (await resolveApiKey(extensionContext!.secrets)).key,
			resolveProxyToken: async () => {
				const key = (await resolveApiKey(extensionContext!.secrets)).key;
				return key ? deriveProxyToken(key) : undefined;
			},
			resolveModel: resolveModelRoute,
			log: logProxyEvent,
		});
		updateStatus({
			state: "on",
			address: proxyServer.address,
			port: proxyServer.port,
			lastError: undefined,
		});
		const key = (await resolveApiKey(extensionContext!.secrets)).key;
		if (!key) {
			throw new Error("OpenCode Go API key is not configured");
		}
		await applyProviderEndpoint(status.baseUrl, {
			bearerToken: deriveProxyToken(key),
		});
		logger.info("proxy.restarted", { port: status.port });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
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

async function resolveModelRoute(modelId: string): Promise<ProxyModelRoute> {
	const alias = protocolAliasForId(modelId);
	const baseId = alias?.baseId ?? modelId;
	let efforts: string[] | undefined;
	try {
		await ensureOfficialCatalogLoadedOnce();
		efforts = getOfficialCatalogFacts(baseId)?.efforts;
	} catch (error) {
		logger.warn("proxy.modelLookup.failed", {
			modelId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const hardcoded = HARDCODED_GO_MODELS.find((entry) => entry.id === modelId);
	return {
		wireApi:
			alias?.wireApi ??
			hardcoded?.wireApi ??
			getOfficialCatalogFacts(baseId)?.wireApi ??
			"chat",
		upstreamModelId: alias?.baseId,
		efforts,
	};
}

function runProxyOperation(next: () => Promise<void>): Promise<void> {
	operation = operation.then(next, next);
	return operation;
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
}

function apiKeyContext(ctx: vscode.ExtensionContext): ApiKeyContext {
	return {
		secrets: ctx.secrets,
	};
}

function logProxyEvent(message: string, detail?: Record<string, unknown>): void {
	logger.debug("proxy.request", { message, ...detail });
	getUsageStore()?.handleProxyLog(message, detail);
}
