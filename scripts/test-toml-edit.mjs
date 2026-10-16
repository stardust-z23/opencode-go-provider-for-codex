#!/usr/bin/env node
/**
 * 纯函数 TOML 编辑器（out/tomlEdit.js）与文件层（out/codexConfigFile.js）
 * 的单元测试。两个模块都刻意不依赖 `vscode`，因此可直接在纯 Node 下运行。
 *
 * 运行方式：npm test
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const toml = require("../out/tomlEdit.js");
const files = require("../out/codexConfigFile.js");

/** 一个典型的选择。Codex 0.162 移除了 `chat`，因此只用 responses。 */
const baseSelection = {
	modelId: "deepseek-v4.1-flash",
	wireApi: "responses",
	envKey: "OPENCODE_GO_API_KEY",
};

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

// ─────────────────────────── 纯编辑器 ───────────────────────────

test("全新文件：生成规范结构", () => {
	const out = toml.editConfigText("", baseSelection);
	assert.match(out, /^model = "deepseek-v4\.1-flash"$/m);
	assert.match(out, /^model_provider = "opencode-go"$/m);
	assert.match(out, /^\[model_providers\.opencode-go\]$/m);
	assert.match(out, /^name = "OpenCode Go"$/m);
	assert.match(out, /^base_url = "https:\/\/opencode\.ai\/inference\/go\/v1"$/m);
	assert.match(out, /^env_key = "OPENCODE_GO_API_KEY"$/m);
	assert.match(out, /^wire_api = "responses"$/m);
	assert.ok(out.endsWith("\n"), "文件应以换行结尾");
});

test("往返一致：extractTopLevelValue 能读回写入的内容", () => {
	const out = toml.editConfigText("", baseSelection);
	assert.equal(toml.extractTopLevelValue(out, "model"), "deepseek-v4.1-flash");
	assert.equal(toml.extractTopLevelValue(out, "model_provider"), "opencode-go");
	assert.equal(toml.extractTopLevelValue(out, "model_reasoning_effort"), undefined);
});

test("无关内容、注释与 profile 都会保留", () => {
	const input = [
		"# my settings",
		'approval_policy = "on-request"',
		'model = "gpt-5"   # keep note',
		"",
		"[tui]",
		'theme = "dark"',
		"",
		"[profiles.work]",
		'model = "gpt-5-codex"',
		"",
	].join("\n");
	const out = toml.editConfigText(input, baseSelection);
	assert.ok(out.includes("# my settings"));
	assert.ok(out.includes('approval_policy = "on-request"'));
	assert.ok(out.includes('model = "deepseek-v4.1-flash" # keep note'), "行尾注释保留");
	assert.ok(out.includes('model = "gpt-5-codex"'), "profile 里的 model 不受影响");
	assert.ok(out.includes('theme = "dark"'));
	assert.match(out, /^model_provider = "opencode-go"$/m);
});

test("幂等：应用两次结果完全一致", () => {
	const input = ['model = "gpt-5"', "", "[tui]", 'theme = "dark"', ""].join("\n");
	const once = toml.editConfigText(input, baseSelection);
	const twice = toml.editConfigText(once, baseSelection);
	assert.equal(twice, once);
});

test("单引号字符串值可以被替换和读取", () => {
	const out = toml.editConfigText("model = 'gpt-5'\n", baseSelection);
	assert.ok(out.includes('model = "deepseek-v4.1-flash"'));
	assert.equal(toml.extractTopLevelValue("model = 'gpt-5'", "model"), "gpt-5");
});

test("推理强度：设置、删除（null）、保持不变（undefined）", () => {
	const withEffort = toml.editConfigText("", { ...baseSelection, reasoningEffort: "high" });
	assert.match(withEffort, /^model_reasoning_effort = "high"$/m);

	const removed = toml.editConfigText(withEffort, { ...baseSelection, reasoningEffort: null });
	assert.ok(!removed.includes("model_reasoning_effort"));

	const untouched = toml.editConfigText(withEffort, baseSelection);
	assert.match(untouched, /^model_reasoning_effort = "high"$/m);
});

