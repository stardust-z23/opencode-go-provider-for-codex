import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const data = require("../out/modelCenterData.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

function model(overrides = {}) {
	return {
		id: "grok-4.7",
		name: "Grok 4.7",
		canonical_id: "xai/grok-4.7",
		description: "Long-context model",
		release_date: "2026-09-21",
		last_updated: "2026-09-21",
		recommended_api: "responses",
		modalities: {
			input: ["text", "image/png"],
			output: ["text"],
		},
		capabilities: {
			reasoning: {
				supported: true,
				effort: ["low", "high"],
			},
		},
		limit: {
			context: 500000,
			output: 500000,
		},
		cost: {
			text: {
				input: {
					price: 2,
					cache: { read: 0.5 },
					overrides: [
						{
							when: { context: { gt: 200000 } },
							price: 4,
							cache: { read: 1 },
						},
					],
				},
				output: {
					price: 6,
					overrides: [
						{
							when: { context: { gt: 200000 } },
							price: 12,
						},
					],
				},
			},
			multipliers: [
				{
					when: {
						utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
						any: [
							{
								all: [
									{ utc_hours: { gte: "01:00" } },
									{ utc_hours: { lt: "04:00" } },
								],
							},
							{
								all: [
									{ utc_hours: { gte: "06:00" } },
									{ utc_hours: { lt: "10:00" } },
								],
							},
						],
					},
					factor: 2,
				},
			],
		},
		api: {
			responses: {
				base_url: "https://opencode.ai/inference/go/openai/v1",
			},
		},
		go: {
			monthly_usage: {
				go: 15,
				"go-plus": 60,
				"go-teams": 20,
			},
			training: false,
			zdr: false,
			limited_regions: true,
			featured: true,
		},
		...overrides,
	};
}

function change(id, detectedAt, modelId, kind) {
	return {
		id,
		detectedAt,
		kind,
		modelId,
		modelName: modelId,
		title: kind,
		details: [],
	};
}

test("normalizes public model metadata", () => {
	const normalized = data.normalizeModelInfo(model());
	assert.ok(normalized);
	assert.equal(normalized.id, "grok-4.7");
	assert.equal(normalized.monthlyUsage.go, 15);
	assert.equal(normalized.inputModalities.length, 2);
	assert.equal(normalized.contextLimit, 500000);
	assert.equal(normalized.limitedTime, false);
});

test("detects free limited-time models", () => {
	const normalized = data.normalizeModelInfo(
		model({
			id: "free-model",
			cost: {
				text: {
					input: { price: 0 },
					output: { price: 0 },
				},
			},
			go: {
				monthly_usage: {
					go: null,
					"go-plus": null,
					"go-teams": null,
				},
			},
		}),
	);
	assert.ok(normalized);
	assert.equal(normalized.limitedTime, true);
});

test("reloading a normalized snapshot does not erase metadata", () => {
	const first = data.normalizeModelCatalog(
		{ data: [model()] },
		Date.parse("2026-11-19T00:00:00.000Z"),
	);
	const reloaded = data.normalizeModelCatalog(
		{ data: first.models },
		first.fetchedAt,
	);
	assert.deepEqual(reloaded.models, first.models);
	assert.deepEqual(data.diffModelCatalogs(first, reloaded), []);
});

test("extracts context tiers and peak rules", () => {
	const normalized = data.normalizeModelInfo(model());
	assert.ok(normalized);
	assert.deepEqual(data.modelContextPriceTiers(normalized), [
		{
			threshold: 200000,
			comparison: "gt",
			input: 4,
			cacheRead: 1,
			cacheWrite: null,
			output: 12,
		},
	]);
	const rules = data.modelTimePriceRules(normalized);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].factor, 2);
	assert.deepEqual(rules[0].periods, [
		{ gte: "01:00", lt: "04:00" },
		{ gte: "06:00", lt: "10:00" },
	]);
});

test("applies peak multipliers in UTC", () => {
	const normalized = data.normalizeModelInfo(model());
	assert.ok(normalized);
	const peak = data.effectiveModelPrice(
		normalized,
		Date.parse("2026-11-16T02:00:00.000Z"),
	);
	assert.equal(peak.input, 4);
	assert.equal(peak.cacheRead, 1);
	assert.equal(peak.output, 12);
	assert.equal(peak.multiplier, 2);
	const standard = data.effectiveModelPrice(
		normalized,
		Date.parse("2026-11-16T05:00:00.000Z"),
	);
	assert.equal(standard.input, 2);
	assert.equal(standard.multiplier, 1);
});

test("builds deterministic model changes with stable categories", () => {
	const previous = data.normalizeModelCatalog(
		{ data: [model()] },
		Date.parse("2026-11-19T00:00:00.000Z"),
	);
	const changed = model({
		limit: { context: 400000, output: 500000 },
		go: {
			monthly_usage: { go: 20, "go-plus": 60, "go-teams": 20 },
			training: false,
			zdr: false,
			limited_regions: true,
			featured: true,
		},
	});
	const next = data.normalizeModelCatalog(
		{ data: [changed, model({ id: "new-model", name: "New Model" })] },
		Date.parse("2026-11-19T01:00:00.000Z"),
	);
	const now = Date.parse("2026-11-19T01:00:00.000Z");
	const first = data.diffModelCatalogs(previous, next, now);
	const second = data.diffModelCatalogs(previous, next, now);
	assert.deepEqual(
		first.map((change) => change.kind).sort(),
		["added", "limits", "monthly_usage"],
	);
	assert.deepEqual(
		first.map((change) => change.id),
		second.map((change) => change.id),
	);
});

test("removes legacy hydration batches without deleting normal changes", () => {
	const changes = [];
	for (let index = 0; index < 12; index++) {
		changes.push(
			change(`meta-${index}`, 1_000, `model-${index}`, "metadata"),
			change(`limit-${index}`, 1_000, `model-${index}`, "limits"),
		);
	}
	changes.push(change("real-change", 2_000, "model-real", "pricing"));
	const result = data.removeLegacyHydrationChangeBatches(changes);
	assert.equal(result.removedChanges, 24);
	assert.equal(result.removedModels, 12);
	assert.equal(result.batches, 1);
	assert.deepEqual(
		result.changes.map((entry) => entry.id),
		["real-change"],
	);
});

test("parses official RSS including CDATA and entities", () => {
	const items = data.parseOfficialNewsFeed(`
		<rss><channel>
			<item>
				<title><![CDATA[GLM-5.3 &amp; pricing update]]></title>
				<link>https://opencode.ai/console/changelog/glm-5-3</link>
				<guid>changelog-glm</guid>
				<description><![CDATA[<p>Monthly limits &amp; prices changed.</p>]]></description>
				<pubDate>Thu, 19 Nov 2026 08:00:00 GMT</pubDate>
			</item>
		</channel></rss>
	`);
	assert.equal(items.length, 1);
	assert.equal(items[0].title, "GLM-5.3 & pricing update");
	assert.equal(items[0].guid, "changelog-glm");
	assert.match(items[0].description, /Monthly limits/);
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
