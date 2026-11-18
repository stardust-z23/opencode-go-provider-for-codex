export type UsageRangePreset = "1h" | "today" | "7d";
export type UsageStatusFilter = "all" | "success" | "error";

export interface UsageRecord {
	schemaVersion: 1;
	id: string;
	startedAt: number;
	durationMs: number;
	model: string;
	requestedModel?: string;
	statusCode: number;
	success: boolean;
	errorMessage?: string;
	stream: boolean;
	sessionId?: string;
	requestId?: string;
	previousResponseId?: string;
	inputTokens: number;
	freshInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	realTotalTokens: number;
}

export interface UsageRecordView extends UsageRecord {
	cacheHitRate: number | null;
	cacheDropTokens: number;
}

export interface UsageRecordQuery {
	start: number;
	end: number;
	model?: string;
	status?: UsageStatusFilter;
	limit?: number;
}

export interface UsageSummary {
	totalRequests: number;
	successRequests: number;
	successRate: number;
	freshInputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	realTotalTokens: number;
	cacheHitRate: number | null;
	averageDurationMs: number;
	cacheDropCount: number;
	cacheDropTokens: number;
}

export interface UsageTrendPoint {
	start: number;
	requests: number;
	tokens: number;
	cacheHitRate: number | null;
}

export interface UsageDashboardSnapshot {
	start: number;
	end: number;
	summary: UsageSummary;
	models: string[];
	records: UsageRecordView[];
	totalMatched: number;
	recordLimit: number;
	trend: UsageTrendPoint[];
}

export interface CacheStatusSummary {
	sessionId?: string;
	requests: number;
	cacheHitRate: number | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CACHE_DROP_MIN_PREVIOUS = 50_000;
const CACHE_DROP_MIN_TOKENS = 32_000;

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Convert one proxy lifecycle log into a compact, content-free usage record.
 * Protocol details stay in the proxy logs and are deliberately not persisted.
 */
export function createUsageRecord(
	message: string,
	detail: Record<string, unknown> | undefined,
	fallbackId: string,
	now = Date.now(),
): UsageRecord | undefined {
	if (message !== "proxy.usage" && message !== "proxy.upstream_error") {
		return undefined;
	}

	const source = detail ?? {};
	const startedAtValue = Date.parse(String(source.startedAt ?? ""));
	const startedAt = Number.isFinite(startedAtValue) ? startedAtValue : now;
	const statusCode = finiteNumber(source.status) || (message === "proxy.usage" ? 200 : 500);
	const success = message === "proxy.usage" || (statusCode >= 200 && statusCode < 300);
	const inputTokens = finiteNumber(source.inputTokens);
	const cacheReadTokens = finiteNumber(source.cachedInputTokens);
	const cacheWriteTokens = finiteNumber(source.cacheWriteTokens);
	const outputTokens = finiteNumber(source.outputTokens);
	const reasoningTokens = finiteNumber(source.reasoningTokens);
	const cacheTotal = cacheReadTokens + cacheWriteTokens;
	// OpenAI-style usage reports total input including cache. Some gateways report
	// fresh input instead, which is detectable when the cache count exceeds input.
	const freshInputTokens =
		inputTokens >= cacheTotal ? inputTokens - cacheTotal : inputTokens;

	return {
		schemaVersion: 1,
		id: optionalString(source.traceId) ?? fallbackId,
		startedAt,
		durationMs: finiteNumber(source.durationMs),
		model: optionalString(source.model) ?? "unknown",
		requestedModel: optionalString(source.requestedModel),
		statusCode,
		success,
		errorMessage: optionalString(source.detail)?.slice(0, 2000),
		stream: source.stream === true,
		sessionId: optionalString(source.sessionId),
		requestId: optionalString(source.clientRequestId) ?? optionalString(source.requestId),
		previousResponseId: optionalString(source.previousResponseId),
		inputTokens,
		freshInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		outputTokens,
		reasoningTokens,
		realTotalTokens:
			freshInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
	};
}

export function parseUsageRecord(value: unknown): UsageRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.id !== "string" || !record.id) {
		return undefined;
	}
	const startedAt = finiteNumber(record.startedAt);
	if (!startedAt) {
		return undefined;
	}
	const statusCode = finiteNumber(record.statusCode);
	const inputTokens = finiteNumber(record.inputTokens);
	const cacheReadTokens = finiteNumber(record.cacheReadTokens);
	const cacheWriteTokens = finiteNumber(record.cacheWriteTokens);
	const outputTokens = finiteNumber(record.outputTokens);
	const freshInputTokens = finiteNumber(record.freshInputTokens);
	return {
		schemaVersion: 1,
		id: record.id,
		startedAt,
		durationMs: finiteNumber(record.durationMs),
		model: optionalString(record.model) ?? "unknown",
		requestedModel: optionalString(record.requestedModel),
		statusCode,
		success: record.success === true || (statusCode >= 200 && statusCode < 300),
		errorMessage: optionalString(record.errorMessage),
		stream: record.stream === true,
		sessionId: optionalString(record.sessionId),
		requestId: optionalString(record.requestId),
		previousResponseId: optionalString(record.previousResponseId),
		inputTokens,
		freshInputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		outputTokens,
		reasoningTokens: finiteNumber(record.reasoningTokens),
		realTotalTokens:
			finiteNumber(record.realTotalTokens) ||
			freshInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
	};
}

