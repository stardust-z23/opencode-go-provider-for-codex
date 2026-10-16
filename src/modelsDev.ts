/**
 * models.dev 目录的拉取与查询引擎（裁剪到 Codex 选择器真正需要的部分：
 * 元数据补充与协议推导）。
 *
 * 设计沿用 OpenCode Go Provider for Copilot 的目录层：
 *
 * - 拉取链：models.dev 官方（10 秒）→ 配置的镜像（30 秒，携带 `platform` /
 *   `x-mirror-token` 头）→ 继续使用此前缓存的数据（再往上调用方会降级到
 *   内置模型表）。
 * - 内存缓存带短 TTL（设置项 `codexgo.modelsDevUpdateInterval`，最小 30 秒），
 *   用于合并启动时的并发激活请求。
 * - 加载失败后至少 60 秒才会重试，避免网络不通时被每次刷新反复冲击。
 * - 拉取失败绝不会清掉已有的良好缓存。
 */

import * as vscode from "vscode";
import { logger } from "./logger";
import { fetchJsonWithTimeout, MIRROR_PLATFORM_HEADER } from "./utils";
import type { CatalogFacts, ModelCost } from "./modelInfo";
import type { WireApi } from "./tomlEdit";

const CATALOG_URL = "https://models.dev/catalog.json";
const OFFICIAL_TIMEOUT_MS = 10_000;
const MIRROR_TIMEOUT_MS = 30_000;
const FAILED_LOAD_RETRY_MS = 60_000;
const GO_PROVIDER_ID = "opencode-go";

// ── 目录的最小结构化类型（全部可选，纯防御式） ──

interface CatalogReasoningOption {
	type?: string;
	values?: string[];
}

interface CatalogModelEntry {
	id?: string;
	name?: string;
	family?: string;
	reasoning?: boolean;
	attachment?: boolean;
	modalities?: { input?: string[] };
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number };
	reasoning_options?: CatalogReasoningOption[];
	status?: string;
	/** 单模型级别的适配器覆盖，例如 `{ npm: "@ai-sdk/anthropic" }`。 */
	provider?: { npm?: string };
}

interface CatalogProviderEntry {
	api?: string;
	npm?: string;
	models?: Record<string, CatalogModelEntry>;
}

interface Catalog {
	models?: Record<string, CatalogModelEntry>;
	providers?: Record<string, CatalogProviderEntry>;
}

// ── 模块级缓存 ──

/** `opencode-go` provider 的模型，按短 ID 索引。 */
let providerModels: Map<string, CatalogModelEntry> | null = null;
/** 全局目录，按短 ID（完整 ID 的最后一段）索引。 */
let globalByShortId: Map<string, CatalogModelEntry> | null = null;
/** provider 级适配器包（`providers["opencode-go"].npm`），模型自身没有覆盖时使用。 */
let goProviderNpm: string | undefined;
let cacheTimestamp = 0;
let lastLoadFailed = false;

// ── 设置 ──

function getUpdateIntervalMs(): number {
	const raw = vscode.workspace.getConfiguration("codexgo").get<number>("modelsDevUpdateInterval", 60_000);
	return Math.max(Number.isFinite(raw) ? raw : 60_000, 30_000);
}

interface MirrorConfig {
	url?: string;
	token?: string;
}

function getMirrorConfig(): MirrorConfig {
	const cfg = vscode.workspace.getConfiguration("codexgo");
	const rawUrl = cfg.get<string>("modelsDevMirrorUrl", "")?.trim();
	if (!rawUrl) {
		return {};
	}
	return {
		url: rawUrl.endsWith("/") ? `${rawUrl}catalog.json` : rawUrl,
		token: cfg.get<string>("modelsDevMirrorToken", "")?.trim() || undefined,
	};
}

// ── 拉取 ──

/**
 * 拉取目录。降级链：官方 → 配置的镜像。
 * 两者都失败时抛出异常（调用方保留现有缓存）。
 */
