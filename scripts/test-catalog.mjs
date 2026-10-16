#!/usr/bin/env node
/**
 * Codex 模型目录构建器（out/catalog.js）的单元测试。该模块刻意不依赖
 * `vscode`，因此可以直接在纯 Node 下运行。
 *
 * 运行方式：npm test
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const catalog = require("../out/catalog.js");
const codexCli = require("../out/codexCli.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

/** 代替 `codex debug models` 真实条目的测试样本（只保留关键字段）。 */
function templateEntry() {
	return {
		slug: "gpt-5-codex",
		display_name: "GPT-5 Codex",
		description: "built-in template model",
		shell_type: "shell_command",
		visibility: "list",
		supported_in_api: true,
		supported_reasoning_levels: [
			{ effort: "minimal", description: "minimal effort" },
			{ effort: "low", description: "low effort" },
			{ effort: "medium", description: "medium effort" },
			{ effort: "high", description: "high effort" },
		],
		default_reasoning_level: "medium",
		priority: 7,
		context_window: 272000,
		max_context_window: 272000,
		supports_image_detail_original: true,
		base_instructions: "You are Codex.",
		truncation_policy: { mode: "tokens", limit: 10000 },
		experimental_supported_tools: [],
	};
}

// ─────────────────────────── 目录构建器 ───────────────────────────

test("能区分不同平台的 Codex 二进制（扩展会把所有平台都带上）", () => {
	const linux = "C:\\ext\\openai.chatgpt-1.0\\bin\\linux-x86_64\\codex";
	const windows = "C:\\ext\\openai.chatgpt-1.0\\bin\\windows-x86_64\\codex.exe";
	const mac = "C:\\ext\\openai.chatgpt-1.0\\bin\\darwin-x86_64\\codex";
	// 在 Windows 上选中 Linux ELF，正是 `codex debug models` 失败的原因。
	assert.equal(codexCli.isPlatformCodexBinary(windows, "win32"), true);
	assert.equal(codexCli.isPlatformCodexBinary(linux, "win32"), false);
	assert.equal(codexCli.isPlatformCodexBinary(mac, "win32"), false);
	assert.equal(codexCli.isPlatformCodexBinary(linux, "linux"), true);
	assert.equal(codexCli.isPlatformCodexBinary(windows, "linux"), false);
	// 恰好放在同一目录树里的辅助二进制绝不会成为候选。
	assert.equal(codexCli.isPlatformCodexBinary("C:\\ext\\bin\\linux-x86_64\\codex-path\\rg", "linux"), false);
	assert.equal(codexCli.isPlatformCodexBinary("C:\\ext\\bin\\linux-x86_64\\codex-code-mode-host", "linux"), false);
	assert.deepEqual(codexCli.executableNamesFor("win32"), ["codex.exe", "codex.cmd"]);
	assert.deepEqual(codexCli.executableNamesFor("linux"), ["codex"]);
});

test("buildCatalogEntries 克隆模板并覆盖模型相关字段", () => {
	const template = templateEntry();
	const entries = catalog.buildCatalogEntries(
		[
			{
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				description: "fast and cheap",
				contextLength: 128000,
				vision: false,
				efforts: ["low", "high"],
			},
			{ id: "grok-4.7", name: "Grok 4.7", vision: true },
		],
		template,
	);

	assert.equal(entries.length, 2);
	assert.equal(template.slug, "gpt-5-codex", "模板本身绝不会被改动");

	const first = entries[0];
	assert.equal(first.slug, "deepseek-v4-flash");
	assert.equal(first.display_name, "DeepSeek V4 Flash");
	assert.equal(first.description, "fast and cheap");
	assert.equal(first.priority, 1);
	assert.equal(first.visibility, "list");
	assert.equal(first.supported_in_api, true);
	assert.deepEqual(first.input_modalities, ["text"]);
	assert.equal(first.supports_image_detail_original, false, "vision:false 会翻转该标志");
	assert.equal(first.context_window, 128000);
	assert.equal(first.max_context_window, 128000);
	assert.deepEqual(first.supported_reasoning_levels.map((level) => level.effort), ["low", "high"]);
	assert.equal(first.default_reasoning_level, "low", "模板默认值不在列表中 → 取第一档");
	assert.equal(first.base_instructions, "You are Codex.", "模板里的未知字段会随克隆保留");
	assert.equal(first.shell_type, "shell_command");

	const second = entries[1];
	assert.equal(second.priority, 2);
	assert.deepEqual(second.input_modalities, ["text", "image"]);
	assert.equal(second.description, "Grok 4.7 (OpenCode Go)", "缺少描述时使用兜底文案");
	assert.equal(second.context_window, 272000, "没有 contextLength → 保留模板值");
	assert.equal(second.supports_image_detail_original, true, "vision:true 不改动该标志");
	assert.deepEqual(second.supported_reasoning_levels.map((level) => level.effort), [
		"minimal",
		"low",
		"medium",
		"high",
	]);
	assert.equal(second.default_reasoning_level, "medium");
});

