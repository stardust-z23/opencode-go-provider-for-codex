#!/usr/bin/env node
import assert from "node:assert/strict";
import * as http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	decodeAnthropicThinkingBlock,
	encodeAnthropicThinkingBlock,
	responsesToAnthropicRequest,
	startLocalProxy,
} = require("../out/proxy/index.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

test("responsesToAnthropicRequest converts system, tools, thinking and tool history", () => {
	const thinkingBlock = {
		type: "thinking",
		thinking: "I should inspect the repository.",
		signature: "signed-thinking",
	};
	const encrypted = encodeAnthropicThinkingBlock(thinkingBlock, "minimax-m3");
	assert.ok(encrypted);
	assert.deepEqual(decodeAnthropicThinkingBlock(encrypted), thinkingBlock);

	const request = {
		model: "minimax-m3",
		instructions: "You are Codex.",
		max_output_tokens: 8192,
		reasoning: { effort: "high" },
		tool_choice: "auto",
		input: [
			{
				type: "additional_tools",
				role: "developer",
				tools: [
					{
						type: "namespace",
						name: "functions",
						tools: [
							{
								type: "function",
								name: "exec",
								description: "Run a command",
								parameters: { type: "object", properties: { cmd: { type: "string" } } },
							},
							{ type: "custom", name: "apply_patch", description: "Patch files" },
						],
					},
				],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ type: "reasoning", encrypted_content: encrypted },
			{
				type: "function_call",
				call_id: "call_1",
				name: "exec",
				namespace: "functions",
				arguments: "{\"cmd\":\"echo hi\"}",
			},
			{ type: "function_call_output", call_id: "call_1", output: "hi" },
		],
	};

	const transformed = responsesToAnthropicRequest(request);
	assert.equal(transformed.body.system, "You are Codex.");
	assert.equal(transformed.body.max_tokens, 8192);
	assert.deepEqual(transformed.body.thinking, {
		type: "enabled",
		budget_tokens: 4096,
	});
	assert.deepEqual(
		transformed.body.tools.map((tool) => tool.name),
		["functions__exec", "functions__apply_patch"],
	);
	assert.equal(transformed.body.tools[0].input_schema.properties.cmd.type, "string");
	assert.equal(transformed.body.tools[1].input_schema.properties.input.type, "string");
	assert.deepEqual(transformed.body.tool_choice, { type: "auto" });

	const messages = transformed.body.messages;
	assert.equal(messages[0].role, "user");
	assert.equal(messages[1].role, "assistant");
	assert.equal(messages[1].content[0].type, "thinking");
	assert.equal(messages[1].content[1].type, "tool_use");
	assert.equal(messages[1].content[1].name, "functions__exec");
	assert.equal(messages[1].content[1].input.cmd, "echo hi");
	assert.equal(messages[2].role, "user");
	assert.equal(messages[2].content[0].type, "tool_result");
	assert.equal(messages[2].content[0].tool_use_id, "call_1");
});

test("Claude Haiku uses adaptive thinking and output_config effort", () => {
	const transformed = responsesToAnthropicRequest({
		model: "claude-haiku-5-5",
		max_output_tokens: 8192,
		reasoning: { effort: "high" },
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
		],
	});
	assert.deepEqual(transformed.body.thinking, {
		type: "adaptive",
		block_binding: { prefix_mismatch_behavior: "drop_block" },
	});
	assert.deepEqual(transformed.body.output_config, { effort: "high" });
	assert.equal("budget_tokens" in transformed.body.thinking, false);

	const defaulted = responsesToAnthropicRequest({
		model: "claude-haiku-5-5",
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
		],
	});
	assert.equal(defaulted.body.max_tokens, 128000);
});

test("thinking signatures are not replayed across model switches", () => {
	const oldBlock = {
		type: "thinking",
		thinking: "old model thinking",
		signature: "old-model-signature",
	};
	const foreign = encodeAnthropicThinkingBlock(oldBlock, "minimax-m3");
	const switched = responsesToAnthropicRequest({
		model: "claude-haiku-5-5",
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
			{
				type: "reasoning",
				encrypted_content: foreign,
			},
			{
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: "<model_switch>switch</model_switch>" }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
		],
	});
	const switchedBlocks = switched.body.messages.flatMap((message) => message.content);
	assert.equal(
		switchedBlocks.some((block) => block.type === "thinking"),
		false,
	);

	const sameModel = encodeAnthropicThinkingBlock(oldBlock, "claude-haiku-5-5");
	const continued = responsesToAnthropicRequest({
		model: "claude-haiku-5-5",
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
			{ type: "reasoning", encrypted_content: sameModel },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
		],
	});
	const continuedBlocks = continued.body.messages.flatMap((message) => message.content);
	assert.equal(
		continuedBlocks.some((block) => block.type === "thinking"),
		true,
	);

	const legacy = `codexgo-anthropic-thinking-v1:${Buffer.from(
		JSON.stringify(oldBlock),
		"utf8",
	).toString("base64url")}`;
	const legacyForClaude = responsesToAnthropicRequest({
		model: "claude-haiku-5-5",
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
			{ type: "reasoning", encrypted_content: legacy },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
		],
	});
	const legacyBlocks = legacyForClaude.body.messages.flatMap((message) => message.content);
	assert.equal(
		legacyBlocks.some((block) => block.type === "thinking"),
		false,
	);
});