async function fetchCatalog(): Promise<Catalog> {
	const officialStart = Date.now();
	try {
		const data = await fetchJsonWithTimeout<Catalog>(CATALOG_URL, { timeoutMs: OFFICIAL_TIMEOUT_MS });
		logger.info("catalog.fetch.official", { durationMs: Date.now() - officialStart });
		return data;
	} catch (err) {
		logger.warn("catalog.fetch.officialFailed", {
			durationMs: Date.now() - officialStart,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const mirror = getMirrorConfig();
	if (mirror.url) {
		const mirrorStart = Date.now();
		try {
			const headers: Record<string, string> = { platform: MIRROR_PLATFORM_HEADER };
			if (mirror.token) {
				headers["x-mirror-token"] = mirror.token;
			}
			const data = await fetchJsonWithTimeout<Catalog>(mirror.url, {
				timeoutMs: MIRROR_TIMEOUT_MS,
				headers,
			});
			logger.info("catalog.fetch.mirror", { url: mirror.url, durationMs: Date.now() - mirrorStart });
			return data;
		} catch (err) {
			logger.warn("catalog.fetch.mirrorFailed", {
				url: mirror.url,
				durationMs: Date.now() - mirrorStart,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	throw new Error("models.dev catalog unreachable");
}

function rebuildIndex(data: Catalog): void {
	providerModels = new Map();
	globalByShortId = new Map();

	for (const [fullId, entry] of Object.entries(data.models ?? {})) {
		const slashIndex = fullId.lastIndexOf("/");
		const shortId = slashIndex >= 0 ? fullId.slice(slashIndex + 1) : fullId;
		if (!globalByShortId.has(shortId)) {
			globalByShortId.set(shortId, entry);
		}
	}

	const goProvider = data.providers?.[GO_PROVIDER_ID];
	goProviderNpm = typeof goProvider?.npm === "string" ? goProvider.npm : undefined;
	for (const [id, entry] of Object.entries(goProvider?.models ?? {})) {
		if (!providerModels.has(id)) {
			providerModels.set(id, entry);
		}
	}
}

/**
 * 确保目录已加载并缓存。失败时静默降级：已有缓存（再往上一层是内置表）
 * 保持不变。
 */
export async function ensureCatalogLoaded(): Promise<void> {
	const now = Date.now();
	if (!lastLoadFailed && providerModels !== null && now - cacheTimestamp < getUpdateIntervalMs()) {
		return; // 缓存还新鲜
	}
	if (lastLoadFailed && providerModels !== null && now - cacheTimestamp < FAILED_LOAD_RETRY_MS) {
		return; // 失败后的最小重试间隔内
	}

	const start = Date.now();
	try {
		const data = await fetchCatalog();
		rebuildIndex(data);
		cacheTimestamp = now;
		lastLoadFailed = false;
		logger.info("catalog.load", {
			durationMs: Date.now() - start,
			goModels: providerModels?.size ?? 0,
			globalModels: globalByShortId?.size ?? 0,
		});
	} catch (err) {
		if (providerModels === null) {
			// 从未成功加载过：初始化空索引，让调用方干净地降级。
			providerModels = new Map();
			globalByShortId = new Map();
		}
		cacheTimestamp = now;
		lastLoadFailed = true;
		logger.warn("catalog.load.failed", {
			durationMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** 目录中 `opencode-go` provider 提供的模型 ID。 */
export function getGoCatalogModelIds(): string[] {
	return providerModels ? [...providerModels.keys()] : [];
}

/** 清空目录缓存（强制刷新时使用）。 */
export function clearCatalogCache(): void {
	providerModels = null;
	globalByShortId = null;
	goProviderNpm = undefined;
	cacheTimestamp = 0;
	lastLoadFailed = false;
}

// ── 单模型元数据 ──

/**
 * 解析 OpenCode Go 模型的补充元数据。
 * 按字段取值：provider 条目 → 全局条目 → undefined。
 */
export function getGoCatalogFacts(modelId: string): CatalogFacts | undefined {
	const providerEntry = providerModels?.get(modelId);
	const globalEntry = globalByShortId?.get(modelId);
	if (providerEntry === undefined && globalEntry === undefined) {
		return undefined;
	}

	const pick = <T>(a: T | undefined, b: T | undefined): T | undefined => a ?? b;

	const name = pick(providerEntry?.name, globalEntry?.name);
	const contextLength = pick(providerEntry?.limit?.context, globalEntry?.limit?.context);
	const reasoning = pick(providerEntry?.reasoning, globalEntry?.reasoning);
	const status = pick(providerEntry?.status, globalEntry?.status);
	const attachment = pick(providerEntry?.attachment, globalEntry?.attachment);
	const modalities = pick(providerEntry?.modalities, globalEntry?.modalities);
	const rawCost = pick(providerEntry?.cost, globalEntry?.cost);
	const reasoningOptions = pick(providerEntry?.reasoning_options, globalEntry?.reasoning_options);

	// 适配器包：单模型覆盖 → provider 级默认值（与参考实现的
	// `entry.provider.npm ?? provider.npm` 链一致）。
	const adapterNpm = providerEntry?.provider?.npm ?? goProviderNpm;
	const wire = deduceWireApi(modelId, adapterNpm, globalEntry ?? providerEntry);

	const facts: CatalogFacts = {
		wireApi: wire,
		protocolKnown: isRecognizedAdapter(adapterNpm),
	};
	if (name) {
		facts.name = name;
	}
	if (typeof contextLength === "number") {
		facts.contextLength = contextLength;
	}
	if (typeof reasoning === "boolean") {
		facts.reasoning = reasoning;
	}
	if (status === "deprecated") {
		facts.deprecated = true;
	}
	facts.vision = attachment === true || (modalities?.input ?? []).some(
		(m) => m === "image" || m === "video",
	);
	if (rawCost) {
		const cost: ModelCost = {};
		if (typeof rawCost.input === "number") {
			cost.input = rawCost.input;
		}
		if (typeof rawCost.output === "number") {
			cost.output = rawCost.output;
		}
		if (typeof rawCost.cache_read === "number") {
			cost.cacheRead = rawCost.cache_read;
		}
		facts.cost = cost;
	}
	const efforts = extractEfforts(reasoningOptions);
	if (efforts.length > 0) {
		facts.efforts = efforts;
	}
	return facts;
}

function extractEfforts(options: CatalogReasoningOption[] | undefined): string[] {
	if (!options) {
		return [];
	}
	for (const option of options) {
		if (option.type === "effort" && Array.isArray(option.values) && option.values.length > 0) {
			return option.values.filter((v): v is string => typeof v === "string");
		}
	}
	return [];
}

function isRecognizedAdapter(npm: string | undefined): boolean {
	return npm === "@ai-sdk/openai" || npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/openai-compatible";
}

/**
 * 由目录的适配器包推导线上协议。
 * 家族启发式仅作为兜底：只用于没有给出可识别适配器包的目录（与参考实现
 * 一致），这类结果在上游会被标记为「非已知」。
 */
function deduceWireApi(modelId: string, adapterNpm: string | undefined, entry: CatalogModelEntry | undefined): WireApi {
	switch (adapterNpm) {
		case "@ai-sdk/openai":
			return "responses";
		case "@ai-sdk/anthropic":
			return "anthropic";
		case "@ai-sdk/openai-compatible":
			return "chat";
	}
	const family = entry?.family?.toLowerCase() ?? "";
	if (family.includes("claude") || family.includes("anthropic") || family.includes("gemma")) {
		return "anthropic";
	}
	if (family.includes("qwen")) {
		// 当前世代（3.6+）在 OpenCode Go 上通过 Anthropic Messages 提供。
		return /qwen[\s-]*3\.[6-9]/i.test(modelId) ? "anthropic" : "chat";
	}
	if (family.includes("grok") || family.includes("gpt")) {
		return "responses";
	}
	return "chat";
}
