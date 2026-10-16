#!/usr/bin/env node
import assert from "node:assert/strict";

const apiKey = process.env.OPENCODE_GO_API_KEY?.trim();
assert.ok(apiKey, "OPENCODE_GO_API_KEY is required for the live test");

const endpoint = "https://opencode.ai/inference/go/v1/messages";
const headers = {
	"content-type": "application/json",
	"x-api-key": apiKey,
	"anthropic-version": "2023-06-01",
	"anthropic-beta": "thinking-binding-controls-2026-08-01",
	"x-opencode-session": "live-binding-test-session",
	"user-agent": "opencode-go-provider-for-codex/live-binding-test",
};

const first = await callMessages({
	model: "claude-haiku-5-5",
	max_tokens: 512,
	thinking: {
		type: "adaptive",
		block_binding: { prefix_mismatch_behavior: "drop_block" },
	},
	output_config: { effort: "high" },
	messages: [
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "Calculate 17 * 23 step by step, then reply with the result only.",
				},
			],
		},
	],
});
const thinkingBlock = first.content.find(
	(block) => block.type === "thinking" || block.type === "redacted_thinking",
);
const textBlock = first.content.find((block) => block.type === "text");
assert.ok(
	thinkingBlock?.signature || thinkingBlock?.data,
	`first response did not contain a signed thinking block: ${JSON.stringify(first.content)}`,
);
assert.ok(textBlock?.text, "first response did not contain visible text");

const second = await callMessages({
	model: "claude-haiku-5-5",
	max_tokens: 256,
	thinking: {
		type: "adaptive",
		block_binding: { prefix_mismatch_behavior: "drop_block" },
	},
	output_config: { effort: "low" },
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "This is a different conversation prefix." }],
		},
		{
			role: "assistant",
			content: [thinkingBlock, textBlock],
		},
		{
			role: "user",
			content: [{ type: "text", text: "Reply with exactly one short sentence." }],
		},
	],
});
assert.ok(
	second.content.some((block) => block.type === "text" && block.text),
	"second response did not contain visible text",
);
console.log("PASS - upstream dropped a prefix-mismatched thinking block");

async function callMessages(body) {
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${text}`);
	}
	return JSON.parse(text);
}