test("assistant-last history gets a trailing user continuation", () => {
	const transformed = responsesToAnthropicRequest({
		model: "claude-haiku-5-5",
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "world" }],
			},
		],
	});
	const messages = transformed.body.messages;
	assert.equal(messages.at(-1).role, "user");
	assert.equal(messages.at(-1).content[0].text, "Continue.");
});

test("Anthropic Messages proxy converts streaming thinking, text and tools", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				url: req.url,
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			writeEvent(res, "message_start", {
				type: "message_start",
				message: { id: "msg_1", model: "claude-haiku-5-5", usage: { input_tokens: 12 } },
			});
			writeEvent(res, "content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			});
			writeEvent(res, "content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Thinking..." },
			});
			writeEvent(res, "content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "signature-" },
			});
			writeEvent(res, "content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "1" },
			});
			writeEvent(res, "content_block_stop", {
				type: "content_block_stop",
				index: 0,
			});
			writeEvent(res, "content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "text", text: "" },
			});
			writeEvent(res, "content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: "Hello" },
			});
			writeEvent(res, "content_block_stop", {
				type: "content_block_stop",
				index: 1,
			});
			writeEvent(res, "content_block_start", {
				type: "content_block_start",
				index: 2,
				content_block: {
					type: "tool_use",
					id: "call_1",
					name: "functions__exec",
					input: {},
				},
			});
			writeEvent(res, "content_block_delta", {
				type: "content_block_delta",
				index: 2,
				delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"echo hi\"}" },
			});
			writeEvent(res, "content_block_stop", {
				type: "content_block_stop",
				index: 2,
			});
			writeEvent(res, "message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 5 },
			});
			writeEvent(res, "message_stop", { type: "message_stop" });
			res.end();
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "anthropic",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
				"session-id": "session-1",
			},
			body: JSON.stringify({
				model: "claude-haiku-5-5",
				stream: true,
				max_output_tokens: 8192,
				reasoning: { effort: "high" },
				tools: [
					{
						type: "function",
						name: "exec",
						namespace: "functions",
						parameters: { type: "object", properties: { cmd: { type: "string" } } },
					},
				],
				input: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				],
			}),
		});
		assert.equal(response.status, 200);
		const text = await response.text();
		assert.match(text, /response\.created/);
		assert.match(text, /reasoning_summary_text\.delta/);
		assert.match(text, /output_text\.delta/);
		assert.match(text, /function_call_arguments\.done/);
		assert.match(text, /"name":"exec"/);
		assert.match(text, /response\.completed/);
		const reasoningItem = parseSseEvent(text, "response.output_item.done")?.item;
		assert.equal(
			decodeAnthropicThinkingBlock(reasoningItem.encrypted_content).signature,
			"signature-1",
		);
		const completed = parseSseEvent(text, "response.completed");
		assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 0);
		assert.equal(completed.response.usage.input_tokens_details.cache_write_tokens, 0);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].url, "/v1/messages");
		assert.equal(seen[0].headers["x-api-key"], "test-key");
		assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
		assert.equal(seen[0].headers["x-opencode-session"], "session-1");
		assert.match(
			seen[0].headers["anthropic-beta"],
			/thinking-binding-controls-2026-08-01/,
		);
		assert.deepEqual(seen[0].body.thinking, {
			type: "adaptive",
			block_binding: { prefix_mismatch_behavior: "drop_block" },
		});
		assert.deepEqual(seen[0].body.output_config, { effort: "high" });
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

function writeEvent(res, event, payload) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function parseSseEvent(text, eventName) {
	for (const block of text.split("\n\n")) {
		const event = block
			.split("\n")
			.find((line) => line.startsWith("event:"))
			?.slice(6)
			.trim();
		if (event !== eventName) {
			continue;
		}
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		return JSON.parse(data);
	}
	return undefined;
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function close(server) {
	return new Promise((resolve) => server.close(() => resolve()));
}

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
