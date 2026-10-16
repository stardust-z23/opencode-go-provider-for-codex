/**
 * 模型列表编排：实时 API 列表 + 目录 + 持久化缓存。
 *
 * 沿用 OpenCode Go Provider for Copilot 的发现流程：
 *
 * - 同一时刻只跑一趟；并发调用方等待进行中的那一趟，而不是各拉各的（启动时
 *   的激活风暴与选择器绝不能重复拉取）。
 * - 只有超过 `codexgo.modelsDevUpdateInterval`（最小 30 秒）才刷新；`force`
 *   可绕过 TTL。
 * - 实时 API 列表可用时是严格更优的来源（它反映套餐实际提供的模型）；失败时
 *   依次降级：持久化缓存 → 目录 ID → 内置表，绝不会变成空列表。
 * - 拉取成功的 API 列表会存进 `globalState`，让重启后离线也能用（14 天过期）。
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { l10n, l10nFormat } from "./localize";
import { delay, extractHttpStatus, fetchJsonWithTimeout } from "./utils";
import { buildModelList, extractModelIds, ModelInfo } from "./modelInfo";
import {
	clearCatalogCache,
	ensureCatalogLoaded,
	getGoCatalogFacts,
	getGoCatalogModelIds,
} from "./modelsDev";
import { OPENCODE_GO_BASE_URL } from "./tomlEdit";
import { resolveApiKey } from "./apiKey";

const GO_MODELS_ENDPOINT = `${OPENCODE_GO_BASE_URL}/models`;
const PERSIST_KEY = "codexgo.modelListCache.v1";
const PERSIST_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const API_MIN_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2;

let isUpdating = false;
let lastUpdateTime = 0;
let cachedModels: ModelInfo[] | null = null;
let lastApiIds: string[] | undefined;
let lastApiAttempt = 0;
let lastApiFailure = false;

export interface PrepareModelListOptions {
	/** 绕过 TTL 与最小重试间隔。 */
	force?: boolean;
}