test("已存在的 provider 区块：更新已知键，保留额外键与注释", () => {
	const input = [
		'model = "x"',
		'model_provider = "opencode-go"',
		"",
		"[model_providers.opencode-go]",
		'name = "Custom name"   # user comment',
		'base_url = "https://old.example.com/v1"',
		'env_key = "OLD_KEY"',
		'wire_api = "chat"',
		"request_max_retries = 7",
		"",
	].join("\n");
	const out = toml.editConfigText(input, baseSelection);
	assert.ok(out.includes('name = "OpenCode Go" # user comment'));
	assert.ok(out.includes('base_url = "https://opencode.ai/inference/go/v1"'));
	assert.ok(out.includes('env_key = "OPENCODE_GO_API_KEY"'));
	assert.ok(out.includes('wire_api = "responses"'), "旧的 chat wire_api 升级为 responses");
	assert.ok(!out.includes('wire_api = "chat"'), "chat wire_api 绝不能残留");
	assert.ok(out.includes("request_max_retries = 7"), "未知的 provider 键保留");
	assert.equal((out.match(/env_key =/g) ?? []).length, 1, "不会产生重复的区块 / 键");
});

test("CRLF 换行符会被保留", () => {
	const input = 'model = "gpt-5"\r\n\r\n[tui]\r\ntheme = "dark"\r\n';
	const out = toml.editConfigText(input, baseSelection);
	assert.ok(out.includes("\r\n"));
	assert.ok(!out.replace(/\r\n/g, "").includes("\n"), "没有引入裸 LF");
	assert.ok(out.includes('model = "deepseek-v4.1-flash"'));
});

