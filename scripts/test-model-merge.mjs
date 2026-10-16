#!/usr/bin/env node
/**
 * 纯函数模型列表构建器（out/modelInfo.js）的单元测试。
 *
 * 运行方式：npm test
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildModelList, extractModelIds, formatTokenCount, formatPrice } = require("../out/modelInfo.js");
const { HARDCODED_GO_MODELS } = require("../out/hardcodedModels.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

test("extractModelIds 能处理各种真实出现的载荷结构", () => {
	assert.deepEqual(
		extractModelIds({ object: "list", data: [{ id: "a" }, { id: "b" }] }),
		["a", "b"],
	);
	assert.deepEqual(extractModelIds(["x", "y"]), ["x", "y"]);
	assert.deepEqual(extractModelIds({ models: [{ id: "m" }] }), ["m"]);
	assert.deepEqual(extractModelIds({ models: ["m", "n"] }), ["m", "n"]);
	assert.deepEqual(extractModelIds({ data: [{ id: "a" }, { id: "a" }] }), ["a"], "已去重");
	assert.deepEqual(extractModelIds({ data: [{ name: "no-id" }, { id: "  " }] }), [], "忽略垃圾数据");
	assert.deepEqual(extractModelIds({}), []);
	assert.deepEqual(extractModelIds(null), []);
	assert.deepEqual(extractModelIds("nonsense"), []);
});

test("已知模型的协议来自内置快照", () => {
	const list = buildModelList(["kimi-k3", "grok-4.7", "qwen3.8-max"], () => undefined, []);
	const byId = Object.fromEntries(list.map((m) => [m.id, m]));
	assert.equal(byId["kimi-k3"].wireApi, "chat");
	assert.equal(byId["kimi-k3"].supported, true);
	assert.equal(byId["kimi-k3"].protocolKnown, true);
	assert.equal(byId["grok-4.7"].wireApi, "responses");
	assert.equal(byId["grok-4.7"].supported, true);
	assert.equal(byId["qwen3.8-max"].wireApi, "anthropic");
	assert.equal(byId["qwen3.8-max"].supported, true);
	assert.equal(list[0].source, "api");
});

test("未知模型按 chat 猜测，但标记为协议未知", () => {
	const list = buildModelList(["brand-new-model"], () => undefined, []);
	assert.equal(list.length, 1);
	assert.equal(list[0].wireApi, "chat");
	assert.equal(list[0].supported, true);
	assert.equal(list[0].protocolKnown, false);
	assert.equal(list[0].name, "brand-new-model");
});

test("DeepSeek follows the official Chat Completions mapping", () => {
	// OpenCode Go's official endpoint table serves DeepSeek over Chat Completions.
	// The local proxy bridges that protocol to Codex's Responses API.
	// Official OpenCode Go endpoint table: DeepSeek is served over Chat Completions.
	const ids = [
		"deepseek-flash",
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp",
		"deepseek-v4-pro",
		"deepseek-v4.1-flash",
	];
	const list = buildModelList(ids, () => undefined, []);
	for (const model of list) {
		assert.equal(model.wireApi, "chat", model.id);
		assert.equal(model.supported, true, model.id);
		assert.equal(model.protocolKnown, true, model.id);
	}
});

test("降级顺序：api → 目录 → 内置；空 API 列表按不可用处理", () => {
	const fromCatalog = buildModelList(undefined, () => undefined, ["cat-model"]);
	assert.equal(fromCatalog[0].id, "cat-model");
	assert.equal(fromCatalog[0].source, "catalog");

	const emptyApi = buildModelList([], () => undefined, ["cat-model"]);
	assert.equal(emptyApi[0].source, "catalog", "空 API 列表与 undefined 一样走降级");

	const fromHardcoded = buildModelList(undefined, () => undefined, []);
	assert.equal(fromHardcoded[0].source, "hardcoded");
	assert.equal(fromHardcoded.length, HARDCODED_GO_MODELS.length);
});

test("目录元数据补充条目；已知 ID 以内置协议为准", () => {
	const facts = (id) =>
		id === "grok-4.7"
			? {
					name: "Grok 4.7 (catalog)",
					contextLength: 200000,
					cost: { input: 2, output: 6 },
					reasoning: true,
					efforts: ["low", "high"],
					vision: false,
					deprecated: false,
					wireApi: "chat",
					protocolKnown: true,
				}
			: undefined;
	const list = buildModelList(["grok-4.7"], facts, []);
	const model = list[0];
	assert.equal(model.wireApi, "responses", "已知 ID 以内置表为准");
	assert.equal(model.name, "Grok 4.7 (catalog)");
	assert.equal(model.contextLength, 200000);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.efforts, ["low", "high"]);
	assert.equal(model.deprecated, false);
	assert.deepEqual(model.cost, { input: 2, output: 6 });
});

test("免费判定：内置标记与目录零价格", () => {
	const list = buildModelList(
		["longcat-2.5-preview-free", "glm-5.3"],
		(id) => (id === "glm-5.3" ? { cost: { input: 0, output: 0 }, deprecated: true } : undefined),
		[],
	);
	const byId = Object.fromEntries(list.map((m) => [m.id, m]));
	assert.equal(byId["longcat-2.5-preview-free"].free, true);
	assert.equal(byId["glm-5.3"].free, true, "零价格即视为免费");
	assert.equal(byId["glm-5.3"].deprecated, true);
});

test("模型 ID 会去掉首尾空白并去重", () => {
	const list = buildModelList(["  kimi-k3  ", "kimi-k3", ""], () => undefined, []);
	assert.equal(list.length, 1);
	assert.equal(list[0].id, "kimi-k3");
});

test("格式化辅助函数", () => {
	assert.equal(formatTokenCount(128000), "128K");
	assert.equal(formatTokenCount(1000000), "1M");
	assert.equal(formatTokenCount(2048000), "2M");
	assert.equal(formatTokenCount(4096), "4.1K");
	assert.equal(formatTokenCount(0), "0");
	assert.equal(formatPrice(0.15), "$0.15");
	assert.equal(formatPrice(undefined), "$0.00");
});

// ─────────────────────────── 运行器 ───────────────────────────

let passes = 0;
let failures = 0;

for (const [name, fn] of tests) {
	try {
		await fn();
		passes++;
		console.log(`  通过 - ${name}`);
	} catch (err) {
		failures++;
		console.error(`  失败 - ${name}`);
		console.error(`    ${err.message}`);
	}
}

console.log(`\n通过 ${passes}，失败 ${failures}`);
process.exitCode = failures > 0 ? 1 : 0;