/** 获取模型列表（缓存新鲜时直接用缓存）。永不 reject；最差也返回内置列表。 */
export async function prepareModelList(
	options: PrepareModelListOptions,
	token: vscode.CancellationToken,
	secrets: vscode.SecretStorage,
	globalState: vscode.Memento,
): Promise<ModelInfo[]> {
	const now = Date.now();
	if (isUpdating) {
		await waitForPendingUpdate(token);
	} else if (options?.force || cachedModels === null || now - lastUpdateTime >= getUpdateIntervalMs()) {
		isUpdating = true;
		try {
			await runDiscoveryPass(options?.force === true, token, secrets, globalState);
		} catch (error) {
			// 各数据源内部已经会降级；这里是最后一道保险。
			logger.error("models.discovery.error", {
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			isUpdating = false;
			lastUpdateTime = Date.now();
		}
	}
	return cachedModels ? [...cachedModels] : [];
}

/** 丢弃全部缓存，让下一趟重新拉取所有数据（强制刷新）。 */
export function resetModelDiscoveryState(): void {
	isUpdating = false;
	lastUpdateTime = 0;
	cachedModels = null;
	lastApiAttempt = 0;
	lastApiFailure = false;
	clearCatalogCache();
	logger.info("models.discovery.reset", {});
}

/** 把原始拉取失败转换成友好、可操作的消息。 */
export function describeModelFetchError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const status = extractHttpStatus(message);
	if (status === 401 || status === 403) {
		return l10nFormat("The API key was rejected by OpenCode Go (HTTP {0}). Check the key and your Go subscription.", String(status));
	}
	if (message.includes("empty model list")) {
		return l10n("OpenCode Go returned an empty model list.");
	}
	if (message.includes("timed out")) {
		return l10nFormat("Could not reach OpenCode Go ({0}).", message);
	}
	return l10nFormat("Model list request failed: {0}", message);
}

// ── 内部实现 ──

function getUpdateIntervalMs(): number {
	const raw = vscode.workspace.getConfiguration("codexgo").get<number>("modelsDevUpdateInterval", 60_000);
	return Math.max(Number.isFinite(raw) ? raw : 60_000, 30_000);
}

async function waitForPendingUpdate(token: vscode.CancellationToken): Promise<void> {
	while (isUpdating && !token.isCancellationRequested) {
		await delay(200);
	}
}

async function runDiscoveryPass(
	force: boolean,
	token: vscode.CancellationToken,
	secrets: vscode.SecretStorage,
	globalState: vscode.Memento,
): Promise<void> {
	// 目录决定模型元数据，必须最先尝试（它内部会自行降级，永不抛异常）。
	await ensureCatalogLoaded();
	if (token.isCancellationRequested) {
		return;
	}

	const apiKey = (await resolveApiKey(secrets)).key;
	let apiIds: string[] | undefined;
	if (apiKey) {
		if (!force && lastApiIds && Date.now() - lastApiAttempt < API_MIN_INTERVAL_MS) {
			apiIds = lastApiIds;
		} else {
			lastApiAttempt = Date.now();
			try {
				apiIds = await fetchApiModelIds(apiKey, token);
				lastApiIds = apiIds;
				lastApiFailure = false;
				void persistApiIds(globalState, apiIds);
			} catch (err) {
				lastApiFailure = true;
				logger.warn("models.api.failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				apiIds = lastApiIds ?? loadPersistedApiIds(globalState);
			}
		}
	} else {
		apiIds = lastApiIds ?? loadPersistedApiIds(globalState);
	}

	cachedModels = buildModelList(apiIds, getGoCatalogFacts, getGoCatalogModelIds());
	logger.info("models.discovery.done", {
		source: cachedModels[0]?.source ?? "none",
		count: cachedModels.length,
		apiFailure: lastApiFailure,
	});
}

/** GET /inference/go/v1/models，网络 / 5xx 错误时重试一次。 */
async function fetchApiModelIds(apiKey: string, token: vscode.CancellationToken): Promise<string[]> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		if (token.isCancellationRequested) {
			throw new Error("cancelled");
		}
		try {
			const data = await fetchJsonWithTimeout<unknown>(GO_MODELS_ENDPOINT, {
				headers: { Authorization: `Bearer ${apiKey}` },
				timeoutMs: FETCH_TIMEOUT_MS,
			});
			const ids = extractModelIds(data);
			if (ids.length === 0) {
				throw new Error("empty model list");
			}
			logger.info("models.api.fetched", { count: ids.length, attempt });
			return ids;
		} catch (err) {
			lastError = err;
			const status = extractHttpStatus(err instanceof Error ? err.message : String(err));
			// 认证失败重试也不会好：立刻放弃。
			if (status === 401 || status === 403 || status === 404) {
				break;
			}
			if (attempt < MAX_ATTEMPTS) {
				await delay(1000);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface PersistedApiIds {
	apiIds: string[];
	fetchedAt: number;
}

async function persistApiIds(globalState: vscode.Memento, apiIds: string[]): Promise<void> {
	try {
		const payload: PersistedApiIds = { apiIds, fetchedAt: Date.now() };
		await globalState.update(PERSIST_KEY, payload);
	} catch (err) {
		// 写入丢失的代价只是以后多走一次离线降级。
		logger.debug("models.api.persist.failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function loadPersistedApiIds(globalState: vscode.Memento): string[] | undefined {
	const raw = globalState.get<PersistedApiIds>(PERSIST_KEY);
	if (!raw || !Array.isArray(raw.apiIds) || typeof raw.fetchedAt !== "number") {
		return undefined;
	}
	if (Date.now() - raw.fetchedAt > PERSIST_MAX_AGE_MS) {
		return undefined;
	}
	const ids = raw.apiIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
	return ids.length > 0 ? ids : undefined;
}
