import {
	normalizeModelCatalog,
	type GoModelInfo,
	type ModelCatalogSnapshot,
} from "./modelCenterData";
import type { CatalogFacts } from "./modelInfo";
import type { WireApi } from "./tomlEdit";
import { fetchJsonWithTimeout } from "./utils";

export const OPENCODE_GO_PUBLIC_MODELS_URL =
	"https://opencode.ai/inference/go/v1/models";

const CATALOG_TTL_MS = 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

let snapshot: ModelCatalogSnapshot | undefined;
let factsById = new Map<string, CatalogFacts>();
let lastAttemptAt = 0;
let lastFailureAt = 0;
let loadPromise: Promise<void> | undefined;

export function publishOfficialCatalog(
	payload: unknown,
	fetchedAt = Date.now(),
): ModelCatalogSnapshot {
	const next = normalizeModelCatalog(payload, fetchedAt);
	if (next.models.length === 0) {
		throw new Error(
			"The official OpenCode Go model catalog returned no models.",
		);
	}
	const facts = new Map<string, CatalogFacts>();
	for (const model of next.models) {
		facts.set(model.id, catalogFacts(model));
	}
	snapshot = next;
	factsById = facts;
	lastAttemptAt = fetchedAt;
	lastFailureAt = 0;
	return next;
}

export function publishOfficialCatalogSnapshot(
	value: ModelCatalogSnapshot | undefined,
): void {
	if (!value) {
		return;
	}
	snapshot = value;
	factsById = new Map(
		value.models.map((model) => [model.id, catalogFacts(model)]),
	);
	lastAttemptAt = value.fetchedAt;
}

export function getOfficialCatalogSnapshot():
	| ModelCatalogSnapshot
	| undefined {
	return snapshot;
}

export function getOfficialCatalogModelIds(): string[] {
	return snapshot?.models.map((model) => model.id) ?? [];
}

export function getOfficialCatalogFacts(
	modelId: string,
): CatalogFacts | undefined {
	return factsById.get(modelId);
}

export async function ensureOfficialCatalogLoaded(
	force = false,
): Promise<void> {
	const now = Date.now();
	if (
		!force &&
		snapshot &&
		now - lastAttemptAt < CATALOG_TTL_MS
	) {
		return;
	}
	if (
		!force &&
		lastFailureAt > 0 &&
		now - lastFailureAt < FAILED_RETRY_MS
	) {
		return;
	}
	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		const { logger } = await import("./logger");
		const startedAt = Date.now();
		lastAttemptAt = startedAt;
		try {
			const payload = await fetchJsonWithTimeout<unknown>(
				OPENCODE_GO_PUBLIC_MODELS_URL,
				{ timeoutMs: FETCH_TIMEOUT_MS },
			);
			const next = publishOfficialCatalog(payload);
			lastFailureAt = 0;
			logger.info("officialCatalog.fetch.ok", {
				durationMs: Date.now() - startedAt,
				models: next.models.length,
			});
		} catch (error) {
			lastFailureAt = Date.now();
			logger.warn("officialCatalog.fetch.failed", {
				durationMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	})().finally(() => {
		loadPromise = undefined;
	});
	return loadPromise;
}

export async function ensureOfficialCatalogLoadedOnce(): Promise<void> {
	if (
		snapshot &&
		lastFailureAt === 0 &&
		Date.now() - lastAttemptAt < CATALOG_TTL_MS
	) {
		return;
	}
	await ensureOfficialCatalogLoaded();
}

function catalogFacts(model: GoModelInfo): CatalogFacts {
	const api = wireApiForModel(model);
	const reasoning = recordValue(model.capabilities?.reasoning);
	const efforts = Array.isArray(reasoning?.effort)
		? reasoning.effort.filter(
				(value): value is string =>
					typeof value === "string" && value.length > 0,
			)
		: [];
	const costText = recordValue(model.cost?.text);
	const input = recordValue(costText?.input);
	const inputCache = recordValue(input?.cache);
	const output = recordValue(costText?.output);
	const facts: CatalogFacts = {
		name: model.name,
		wireApi: api.wireApi,
		protocolKnown: api.known,
		vision: model.inputModalities.some(
			(value) =>
				value.startsWith("image/") || value.startsWith("video/"),
		),
		deprecated: model.deprecated,
	};
	if (model.contextLimit !== undefined) {
		facts.contextLength = model.contextLimit;
	}
	if (typeof reasoning?.supported === "boolean") {
		facts.reasoning = reasoning.supported;
	}
	if (efforts.length > 0) {
		facts.efforts = efforts;
	}
	const cost: NonNullable<CatalogFacts["cost"]> = {};
	if (typeof input?.price === "number") {
		cost.input = input.price;
	}
	if (typeof output?.price === "number") {
		cost.output = output.price;
	}
	if (typeof inputCache?.read === "number") {
		cost.cacheRead = inputCache.read;
	}
	if (Object.keys(cost).length > 0) {
		facts.cost = cost;
	}
	return facts;
}

function wireApiForModel(model: GoModelInfo): {
	wireApi: WireApi;
	known: boolean;
} {
	const recommended = model.recommendedApi ?? "";
	const recommendedWire = wireApiName(recommended);
	if (recommendedWire) {
		return { wireApi: recommendedWire, known: true };
	}
	const keys = Object.keys(model.api ?? {});
	for (const key of ["responses", "messages", "chat-completions"]) {
		if (keys.includes(key)) {
			return {
				wireApi:
					key === "messages"
						? "anthropic"
						: key === "responses"
							? "responses"
							: "chat",
				known: true,
			};
		}
	}
	return { wireApi: "chat", known: false };
}

function wireApiName(value: string): WireApi | undefined {
	if (value === "responses") {
		return "responses";
	}
	if (value === "messages" || value === "anthropic-messages") {
		return "anthropic";
	}
	if (value === "chat" || value === "chat-completions") {
		return "chat";
	}
	return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