test("resolveReasoningLevels 只保留 Codex 接受的推理强度，并按固定顺序排列", () => {
	const template = templateEntry();
	const levels = catalog.resolveReasoningLevels(
		{ id: "m", name: "M", efforts: ["high", "bogus", "ultra", "low"] },
		template,
	);
	assert.deepEqual(levels.map((level) => level.effort), ["low", "high", "ultra"]);
	assert.equal(levels[0].description, "low effort", "模板里有描述时优先使用");
	assert.ok(levels[2].description.length > 0, "模板没有的强度也会有描述");
});

test("剥离第一方传输字段，让工具保留在顶层 tools 数组里", () => {
	const template = {
		...templateEntry(),
		use_responses_lite: true,
		tool_mode: "code_mode_only",
		multi_agent_version: "v2",
		multi_agent_reasoning_effort: "xhigh",
		node_repl_auto_review_required: true,
		node_repl_disabled: false,
		experimental_supported_tools: ["send_user_message_async", "clock"],
	};
	const [entry] = catalog.buildCatalogEntries(
		[{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
		template,
	);

	// `use_responses_lite: true` 会把工具搬进 OpenCode Go 会忽略的
	// `additional_tools` 输入项，模型因此一个工具都看不到，只能用纯文本回答。
	assert.equal(entry.use_responses_lite, false);
	// 代码模式会把真实工具换成单个自由格式的 JS `exec` 工具。
	assert.equal("tool_mode" in entry, false);
	assert.deepEqual(entry.experimental_supported_tools, []);
	assert.equal("multi_agent_version" in entry, false);
	assert.equal("multi_agent_reasoning_effort" in entry, false);
	assert.equal("node_repl_auto_review_required" in entry, false);
	assert.equal("node_repl_disabled" in entry, false);
	assert.equal(entry.base_instructions, "You are Codex.", "其余内容不受归一化影响");
	assert.equal(template.use_responses_lite, true, "模板本身绝不会被改动");

	// 没有这些字段的旧版 Codex 模板保持原样。
	const legacy = templateEntry();
	const [legacyEntry] = catalog.buildCatalogEntries([{ id: "m", name: "M" }], legacy);
	assert.equal("use_responses_lite" in legacyEntry, false);
	assert.equal("experimental_supported_tools" in legacyEntry, true, "已有的空列表会保留");
});

test("selectCatalogTemplate 优先选择带 instructions 的经典传输条目", () => {
	const codeMode = {
		slug: "gpt-6-astra",
		use_responses_lite: true,
		tool_mode: "code_mode_only",
		model_messages: { instructions_template: "first-party prompt" },
	};
	const classic = {
		slug: "gpt-5.5",
		use_responses_lite: false,
		model_messages: { instructions_template: "classic prompt" },
	};
	const noInstructions = { slug: "helper", shell_type: "unified_exec" };

	assert.equal(codexCli.selectCatalogTemplate([codeMode, classic]).slug, "gpt-5.5");
	assert.equal(
		codexCli.selectCatalogTemplate([codeMode, noInstructions]).slug,
		"gpt-6-astra",
		"代码模式条目仍然优先于没有 instructions 的条目",
	);
	assert.equal(
		codexCli.selectCatalogTemplate([noInstructions, classic]).slug,
		"gpt-5.5",
		"没有 instructions 的条目只是兜底",
	);
	assert.equal(codexCli.selectCatalogTemplate([]), undefined);

	const picked = codexCli.selectCatalogTemplate([classic]);
	picked.slug = "mutated";
	assert.equal(classic.slug, "gpt-5.5", "返回的是条目的副本");
});

test("serializeCatalog 输出 { models: [...] }，无 BOM 且末尾有换行", () => {
	const text = catalog.serializeCatalog([{ slug: "m", display_name: "M" }]);
	assert.ok(!text.startsWith("\uFEFF"), "不带 BOM（Codex 会拒绝带 BOM 的文件）");
	assert.ok(text.startsWith('{\n  "models": ['));
	assert.ok(text.endsWith("\n"));
	assert.equal(JSON.parse(text).models[0].slug, "m");
});

test("目录文件辅助函数：写入、空操作、读取、还原、删除", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexgo-cat-"));
	try {
		const file = path.join(home, "opencode-go-models.json");
		assert.equal(await catalog.readCatalogFile(file), undefined, "文件不存在时读出 undefined");
		assert.equal(await catalog.writeCatalogFile(file, "one\n"), true);
		assert.equal(await catalog.writeCatalogFile(file, "one\n"), false, "内容相同即为空操作");

		const bytes = await fs.readFile(file);
		assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), "写入时不带 BOM");
		assert.equal(await catalog.readCatalogFile(file), "one\n");

		await catalog.restoreCatalogFile(file, "two\n");
		assert.equal(await catalog.readCatalogFile(file), "two\n");
		await catalog.restoreCatalogFile(file, undefined);
		assert.equal(await catalog.readCatalogFile(file), undefined, "还原为 undefined 会删除文件");

		assert.equal(await catalog.removeCatalogFile(file), false, "删除不存在的文件不算错误");
		await catalog.restoreCatalogFile(file, "three\n");
		assert.equal(await catalog.removeCatalogFile(file), true);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
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
