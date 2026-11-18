import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as usage from "../out/usageStats.js";
import { UsageStore } from "../out/usageStore.js";

const tests = [];

function test(name, fn) {
	tests.push([name, fn]);
}

function record(overrides = {}) {
	return {
		schemaVersion: 1,
		id: overrides.id ?? "record",
		startedAt: overrides.startedAt ?? 1_000,
		durationMs: overrides.durationMs ?? 1_000,
		model: overrides.model ?? "deepseek-v4.1-flash",
		requestedModel: overrides.requestedModel,
		statusCode: overrides.statusCode ?? 200,
		success: overrides.success ?? true,
		errorMessage: overrides.errorMessage,
		stream: overrides.stream ?? true,
		sessionId: overrides.sessionId,
		requestId: overrides.requestId,
		previousResponseId: overrides.previousResponseId,
		inputTokens: overrides.inputTokens ?? 0,
		freshInputTokens: overrides.freshInputTokens ?? 0,
		cacheReadTokens: overrides.cacheReadTokens ?? 0,
		cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
		outputTokens: overrides.outputTokens ?? 0,
		reasoningTokens: overrides.reasoningTokens ?? 0,
		realTotalTokens: overrides.realTotalTokens ?? 0,
	};
}

test("createUsageRecord normalizes cache-inclusive input", () => {
	const created = usage.createUsageRecord(
		"proxy.usage",
		{
			traceId: "trace-1",
			startedAt: "2026-11-18T01:00:00.000Z",
			durationMs: 2345,
			model: "deepseek-v4.1-flash",
			requestedModel: "deepseek-v4.1-flash-responses",
			sessionId: "session-1",
			clientRequestId: "client-1",
			stream: true,
			inputTokens: 1000,
			cachedInputTokens: 600,
			cacheWriteTokens: 100,
			outputTokens: 200,
			reasoningTokens: 80,
		},
		"fallback",
		10,
	);
	assert.ok(created);
	assert.equal(created.id, "trace-1");
	assert.equal(created.freshInputTokens, 300);
	assert.equal(created.realTotalTokens, 1200);
	assert.equal(created.success, true);
	assert.equal(created.requestId, "client-1");
	assert.equal(created.reasoningTokens, 80);
});

test("cacheHitRate uses cacheable input as denominator", () => {
	assert.equal(usage.cacheHitRate(300, 600, 100), 0.6);
	assert.equal(usage.cacheHitRate(0, 0, 0), null);
});

test("createUsageRecord keeps fresh input when cache exceeds input", () => {
	const created = usage.createUsageRecord(
		"proxy.usage",
		{
			inputTokens: 301_003,
			cachedInputTokens: 571_520,
			outputTokens: 227,
		},
		"fallback",
		10,
	);
	assert.ok(created);
	assert.equal(created.freshInputTokens, 301_003);
	assert.equal(created.realTotalTokens, 872_750);
});

test("buildUsageSnapshot summarizes and filters records", () => {
	const first = record({
		id: "first",
		startedAt: 2_000,
		freshInputTokens: 300,
		cacheReadTokens: 600,
		cacheWriteTokens: 100,
		outputTokens: 200,
		realTotalTokens: 1_200,
	});
	const second = record({
		id: "second",
		startedAt: 3_000,
		model: "glm-5.3",
		freshInputTokens: 100,
		cacheReadTokens: 100,
		outputTokens: 50,
		realTotalTokens: 250,
		statusCode: 500,
		success: false,
		durationMs: 3_000,
	});
	const snapshot = usage.buildUsageSnapshot([first, second], {
		start: 1_000,
		end: 4_000,
		limit: 1,
	});
	assert.equal(snapshot.summary.totalRequests, 2);
	assert.equal(snapshot.summary.successRequests, 1);
	assert.equal(snapshot.summary.successRate, 0.5);
	assert.equal(snapshot.summary.realTotalTokens, 1_450);
	assert.equal(snapshot.summary.cacheHitRate, 700 / 1_200);
	assert.equal(snapshot.summary.averageDurationMs, 2_000);
	assert.equal(snapshot.records.length, 1);
	assert.equal(snapshot.records[0].id, "second");
	assert.deepEqual(snapshot.models, ["deepseek-v4.1-flash", "glm-5.3"]);
});

test("cache drop detection requires a comparable same-session input", () => {
	const previous = record({
		id: "previous",
		startedAt: 1_000,
		sessionId: "session-1",
		freshInputTokens: 50_000,
		cacheReadTokens: 600_000,
		realTotalTokens: 650_000,
	});
	const dropped = record({
		id: "dropped",
		startedAt: 2_000,
		sessionId: "session-1",
		freshInputTokens: 318_000,
		cacheReadTokens: 32_000,
		realTotalTokens: 350_000,
	});
	const otherSession = record({
		id: "other",
		startedAt: 3_000,
		sessionId: "session-2",
		freshInputTokens: 318_000,
		cacheReadTokens: 32_000,
		realTotalTokens: 350_000,
	});
	const snapshot = usage.buildUsageSnapshot([previous, dropped, otherSession], {
		start: 0,
		end: 4_000,
	});
	const byId = new Map(snapshot.records.map((entry) => [entry.id, entry]));
	assert.equal(byId.get("previous").cacheDropTokens, 0);
	assert.equal(byId.get("dropped").cacheDropTokens, 568_000);
	assert.equal(byId.get("other").cacheDropTokens, 0);
	assert.equal(snapshot.summary.cacheDropCount, 1);
});

test("status summary follows the latest session", () => {
	const summary = usage.getCacheStatusSummary(
		[
			record({
				id: "a",
				startedAt: 1_000,
				sessionId: "session-a",
				freshInputTokens: 100,
				cacheReadTokens: 900,
			}),
			record({
				id: "b",
				startedAt: 2_000,
				sessionId: "session-b",
				freshInputTokens: 200,
				cacheReadTokens: 200,
			}),
		],
		2_500,
	);
	assert.equal(summary.sessionId, "session-b");
	assert.equal(summary.requests, 1);
	assert.equal(summary.cacheHitRate, 0.5);
});

test("UsageStore persists and reloads compact JSONL records", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexgo-usage-"));
	try {
		const store = new UsageStore(root);
		await store.initialize();
		const now = Date.now();
		store.handleProxyLog("proxy.usage", {
			traceId: "persisted-1",
			startedAt: new Date(now).toISOString(),
			durationMs: 1_500,
			model: "deepseek-v4.1-flash",
			sessionId: "session-persisted",
			inputTokens: 1_000,
			cachedInputTokens: 600,
			cacheWriteTokens: 100,
			outputTokens: 200,
			reasoningTokens: 80,
			stream: true,
			status: 200,
		});
		await store.flush();
		const reloaded = new UsageStore(root);
		await reloaded.initialize();
		const snapshot = reloaded.getSnapshot({ start: now - 1_000, end: now + 1_000 });
		assert.equal(snapshot.records.length, 1);
		assert.equal(snapshot.records[0].id, "persisted-1");
		assert.equal(snapshot.records[0].freshInputTokens, 300);
		assert.equal(snapshot.records[0].sessionId, "session-persisted");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

let passes = 0;
let failures = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		passes++;
		console.log(`  PASS - ${name}`);
	} catch (error) {
		failures++;
		console.error(`  FAIL - ${name}`);
		console.error(`    ${error.stack || error.message}`);
	}
}
console.log(`\nPASS ${passes}, FAIL ${failures}`);
process.exitCode = failures > 0 ? 1 : 0;