test("带引号的表头会被就地匹配（不产生重复区块）", () => {
	const input = ['model = "x"', "", '[model_providers."opencode-go"]', 'wire_api = "chat"', ""].join("\n");
	const out = toml.editConfigText(input, baseSelection);
	assert.equal((out.match(/env_key =/g) ?? []).length, 1);
	assert.equal((out.match(/\[model_providers/g) ?? []).length, 1);
	assert.ok(out.includes('[model_providers."opencode-go"]'), "保留原有表头写法");
});

test("缺失的键插入到区块正文中，位于后续表之前", () => {
	const input = [
		"[model_providers.opencode-go]",
		'wire_api = "chat"',
		"",
		"[other]",
		"a = 1",
		"",
	].join("\n");
	const out = toml.editConfigText(input, baseSelection);
	assert.match(out, /wire_api = "responses"\nname = "OpenCode Go"[\s\S]*\n\n\[other\]/);
	assert.ok(out.includes("[other]"));
	assert.ok(out.includes("a = 1"));
});

test("区块内的键对顶层提取不可见", () => {
	assert.equal(toml.extractTopLevelValue('[profiles.x]\nmodel = "y"\n', "model"), undefined);
});

test("非法的选择在触碰任何文件之前就会抛错", () => {
	assert.throws(() => toml.editConfigText("", { ...baseSelection, modelId: "   " }));
	assert.throws(() => toml.editConfigText("", { ...baseSelection, wireApi: "anthropic" }));
});

test("旧版本遗留的 provider 表会被移除", () => {
	const input = [
		'model = "x"',
		"",
		"[model_providers.opencode-go-responses]",
		'wire_api = "responses"',
		"",
		"[model_providers.opencode-go-chat]",
		'wire_api = "chat"',
		"",
		"[windows]",
		'sandbox = "elevated"',
		"",
	].join("\n");
	const out = toml.editConfigText(input, baseSelection);
	assert.ok(!out.includes("[model_providers.opencode-go-responses]"), "旧的 responses 表已删除");
	assert.ok(!out.includes("[model_providers.opencode-go-chat]"), "旧的 chat 表已删除");
	assert.ok(!out.includes('wire_api = "chat"'));
	assert.ok(out.includes("[windows]"), "无关的表保留");
	assert.match(out, /^\[model_providers\.opencode-go\]$/m);
});

test("目录文件名通过顶层键写入（也可删除）", () => {
	const withCatalog = toml.editConfigText("", { ...baseSelection, catalogFileName: "opencode-go-models.json" });
	assert.match(withCatalog, /^model_catalog_json = "opencode-go-models\.json"$/m);

	const untouched = toml.editConfigText(withCatalog, baseSelection);
	assert.ok(untouched.includes("model_catalog_json"), "undefined 时该键保持原样");

	const removed = toml.editConfigText(withCatalog, { ...baseSelection, catalogFileName: null });
	assert.ok(!removed.includes("model_catalog_json"));
});

test("editProviderConfigText 只更新 provider，不触碰顶层模型选择", () => {
	const input = [
		'model = "gpt-5"',
		'model_provider = "openai"',
		"",
		"[model_providers.opencode-go]",
		'name = "OpenCode Go"',
		'base_url = "https://opencode.ai/inference/go/v1"',
		'env_key = "OPENCODE_GO_API_KEY"',
		'wire_api = "responses"',
		"",
	].join("\n");
	const out = toml.editProviderConfigText(input, {
		baseUrl: "http://127.0.0.1:15722/v1",
		envKey: "OPENCODE_GO_API_KEY",
	});
	assert.match(out, /^model = "gpt-5"$/m);
	assert.match(out, /^model_provider = "openai"$/m);
	assert.ok(out.includes('base_url = "http://127.0.0.1:15722/v1"'));
	assert.ok(out.includes('wire_api = "responses"'));
});

// ─────────────────────────── 文件层 ───────────────────────────

test("文件层：创建文件与目录；只在真正变化时补备份", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexgo-"));
	try {
		const location = { home, configPath: path.join(home, "config.toml") };

		const first = await files.applyModelSelection(baseSelection, { location, maxBackups: 5 });
		assert.equal(first.created, true);
		assert.equal(first.changed, true);
		assert.equal(first.backupPath, undefined, "全新文件不产生备份");

		const again = await files.applyModelSelection(baseSelection, { location, maxBackups: 5 });
		assert.equal(again.changed, false, "选择相同即空操作");

		const second = await files.applyModelSelection(
			{ ...baseSelection, modelId: "kimi-k3" },
			{ location, maxBackups: 5 },
		);
		assert.equal(second.changed, true);
		assert.ok(second.backupPath && second.backupPath.includes(".bak-"), "已创建备份");
		const backupText = await fs.readFile(second.backupPath, "utf8");
		assert.ok(backupText.includes('model = "deepseek-v4.1-flash"'), "备份里是改动前的内容");

		const current = await files.readCurrentSelection(location);
		assert.equal(current.modelId, "kimi-k3");
		assert.equal(current.providerId, "opencode-go");
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
});

test("文件层：嵌套的配置目录按需创建", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexgo-"));
	try {
		const nested = path.join(home, "nested", "codex");
		const location = { home: nested, configPath: path.join(nested, "config.toml") };
		const result = await files.applyModelSelection(baseSelection, { location });
		assert.equal(result.created, true);
		const text = await fs.readFile(location.configPath, "utf8");
		assert.ok(text.includes('model = "deepseek-v4.1-flash"'));
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
});

test("文件层：备份清理只保留最新的 maxBackups 个文件", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexgo-"));
	try {
		const location = { home, configPath: path.join(home, "config.toml") };
		for (const modelId of ["a", "b", "c", "d", "e"]) {
			await files.applyModelSelection({ ...baseSelection, modelId }, { location, maxBackups: 2 });
		}
		const entries = await fs.readdir(home);
		const backups = entries.filter((name) => name.startsWith("config.toml.bak-"));
		assert.equal(backups.length, 2);
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
});

test("文件层：位置解析顺序 override → CODEX_HOME → ~/.codex", () => {
	const custom = files.resolveCodexConfigLocationSync("/tmp/custom-codex");
	assert.equal(custom.configPath, path.join("/tmp/custom-codex", "config.toml"));

	const previous = process.env.CODEX_HOME;
	process.env.CODEX_HOME = "/tmp/env-codex";
	try {
		assert.equal(
			files.resolveCodexConfigLocationSync().configPath,
			path.join("/tmp/env-codex", "config.toml"),
		);
		assert.equal(
			files.resolveCodexConfigLocationSync("   ").configPath,
			path.join("/tmp/env-codex", "config.toml"),
			"空白 override 会继续落到 CODEX_HOME",
		);
	} finally {
		if (previous === undefined) {
			delete process.env.CODEX_HOME;
		} else {
			process.env.CODEX_HOME = previous;
		}
	}
});

test("文件层：配置文件缺失时读出空选择", async () => {
	const missing = await files.readCurrentSelection({
		home: os.tmpdir(),
		configPath: path.join(os.tmpdir(), "definitely-missing-codexgo", "config.toml"),
	});
	assert.equal(missing.modelId, undefined);
	assert.equal(missing.providerId, undefined);
});

// ─────────────────────────── 删除 API ───────────────────────────

test("removeTopLevelKey 只删除顶层那一处", () => {
	const input = [
		"disable_response_storage = true",
		'model_catalog_json = "cc-switch-model-catalog.json"',
		"",
		"[profiles.a]",
		'model_catalog_json = "keep-me"',
		"",
	].join("\n");
	const out = toml.removeTopLevelKey(input, "model_catalog_json");
	assert.ok(!out.includes("cc-switch-model-catalog.json"));
	assert.ok(out.includes('model_catalog_json = "keep-me"'), "区块内的同名键不受影响");
	assert.ok(out.includes("disable_response_storage"));
});

test("removeTopLevelKey 遇到不存在的键时原样返回", () => {
	const input = 'model = "x"\n';
	assert.equal(toml.removeTopLevelKey(input, "model_catalog_json"), input);
});

test("removeTable 删除整个区块直到下一个表头", () => {
	const input = [
		'model = "x"',
		"",
		"[model_providers.custom]",
		'name = "opencode_go"',
		'base_url = "http://127.0.0.1:15721/v1"',
		"requires_openai_auth = true",
		"",
		"[windows]",
		'sandbox = "elevated"',
		"",
	].join("\n");
	const out = toml.removeTable(input, "model_providers.custom");
	assert.ok(!out.includes("[model_providers.custom]"));
	assert.ok(!out.includes("requires_openai_auth"));
	assert.ok(out.includes("[windows]"));
	assert.ok(out.includes('sandbox = "elevated"'));
	assert.ok(!out.includes("\n\n\n"), "接缝处不会留下多余空行");
});

test("removeTable 遇到不存在的区块时原样返回", () => {
	const input = "[a]\nx = 1\n";
	assert.equal(toml.removeTable(input, "b"), input);
});

test("removeTable 删除最后一个区块时一并去掉末尾空行", () => {
	const input = ["[a]", "x = 1", "", "[b]", "y = 2", ""].join("\n");
	const out = toml.removeTable(input, "b");
	assert.equal(out, "[a]\nx = 1\n");
});

test("清理场景：cc-switch 残留被删除，其余内容全部保留", () => {
	const input = [
		'model_provider = "opencode-go"',
		'model = "cat-jam-free"',
		'model_reasoning_effort = "high"',
		"disable_response_storage = true",
		'model_catalog_json = "cc-switch-model-catalog.json"',
		"",
		"[model_providers.custom]",
		'name = "opencode_go"',
		'base_url = "http://127.0.0.1:15721/v1"',
		'wire_api = "responses"',
		"requires_openai_auth = true",
		'experimental_bearer_token = "secret"',
		"",
		"[windows]",
		'sandbox = "elevated"',
		"",
		"[projects.'d:\\hallo']",
		'trust_level = "trusted"',
		"",
		"[model_providers.opencode-go]",
		'name = "OpenCode Go"',
		'base_url = "https://opencode.ai/inference/go/v1"',
		'env_key = "OPENCODE_GO_API_KEY"',
		'wire_api = "chat"',
		"",
	].join("\n");
	let out = toml.removeTable(input, "model_providers.custom");
	out = toml.removeTopLevelKey(out, "model_catalog_json");
	assert.equal(
		out,
		[
			'model_provider = "opencode-go"',
			'model = "cat-jam-free"',
			'model_reasoning_effort = "high"',
			"disable_response_storage = true",
			"",
			"[windows]",
			'sandbox = "elevated"',
			"",
			"[projects.'d:\\hallo']",
			'trust_level = "trusted"',
			"",
			"[model_providers.opencode-go]",
			'name = "OpenCode Go"',
			'base_url = "https://opencode.ai/inference/go/v1"',
			'env_key = "OPENCODE_GO_API_KEY"',
			'wire_api = "chat"',
			"",
		].join("\n"),
	);
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
