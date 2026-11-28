#!/usr/bin/env node
/**
 * Claude Code model routing: `[1m]` markers, Claude aliases, unknown ids and
 * picker row generation. Runs against the compiled pure module, no `vscode`.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	buildMessagesPickerRows,
	claudeRoleForModel,
	looksLikeClaudeModel,
	messagesContextFloor,
	normalizeClaudeModelId,
	resolveMessagesModel,
	stripOneMillionMarker,
} = require("../out/modelRouting.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

const KNOWN = [
	"deepseek-v4.1-flash",
	"glm-5.3",
	"claude-haiku-5-5",
	"minimax-m3",
	"hy3",
];
const ROLES = {
	default: "deepseek-v4.1-flash",
	opus: "deepseek-v4-pro",
	sonnet: "glm-5.3",
	haiku: "glm-5.3-flash",
	fable: "glm-5.3",
	subagent: "minimax-m3",
};

test("stripOneMillionMarker handles both casings and padding", () => {
	assert.deepEqual(stripOneMillionMarker("deepseek-v4.1-flash[1m]"), {
		id: "deepseek-v4.1-flash",
		stripped: true,
	});
	assert.deepEqual(stripOneMillionMarker("glm-5.3 [1M] "), {
		id: "glm-5.3",
		stripped: true,
	});
	assert.deepEqual(stripOneMillionMarker("glm-5.3[1 m]"), {
		id: "glm-5.3",
		stripped: true,
	});
	assert.deepEqual(stripOneMillionMarker("  glm-5.3  "), {
		id: "glm-5.3",
		stripped: false,
	});
});

test("claudeRoleForModel recognises aliases and provider-format ids", () => {
	assert.equal(claudeRoleForModel("opus"), "opus");
	assert.equal(claudeRoleForModel("sonnet[1m]".replace("[1m]", "")), "sonnet");
	assert.equal(claudeRoleForModel("claude-opus-4-8"), "opus");
	assert.equal(claudeRoleForModel("anthropic/claude-sonnet-5-5"), "sonnet");
	assert.equal(claudeRoleForModel("us.anthropic.claude-3-5-haiku-v1:0"), "haiku");
	assert.equal(claudeRoleForModel("claude-fable-5"), "fable");
	assert.equal(claudeRoleForModel("best"), "opus");
	assert.equal(claudeRoleForModel("default"), "default");
	assert.equal(claudeRoleForModel("opusplan"), "default");
	assert.equal(claudeRoleForModel("deepseek-v4.1-flash"), undefined);
	assert.equal(looksLikeClaudeModel("claude-haiku-5-5"), true);
	assert.equal(looksLikeClaudeModel("gpt-6-luna"), false);
});

test("a known OpenCode model wins over the Claude role heuristics", () => {
	const decision = resolveMessagesModel({
		requestedModelId: "claude-haiku-5-5[1m]",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(decision.source, "known");
	assert.equal(decision.upstreamModelId, "claude-haiku-5-5");
	assert.equal(decision.strippedOneMillion, true);
	assert.equal(decision.role, undefined);
});

test("a bare Go model id is forwarded unchanged", () => {
	const decision = resolveMessagesModel({
		requestedModelId: "deepseek-v4.1-flash[1M]",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(decision.source, "known");
	assert.equal(decision.upstreamModelId, "deepseek-v4.1-flash");
});

test("Claude tiers map to the configured role models", () => {
	const opus = resolveMessagesModel({
		requestedModelId: "claude-opus-5-5",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(opus.source, "role");
	assert.equal(opus.role, "opus");
	assert.equal(opus.upstreamModelId, "deepseek-v4-pro");

	const haiku = resolveMessagesModel({
		requestedModelId: "haiku",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(haiku.upstreamModelId, "glm-5.3-flash");

	const fable = resolveMessagesModel({
		requestedModelId: "claude-fable-5",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(fable.role, "fable");
	assert.equal(fable.upstreamModelId, "glm-5.3");
});

test("unset role models fall back through opus and default", () => {
	const fableOnlyOpus = resolveMessagesModel({
		requestedModelId: "fable",
		knownModelIds: KNOWN,
		roles: { opus: "deepseek-v4-pro", default: "glm-5.3" },
	});
	assert.equal(fableOnlyOpus.upstreamModelId, "deepseek-v4-pro");

	const sonnetOnlyDefault = resolveMessagesModel({
		requestedModelId: "sonnet",
		knownModelIds: KNOWN,
		roles: { default: "glm-5.3" },
	});
	assert.equal(sonnetOnlyDefault.upstreamModelId, "glm-5.3");

	const nothingConfigured = resolveMessagesModel({
		requestedModelId: "claude-opus-5-5",
		knownModelIds: KNOWN,
		roles: {},
	});
	assert.equal(nothingConfigured.source, "passthrough");
	assert.equal(nothingConfigured.upstreamModelId, "claude-opus-5-5");
});

test("an unrecognised Claude id falls back to the default model", () => {
	const decision = resolveMessagesModel({
		requestedModelId: "claude-experimental-9",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(decision.source, "default");
	assert.equal(decision.upstreamModelId, "deepseek-v4.1-flash");
});

test("an unconfigured non-Claude id is forwarded for the gateway to reject", () => {
	const decision = resolveMessagesModel({
		requestedModelId: "gpt-6.1-sol",
		knownModelIds: KNOWN,
		roles: ROLES,
	});
	assert.equal(decision.source, "passthrough");
	assert.equal(decision.upstreamModelId, "gpt-6.1-sol");
});

test("normalizeClaudeModelId heals stale role values and strips markers", () => {
	assert.equal(normalizeClaudeModelId("deepseek-v4.1-flash[1M]", KNOWN), "deepseek-v4.1-flash");
	assert.equal(normalizeClaudeModelId("deepseek-v4-pro[1m]", KNOWN), undefined);
	assert.equal(normalizeClaudeModelId("deepseek-v4-flash[1M]", KNOWN), undefined);
	assert.equal(normalizeClaudeModelId(undefined, KNOWN), undefined);
	assert.equal(normalizeClaudeModelId("   ", KNOWN), undefined);
});

test("a role model may itself carry a [1m] marker", () => {
	const decision = resolveMessagesModel({
		requestedModelId: "opus",
		knownModelIds: KNOWN,
		roles: { opus: "deepseek-v4-pro[1m]" },
	});
	assert.equal(decision.upstreamModelId, "deepseek-v4-pro");
});

test("picker rows mark only 1M models and keep catalog details", () => {
	const rows = buildMessagesPickerRows([
		{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", contextLength: 1_000_000, wireApi: "chat" },
		{ id: "hy3", name: "Hy3", contextLength: 256_000, wireApi: "chat" },
		{ id: "grok-4.7", name: "Grok 4.7", contextLength: 500_000, wireApi: "responses" },
		{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextLength: 262_144, wireApi: "chat" },
	]);
	assert.deepEqual(
		rows.map((row) => row.model),
		["deepseek-v4.1-flash[1m]", "hy3", "grok-4.7", "kimi-k2.7-code"],
	);
	assert.equal(rows[0].label, "DeepSeek V4.1 Flash");
	assert.equal(rows[0].description, "OpenCode Go · 1M context · Chat Completions");
	assert.equal(rows[1].description, "OpenCode Go · 256K context · Chat Completions");
	assert.equal(rows[2].description, "OpenCode Go · 500K context · Responses");
});

test("picker rows deduplicate ids and skip blanks", () => {
	const rows = buildMessagesPickerRows([
		{ id: "glm-5.3", name: "GLM-5.3" },
		{ id: "glm-5.3", name: "GLM-5.3 duplicate" },
		{ id: "   ", name: "blank" },
	]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].model, "glm-5.3");
	assert.equal(rows[0].description, "OpenCode Go");
});

test("context floor is the smallest sub-1M window", () => {
	assert.equal(
		messagesContextFloor([
			{ id: "a", name: "A", contextLength: 1_000_000 },
			{ id: "b", name: "B", contextLength: 500_000 },
			{ id: "c", name: "C", contextLength: 256_000 },
			{ id: "d", name: "D", contextLength: 262_144 },
		]),
		256_000,
	);
	assert.equal(
		messagesContextFloor([{ id: "a", name: "A", contextLength: 1_048_576 }]),
		undefined,
	);
	assert.equal(messagesContextFloor([]), undefined);
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
console.log(failed === 0 ? `\n${tests.length} routing tests passed.` : `\n${failed} routing test(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