export function cacheHitRate(
	freshInputTokens: number,
	cacheReadTokens: number,
	cacheWriteTokens: number,
): number | null {
	const denominator =
		Math.max(0, freshInputTokens) +
		Math.max(0, cacheReadTokens) +
		Math.max(0, cacheWriteTokens);
	return denominator > 0 ? Math.max(0, cacheReadTokens) / denominator : null;
}

function annotateCacheDrops(records: UsageRecord[]): UsageRecordView[] {
	const ascending = [...records].sort((left, right) => left.startedAt - right.startedAt);
	const previousBySession = new Map<string, UsageRecord>();
	const annotated = new Map<string, UsageRecordView>();

	for (const record of ascending) {
		const hitRate = cacheHitRate(
			record.freshInputTokens,
			record.cacheReadTokens,
			record.cacheWriteTokens,
		);
		let cacheDropTokens = 0;
		const key = record.sessionId ? `${record.sessionId}\u0000${record.model}` : undefined;
		if (key && record.success) {
			const previous = previousBySession.get(key);
			const previousInput =
				previous === undefined
					? 0
					: previous.freshInputTokens +
						previous.cacheReadTokens +
						previous.cacheWriteTokens;
			const currentInput =
				record.freshInputTokens + record.cacheReadTokens + record.cacheWriteTokens;
			const drop = previous ? previous.cacheReadTokens - record.cacheReadTokens : 0;
			if (
				previous &&
				previous.cacheReadTokens >= CACHE_DROP_MIN_PREVIOUS &&
				drop >= CACHE_DROP_MIN_TOKENS &&
				record.cacheReadTokens <= previous.cacheReadTokens * 0.5 &&
				currentInput >= previousInput * 0.5
			) {
				cacheDropTokens = drop;
			}
			previousBySession.set(key, record);
		}
		annotated.set(record.id, { ...record, cacheHitRate: hitRate, cacheDropTokens });
	}

	return [...annotated.values()];
}

function trendBucketMs(start: number, end: number): number {
	const duration = Math.max(0, end - start);
	if (duration <= 6 * HOUR_MS) {
		return 5 * MINUTE_MS;
	}
	if (duration <= 36 * HOUR_MS) {
		return HOUR_MS;
	}
	return DAY_MS;
}

function buildTrend(records: UsageRecordView[], start: number, end: number): UsageTrendPoint[] {
	const bucketMs = trendBucketMs(start, end);
	const buckets = new Map<
		number,
		{ requests: number; tokens: number; fresh: number; read: number; write: number }
	>();
	const alignedStart = Math.floor(start / bucketMs) * bucketMs;
	for (let cursor = alignedStart; cursor <= end; cursor += bucketMs) {
		buckets.set(cursor, { requests: 0, tokens: 0, fresh: 0, read: 0, write: 0 });
	}
	for (const record of records) {
		const bucketStart = Math.floor(record.startedAt / bucketMs) * bucketMs;
		const bucket = buckets.get(bucketStart);
		if (!bucket) {
			continue;
		}
		bucket.requests += 1;
		bucket.tokens += record.realTotalTokens;
		bucket.fresh += record.freshInputTokens;
		bucket.read += record.cacheReadTokens;
		bucket.write += record.cacheWriteTokens;
	}
	return [...buckets.entries()]
		.sort((left, right) => left[0] - right[0])
		.map(([bucketStart, bucket]) => ({
			start: bucketStart,
			requests: bucket.requests,
			tokens: bucket.tokens,
			cacheHitRate: cacheHitRate(bucket.fresh, bucket.read, bucket.write),
		}));
}

