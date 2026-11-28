#!/usr/bin/env node
/**
 * Claude Code settings projection: path resolution, env/picker diff, ownership
 * restore (three-way), atomic write with backup, tombstones, and CLI version
 * gating. Pure Node: none of these modules import `vscode`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	buildClaudeEnv,
	buildClaudePicker,
	captureClaudeOwnership,
	planClaudeRestore,
	planClaudeSettingsUpdate,
	readClaudeSettings,
	resolveClaudeSettingsLocationSync,
	sweepClaudeTombstones,
	writeClaudeSettings,
} = require("../out/claudeSettings.js");
const {
	compareVersions,
	parseClaudeVersion,
	supportsBehavesAs,
	supportsModelPicker,
	versionAtLeast,
} = require("../out/claudeCodeCli.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

async function tempDir() {
	return fs.mkdtemp(path.join(os.tmpdir(), "cc-settings-"));
}

test("resolves the settings path: override, CLAUDE_CONFIG_DIR, then ~/.claude", () => {
	const fileOverride = resolveClaudeSettingsLocationSync("D:/portable/claude/settings.json", {}, "/home/u");
	assert.equal(fileOverride.file, path.resolve("D:/portable/claude/settings.json"));

	const dirOverride = resolveClaudeSettingsLocationSync("/opt/cc", {}, "/home/u");
	assert.equal(dirOverride.file, path.join(path.resolve("/opt/cc"), "settings.json"));

	const fromEnv = resolveClaudeSettingsLocationSync("", { CLAUDE_CONFIG_DIR: "/cfg" }, "/home/u");
	assert.equal(fromEnv.file, path.join(path.resolve("/cfg"), "settings.json"));

	const home = resolveClaudeSettingsLocationSync(undefined, {}, path.resolve("/home/u"));
	assert.equal(home.file, path.join(path.resolve("/home/u"), ".claude", "settings.json"));
});

test("builds only the env keys this extension owns", () => {
	const env = buildClaudeEnv({
		baseUrl: "http://127.0.0.1:15722/",
		proxyToken: "derived-token",
		defaultModel: "deepseek-v4.1-flash",
		roleModels: { haiku: "glm-5.3-flash", opus: "  " },
		maxContextTokens: 256000.7,
	});
	assert.deepEqual(env, {
		ANTHROPIC_BASE_URL: "http://127.0.0.1:15722",
		ANTHROPIC_AUTH_TOKEN: "derived-token",
		ANTHROPIC_MODEL: "deepseek-v4.1-flash",
		ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.3-flash",
		CLAUDE_CODE_MAX_CONTEXT_TOKENS: "256000",
		CLAUDE_CODE_AUTO_MODE_SERVER: "0",
	});

	assert.throws(() => buildClaudeEnv({ baseUrl: "", proxyToken: "x" }));
	assert.throws(() => buildClaudeEnv({ baseUrl: "http://x", proxyToken: "  " }));
});

test("picker rows keep 1M markers and only add behavesAs when asked", () => {
	const rows = [
		{ model: "deepseek-v4.1-flash[1m]", label: "DeepSeek V4.1 Flash", description: "OpenCode Go · 1M context" },
		{ model: "hy3", label: "Hy3", description: "OpenCode Go · 256K context" },
	];
	const plain = buildClaudePicker({ rows });
	assert.equal(plain.replaceBuiltInOptions, true);
	assert.deepEqual(plain.options[0], {
		model: "deepseek-v4.1-flash[1m]",
		label: "DeepSeek V4.1 Flash",
		description: "OpenCode Go · 1M context",
	});

	const profiled = buildClaudePicker({
		rows,
		profiles: { "deepseek-v4.1-flash": "claude-opus-4-8" },
		replaceBuiltInOptions: false,
	});
	assert.equal(profiled.replaceBuiltInOptions, false);
	assert.equal(profiled.options[0].behavesAs, "claude-opus-4-8");
	assert.equal(profiled.options[1].behavesAs, undefined);
});

test("update keeps every unowned key and removes ANTHROPIC_API_KEY", () => {
	const current = {
		model: "deepseek-v4-flash[1M]",
		permissions: { additionalDirectories: ["D:/work"] },
		hooks: { Stop: [] },
		env: {
			ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
			ANTHROPIC_AUTH_TOKEN: "sk-third-party",
			ANTHROPIC_API_KEY: "sk-user-custom",
			ENABLE_TOOL_SEARCH: "true",
		},
	};
	const env = {
		ANTHROPIC_BASE_URL: "http://127.0.0.1:15722",
		ANTHROPIC_AUTH_TOKEN: "derived",
	};
	const picker = buildClaudePicker({ rows: [{ model: "glm-5.3", label: "GLM-5.3", description: "x" }] });
	const update = planClaudeSettingsUpdate(current, env, picker);
	assert.equal(update.changed, true);
	assert.equal(update.apiKeyRemoved, true);
	assert.equal(update.pickerChanged, true);
	assert.equal(update.next.model, current.model);
	assert.deepEqual(update.next.permissions, current.permissions);
	assert.deepEqual(update.next.hooks, current.hooks);
	assert.equal(update.next.env.ENABLE_TOOL_SEARCH, "true");
	assert.equal(update.next.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15722");
	assert.equal(update.next.env.ANTHROPIC_AUTH_TOKEN, "derived");
	assert.equal("ANTHROPIC_API_KEY" in update.next.env, false);
	assert.deepEqual(update.next.modelPicker, picker);
	assert.deepEqual(
		update.envChanges.map((change) => change.key).sort(),
		["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
	);
	assert.equal(current.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
});

test("a matching document reports no change", () => {
	const picker = buildClaudePicker({ rows: [{ model: "glm-5.3", label: "GLM-5.3", description: "x" }] });
	const current = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15722" }, modelPicker: picker };
	const update = planClaudeSettingsUpdate(
		current,
		{ ANTHROPIC_BASE_URL: "http://127.0.0.1:15722" },
		picker,
	);
	assert.equal(update.changed, false);
	assert.equal(update.pickerChanged, false);
	assert.deepEqual(update.envChanges, []);
});

test("a non-object env is refused instead of being replaced", () => {
	assert.throws(
		() => planClaudeSettingsUpdate({ env: "oops" }, { ANTHROPIC_BASE_URL: "http://x" }, undefined),
		/env/,
	);
});

test("restore reverts owned keys, tombstones absent ones and leaves user edits", () => {
	const document = {
		env: {
			ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
			ANTHROPIC_BASE_URL_EXTRA: "keep-me",
			ENABLE_TOOL_SEARCH: "true",
		},
		permissions: { allow: ["Bash"] },
	};
	const env = {
		ANTHROPIC_BASE_URL: "http://127.0.0.1:15722",
		ANTHROPIC_AUTH_TOKEN: "derived",
		ANTHROPIC_MODEL: "deepseek-v4.1-flash",
	};
	const picker = buildClaudePicker({ rows: [{ model: "glm-5.3", label: "GLM-5.3", description: "x" }] });
	const update = planClaudeSettingsUpdate(document, env, picker);
	const ownership = captureClaudeOwnership(
		document,
		update,
		"http://127.0.0.1:15722",
		"/home/u/.claude/settings.json",
	);

	// The user edits the model afterwards and adds a new key.
	const edited = JSON.parse(JSON.stringify(update.next));
	edited.env.ANTHROPIC_MODEL = "glm-5.3";
	edited.env.USER_ADDED = "keep";

	const plan = planClaudeRestore(edited, ownership);
	assert.equal(plan.changed, true);
	// Written by us and untouched: restored to the pre-takeover value.
	assert.equal(plan.next.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
	// Written by us and absent before: tombstoned, swept later.
	assert.equal(plan.next.env.ANTHROPIC_AUTH_TOKEN, "");
	assert.ok(plan.tombstones.includes("ANTHROPIC_AUTH_TOKEN"));
	// Edited by the user: untouched and reported.
	assert.equal(plan.next.env.ANTHROPIC_MODEL, "glm-5.3");
	assert.ok(plan.skipped.includes("ANTHROPIC_MODEL"));
	// Untouched keys survive.
	assert.equal(plan.next.env.USER_ADDED, "keep");
	assert.equal(plan.next.env.ENABLE_TOOL_SEARCH, "true");
	assert.deepEqual(plan.next.permissions, { allow: ["Bash"] });
	// Our picker is removed.
	assert.equal("modelPicker" in plan.next, false);
});

test("restore brings back a user picker and an API key it removed", () => {
	const userPicker = { options: [{ model: "opus" }] };
	const document = {
		env: { ANTHROPIC_API_KEY: "sk-user-custom", ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" },
		modelPicker: userPicker,
	};
	const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:15722", ANTHROPIC_AUTH_TOKEN: "derived" };
	const update = planClaudeSettingsUpdate(document, env, buildClaudePicker({ rows: [] }));
	const ownership = captureClaudeOwnership(document, update, "http://x", "/p/settings.json");
	assert.ok("ANTHROPIC_API_KEY" in ownership.env);
	assert.equal(ownership.env.ANTHROPIC_API_KEY.present, true);

	const plan = planClaudeRestore(update.next, ownership);
	assert.equal(plan.next.env.ANTHROPIC_API_KEY, "sk-user-custom");
	assert.equal(plan.next.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
	assert.deepEqual(plan.next.modelPicker, userPicker);
});

test("restore keeps a picker the user replaced", () => {
	const document = { env: {}, modelPicker: { options: [{ model: "opus" }] } };
	const update = planClaudeSettingsUpdate(document, {}, buildClaudePicker({ rows: [] }));
	const ownership = captureClaudeOwnership(document, update, "http://x", "/p/settings.json");
	const edited = JSON.parse(JSON.stringify(update.next));
	edited.modelPicker = { options: [{ model: "haiku" }] };
	const plan = planClaudeRestore(edited, ownership);
	assert.deepEqual(plan.next.modelPicker, { options: [{ model: "haiku" }] });
	assert.ok(plan.skipped.includes("modelPicker"));
});

test("writes atomically with a backup, keeps indentation, and skips identical writes", async () => {
	const dir = await tempDir();
	const location = { dir, file: path.join(dir, "settings.json") };
	const original = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old" }, hooks: {} }, null, 2)}\n`;
	await fs.writeFile(location.file, original, "utf8");

	const read = await readClaudeSettings(location);
	const update = planClaudeSettingsUpdate(
		read.document,
		{ ANTHROPIC_BASE_URL: "http://127.0.0.1:15722", ANTHROPIC_AUTH_TOKEN: "derived" },
		buildClaudePicker({ rows: [] }),
	);
	const result = await writeClaudeSettings(location, update.next, {
		currentText: read.text,
		currentExists: read.exists,
		maxBackups: 3,
	});
	assert.equal(result.changed, true);
	assert.ok(result.backupPath, "a backup must be taken before the first change");
	assert.equal(await fs.readFile(result.backupPath, "utf8"), original);

	const written = await fs.readFile(location.file, "utf8");
	assert.match(written, /\n {2}"env"/, "the two-space indentation must be preserved");
	const parsed = JSON.parse(written);
	assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15722");
	assert.deepEqual(parsed.hooks, {});

	const second = await writeClaudeSettings(location, parsed, {
		currentText: written,
		currentExists: true,
	});
	assert.equal(second.changed, false);

	await fs.rm(dir, { recursive: true, force: true });
});

test("creates the directory and file when nothing exists yet", async () => {
	const dir = await tempDir();
	const nested = path.join(dir, "nested", ".claude");
	const location = { dir: nested, file: path.join(nested, "settings.json") };
	const read = await readClaudeSettings(location);
	assert.equal(read.exists, false);
	assert.deepEqual(read.document, {});
	await writeClaudeSettings(
		location,
		{ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:15722" } },
		{ currentExists: false },
	);
	const parsed = JSON.parse(await fs.readFile(location.file, "utf8"));
	assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:15722");
	await fs.rm(dir, { recursive: true, force: true });
});

test("refuses to touch an unparsable file", async () => {
	const dir = await tempDir();
	const location = { dir, file: path.join(dir, "settings.json") };
	await fs.writeFile(location.file, "{ not json", "utf8");
	await assert.rejects(() => readClaudeSettings(location), /not valid JSON/);
	assert.equal(await fs.readFile(location.file, "utf8"), "{ not json");
	await fs.rm(dir, { recursive: true, force: true });
});

test("sweeps only tombstoned keys that still hold an empty string", async () => {
	const dir = await tempDir();
	const location = { dir, file: path.join(dir, "settings.json") };
	await fs.writeFile(
		location.file,
		JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "", KEEP: "1", OTHER: "" } }),
		"utf8",
	);
	const removed = await sweepClaudeTombstones(location, ["ANTHROPIC_AUTH_TOKEN", "OTHER", "MISSING"]);
	assert.deepEqual(removed.sort(), ["ANTHROPIC_AUTH_TOKEN", "OTHER"].sort());
	const parsed = JSON.parse(await fs.readFile(location.file, "utf8"));
	assert.deepEqual(parsed.env, { KEEP: "1" });

	// A value written back in the meantime is left alone.
	await fs.writeFile(location.file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "real" } }), "utf8");
	assert.deepEqual(await sweepClaudeTombstones(location, ["ANTHROPIC_AUTH_TOKEN"]), []);
	assert.equal(JSON.parse(await fs.readFile(location.file, "utf8")).env.ANTHROPIC_AUTH_TOKEN, "real");
	await fs.rm(dir, { recursive: true, force: true });
});

test("parses and compares Claude Code versions", () => {
	assert.equal(parseClaudeVersion("2.1.318 (Claude Code)"), "2.1.318");
	assert.equal(parseClaudeVersion("1.0.44"), "1.0.44");
	assert.equal(parseClaudeVersion("no version here"), undefined);
	assert.equal(compareVersions("2.1.318", "2.1.242"), 1);
	assert.equal(compareVersions("2.1.242", "2.1.242"), 0);
	assert.equal(compareVersions("2.1.24", "2.1.242"), -1);
	assert.equal(compareVersions("2.2", "2.1.9"), 1);
	assert.equal(versionAtLeast(undefined, "2.1.242"), false);
	assert.equal(supportsModelPicker("2.1.241"), false);
	assert.equal(supportsModelPicker("2.1.242"), true);
	assert.equal(supportsBehavesAs("2.1.256"), false);
	assert.equal(supportsBehavesAs("2.1.257"), true);
});

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}`);
		console.error(error);
	}
}
console.log(
	failed === 0
		? `\n${tests.length} Claude Code settings tests passed.`
		: `\n${failed} Claude Code settings test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
