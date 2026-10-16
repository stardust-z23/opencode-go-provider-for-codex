#!/usr/bin/env node
/**
 * OpenCode Go 额度解析与格式化（out/goUsage.js）的单元测试。
 *
 * goUsage 自身不依赖 `vscode`，但它引用了 logger，而 logger 会 `require("vscode")`，
 * 因此这里先给 `vscode` 装一个空桩再加载被测模块（纯解析函数不会碰到它）。
 *
 * 运行方式：npm test
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "vscode") {
		return {};
	}
	return originalLoad.call(this, request, ...rest);
};
const goUsage = require("../out/goUsage.js");
Module._load = originalLoad;

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

test("usageUrl 拼接端点并去掉多余斜杠", () => {
	assert.equal(goUsage.usageUrl("https://opencode.ai/inference/go/v1"), "https://opencode.ai/inference/go/v1/usage");
	assert.equal(goUsage.usageUrl("https://opencode.ai/zen/go/v1/"), "https://opencode.ai/zen/go/v1/usage");
	assert.equal(goUsage.usageUrl("https://example.com//"), "https://example.com/usage");
});

test("解析真实响应结构：{ usage: { rolling, weekly, monthly } }", () => {
	const usage = goUsage.parseGoUsagePayload({
		usage: {
			rolling: { status: "ok", percent: 0, resetsAt: "2026-10-15T07:23:47.000Z" },
			weekly: { status: "ok", percent: 5, resetsAt: "2026-10-19T00:00:00.000Z" },
			monthly: { status: "ok", percent: 11, resetsAt: "2026-11-02T21:46:53.000Z" },
		},
	});
	assert.equal(usage.rolling.percent, 0);
	assert.equal(usage.weekly.percent, 5);
	assert.equal(usage.monthly.percent, 11);
	assert.equal(usage.rolling.resetsAt, "2026-10-15T07:23:47.000Z");
	assert.equal(usage.useBalance, undefined);
});

test("兼容 windows 包裹、平铺字段与 5h/7d/30d 别名", () => {
	const wrapped = goUsage.parseGoUsagePayload({ windows: { rolling: { percent: 42 } } });
	assert.equal(wrapped.rolling.percent, 42);

	const flat = goUsage.parseGoUsagePayload({ rolling: { percent: 1 }, weekly: { percent: 2 } });
	assert.equal(flat.rolling.percent, 1);
	assert.equal(flat.weekly.percent, 2);

	const aliased = goUsage.parseGoUsagePayload({ "5h": { percent: 7 }, "7d": { percent: 8 }, "30d": { percent: 9 } });
	assert.equal(aliased.rolling.percent, 7);
	assert.equal(aliased.weekly.percent, 8);
	assert.equal(aliased.monthly.percent, 9);

	assert.equal(goUsage.parseGoUsagePayload({ useBalance: true }).useBalance, true);
});

test("窗口解析宽容：字段别名、取值夹紧、垃圾数据忽略", () => {
	assert.equal(goUsage.parseUsageWindow({ usagePercent: 30 }).percent, 30);
	assert.equal(goUsage.parseUsageWindow({ usage_percent: "12.5" }).percent, 12.5);
	assert.equal(goUsage.parseUsageWindow({ percent: 150 }).percent, 100);
	assert.equal(goUsage.parseUsageWindow({ percent: -1 }), undefined);
	assert.equal(goUsage.parseUsageWindow({ percent: "abc" }), undefined);
	assert.equal(goUsage.parseUsageWindow(null), undefined);
	assert.equal(goUsage.parseUsageWindow("nonsense"), undefined);
	assert.equal(goUsage.parseGoUsagePayload({}).rolling, undefined, "缺失窗口解析为 undefined");
});

test("重置时间：ISO 字符串与剩余秒数两种写法都能解析", () => {
	const iso = goUsage.parseUsageWindow({ percent: 1, resetsAt: "2026-10-19T00:00:00.000Z" });
	assert.equal(iso.resetsAt, "2026-10-19T00:00:00.000Z");

	const before = Date.now();
	const seconds = goUsage.parseUsageWindow({ percent: 1, reset_in_sec: 3600 });
	const parsed = Date.parse(seconds.resetsAt);
	assert.ok(parsed >= before + 3_500_000 && parsed <= Date.now() + 3_600_000 + 1_000, "按当前时间推算重置时刻");

	assert.equal(goUsage.parseUsageWindow({ percent: 1, resetsAt: "not-a-date" }).resetsAt, undefined);
	assert.equal(goUsage.parseUsageWindow({ percent: 1, reset_in_sec: 0 }).resetsAt, undefined);
});

test("formatResetDuration / formatDuration 输出紧凑倒计时", () => {
	const now = Date.parse("2026-10-15T00:00:00.000Z");
	assert.equal(goUsage.formatResetDuration("2026-10-15T02:13:00.000Z", now), "2h 13m");
	assert.equal(goUsage.formatResetDuration("2026-10-18T12:00:00.000Z", now), "3d 12h");
	assert.equal(goUsage.formatResetDuration("2026-10-15T00:45:00.000Z", now), "45m");
	assert.equal(goUsage.formatResetDuration("2026-10-15T00:00:30.000Z", now), "0m");
	assert.equal(goUsage.formatResetDuration("2026-10-14T23:00:00.000Z", now), "0m", "已过期显示 0m");
	assert.equal(goUsage.formatResetDuration("nonsense", now), "");
	assert.equal(goUsage.formatDuration(-5), "0m");
});

test("formatProgressBar 按百分比生成 20 格进度条", () => {
	assert.equal(goUsage.formatProgressBar(0), "░".repeat(20));
	assert.equal(goUsage.formatProgressBar(50), "█".repeat(10) + "░".repeat(10));
	assert.equal(goUsage.formatProgressBar(100), "█".repeat(20));
	assert.equal(goUsage.formatProgressBar(150), "█".repeat(20), "超过 100 也夹紧");
	assert.equal(goUsage.formatProgressBar(-1), "░".repeat(20));
});

test("formatUsageSummary 按 5h / 7d / 30d 顺序拼接，缺失窗口跳过", () => {
	assert.equal(
		goUsage.formatUsageSummary({
			rolling: { percent: 65.4 },
			weekly: { percent: 30 },
			monthly: { percent: 12 },
		}),
		"5h: 65% · 7d: 30% · 30d: 12%",
	);
	assert.equal(goUsage.formatUsageSummary({ weekly: { percent: 30 } }), "7d: 30%");
	assert.equal(goUsage.formatUsageSummary({}), "");
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