export function buildUsageSnapshot(
	allRecords: UsageRecord[],
	query: UsageRecordQuery,
): UsageDashboardSnapshot {
	const start = Math.min(query.start, query.end);
	const end = Math.max(query.start, query.end);
	const inRange = allRecords.filter(
		(record) => record.startedAt >= start && record.startedAt <= end,
	);
	const models = [...new Set(inRange.map((record) => record.model))].sort((left, right) =>
		left.localeCompare(right),
	);
	const annotated = annotateCacheDrops(inRange);
	const filtered = annotated.filter((record) => {
		if (query.model && record.model !== query.model) {
			return false;
		}
		if (query.status === "success" && !record.success) {
			return false;
		}
		if (query.status === "error" && record.success) {
			return false;
		}
		return true;
	});
	const descending = [...filtered].sort((left, right) => right.startedAt - left.startedAt);
	const records = descending.slice(0, Math.max(1, query.limit ?? 200));
	const totalRequests = filtered.length;
	const successRequests = filtered.reduce(
		(count, record) => count + (record.success ? 1 : 0),
		0,
	);
	const freshInputTokens = filtered.reduce(
		(sum, record) => sum + record.freshInputTokens,
		0,
	);
	const cacheReadTokens = filtered.reduce(
		(sum, record) => sum + record.cacheReadTokens,
		0,
	);
	const cacheWriteTokens = filtered.reduce(
		(sum, record) => sum + record.cacheWriteTokens,
		0,
	);
	const outputTokens = filtered.reduce((sum, record) => sum + record.outputTokens, 0);
	const reasoningTokens = filtered.reduce(
		(sum, record) => sum + record.reasoningTokens,
		0,
	);
	const realTotalTokens = filtered.reduce(
		(sum, record) => sum + record.realTotalTokens,
		0,
	);
	const durationTotal = filtered.reduce((sum, record) => sum + record.durationMs, 0);
	const cacheDrops = filtered.filter((record) => record.cacheDropTokens > 0);
	return {
		start,
		end,
		summary: {
			totalRequests,
			successRequests,
			successRate: totalRequests > 0 ? successRequests / totalRequests : 0,
			freshInputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			outputTokens,
			reasoningTokens,
			realTotalTokens,
			cacheHitRate: cacheHitRate(freshInputTokens, cacheReadTokens, cacheWriteTokens),
			averageDurationMs: totalRequests > 0 ? Math.round(durationTotal / totalRequests) : 0,
			cacheDropCount: cacheDrops.length,
			cacheDropTokens: cacheDrops.reduce(
				(sum, record) => sum + record.cacheDropTokens,
				0,
			),
		},
		models,
		records,
		totalMatched: totalRequests,
		recordLimit: Math.max(1, query.limit ?? 200),
		trend: buildTrend(descending, start, end),
	};
}

/**
 * Compact status-bar summary. Prefer the latest conversation; fall back to the
 * last hour when a client does not send a stable session header.
 */
export function getCacheStatusSummary(
	records: UsageRecord[],
	now = Date.now(),
): CacheStatusSummary {
	const descending = [...records].sort((left, right) => right.startedAt - left.startedAt);
	const latestWithSession = descending.find(
		(record) => record.success && record.sessionId,
	);
	const selected = latestWithSession
		? descending.filter(
				(record) =>
					record.success &&
					record.sessionId === latestWithSession.sessionId &&
					record.startedAt <= now,
			)
		: descending.filter(
				(record) =>
					record.success &&
					record.startedAt >= now - HOUR_MS &&
					record.startedAt <= now,
			);
	const fresh = selected.reduce((sum, record) => sum + record.freshInputTokens, 0);
	const read = selected.reduce((sum, record) => sum + record.cacheReadTokens, 0);
	const write = selected.reduce((sum, record) => sum + record.cacheWriteTokens, 0);
	return {
		sessionId: latestWithSession?.sessionId,
		requests: selected.length,
		cacheHitRate: cacheHitRate(fresh, read, write),
	};
}
