#!/usr/bin/env node
import assert from "node:assert/strict";
import * as http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	decodeCompactionSummary,
	dedupeDuplicateArgumentKeys,
	encodeCompactionSummary,
	flattenNativeNamespaces,
	repairNativeResponsesRequest,
	replayOwnCompactionItems,
	responsesToChatRequest,
	restoreResponseNamespaces,
	startLocalProxy,
} = require("../out/proxy/index.js");
const { deriveProxyToken } = require("../out/proxyToken.js");
const { setExtensionVersion } = require("../out/utils.js");

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

test("local proxy exposes a health endpoint for cross-window reuse", async () => {
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: "http://127.0.0.1:1/v1",
		resolveApiKey: async () => "test-key",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/health`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { status: "ok" });
	} finally {
		await proxy.close();
	}
});

test("local proxy health echoes the loopback nonce", async () => {
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: "http://127.0.0.1:1/v1",
		resolveApiKey: async () => "test-key",
	});
	try {
		const nonce = "probe-nonce-1";
		const response = await fetch(`${proxy.baseUrl}/health`, {
			headers: { "x-codexgo-loopback-probe": nonce },
		});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-codexgo-loopback-probe"), nonce);
	} finally {
		await proxy.close();
	}
});

test("repairNativeResponsesRequest restores reasoning_text from summary", () => {
	const body = {
		input: [
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Need a tool." }],
				content: null,
			},
		],
	};
	const result = repairNativeResponsesRequest(body);
	assert.equal(result.changed, true);
	assert.deepEqual(body.input[0].content, [{ type: "reasoning_text", text: "Need a tool." }]);
});

test("repairNativeResponsesRequest gives matching call and output the same non-empty call_id", () => {
	const body = {
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
			{ type: "function_call", call_id: "", name: "exec", arguments: "{}" },
			{ type: "function_call_output", call_id: "", output: "ok" },
		],
	};
	const result = repairNativeResponsesRequest(body);
	const callId = body.input[1].call_id;
	assert.equal(result.changed, true);
	assert.match(callId, /^call_/);
	assert.equal(body.input[2].call_id, callId);
});

test("repairNativeResponsesRequest adopts a valid output call_id for a blank custom tool call", () => {
	const body = {
		input: [
			{ type: "custom_tool_call", call_id: " ", name: "apply_patch", input: "*** Begin Patch" },
			{ type: "custom_tool_call_output", call_id: "call_custom_1", output: "done" },
		],
	};
	const result = repairNativeResponsesRequest(body);
	assert.equal(result.changed, true);
	assert.equal(body.input[0].call_id, "call_custom_1");
	assert.equal(body.input[1].call_id, "call_custom_1");
});

test("repairNativeResponsesRequest derives the same blank call_id deterministically", () => {
	const input = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
		{ type: "function_call", call_id: "", name: "exec", arguments: "{\"cmd\":\"echo hi\"}" },
		{ type: "function_call_output", call_id: "", output: "hi" },
	];
	const first = structuredClone(input);
	const second = structuredClone(input);
	repairNativeResponsesRequest({ input: first });
	repairNativeResponsesRequest({ input: second });
	assert.equal(first[1].call_id, second[1].call_id);
	assert.match(first[1].call_id, /^call_[a-f0-9]{24}$/);
	assert.equal(first[2].call_id, first[1].call_id);
});

test("repairNativeResponsesRequest preserves a cacheable history prefix byte-for-byte", () => {
	const input = [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
		{ type: "reasoning", summary: [{ type: "summary_text", text: "Need a tool." }], content: null },
		{ type: "function_call", call_id: "", name: "exec", arguments: "{\"cmd\":\"echo hi\"}" },
		{ type: "function_call_output", call_id: "", output: "hi" },
		{ type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] },
		{ type: "function_call_output", name: "codex_apps_open_page", output: "{\"page_id\":null}" },
	];
	const first = structuredClone(input);
	const second = structuredClone(input);
	repairNativeResponsesRequest({ input: first });
	const firstPrefix = structuredClone(first);
	repairNativeResponsesRequest({ input: second });
	assert.deepEqual(second, firstPrefix);
	second.push({ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] });
	repairNativeResponsesRequest({ input: second });
	assert.deepEqual(second.slice(0, firstPrefix.length), firstPrefix);
});

test("repairNativeResponsesRequest converts an unmatched output into a stable user message", () => {
	const body = {
		input: [
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "context" }] },
			{
				type: "function_call_output",
				id: "fco_orphan",
				name: "codex_apps_open_page",
				output: "{\"page_id\":null}",
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
		],
	};
	const result = repairNativeResponsesRequest(body);
	assert.equal(result.changed, true);
	assert.equal(body.input.length, 3);
	assert.equal(body.input[1].type, "message");
	assert.equal(body.input[1].role, "user");
	assert.match(body.input[1].content[0].text, /without a matching tool call/);
	assert.equal(body.input[2].role, "user");
});

test("repairNativeResponsesRequest defers an orphan until parallel tool outputs finish", () => {
	const body = {
		input: [
			{ type: "function_call", call_id: "call_a", name: "exec", arguments: "{}" },
			{ type: "function_call", call_id: "call_b", name: "exec", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_a", output: "a" },
			{ type: "function_call_output", call_id: "call_orphan", output: "orphan" },
			{ type: "function_call_output", call_id: "call_b", output: "b" },
		],
	};
	repairNativeResponsesRequest(body);
	assert.deepEqual(
		body.input.map((item) => item.type),
		["function_call", "function_call", "function_call_output", "function_call_output", "message"],
	);
	assert.equal(body.input[3].call_id, "call_b");
	assert.equal(body.input[4].role, "user");
});

test("flattenNativeNamespaces rewrites tools, history and tool_choice", () => {
	const body = {
		tools: [
			{
				type: "namespace",
				name: "mcp__files__",
				tools: [
					{ type: "function", name: "read", parameters: { type: "object" } },
					{ type: "function", name: "write", parameters: { type: "object" } },
				],
			},
		],
		input: [
			{
				type: "function_call",
				name: "read",
				namespace: "mcp__files__",
				call_id: "call_1",
				arguments: "{}",
			},
		],
		tool_choice: { type: "function", name: "read", namespace: "mcp__files__" },
	};
	const restoreMap = flattenNativeNamespaces(body);
	assert.equal(body.tools.length, 2);
	assert.equal(body.tools[0].type, "function");
	assert.equal(body.tools[0].name, "mcp__files____read");
	assert.equal(body.input[0].name, "mcp__files____read");
	assert.equal("namespace" in body.input[0], false);
	assert.deepEqual(body.tool_choice, { type: "function", name: "mcp__files____read" });
	assert.equal(restoreMap.get("mcp__files____read").namespace, "mcp__files__");

	const response = {
		output: [
			{
				type: "function_call",
				name: "mcp__files____read",
				call_id: "call_1",
				arguments: "{}",
			},
		],
	};
	assert.equal(restoreResponseNamespaces(response, restoreMap), true);
	assert.equal(response.output[0].name, "read");
	assert.equal(response.output[0].namespace, "mcp__files__");
});

test("flattenNativeNamespaces rejects ambiguous flattened names", () => {
	const body = {
		tools: [
			{ type: "function", name: "mcp__files____read", parameters: {} },
			{
				type: "namespace",
				name: "mcp__files__",
				tools: [{ type: "function", name: "read", parameters: {} }],
			},
		],
	};
	assert.throws(() => flattenNativeNamespaces(body), /collides/);
});

test("dedupeDuplicateArgumentKeys merges nested duplicates with last value wins", () => {
	const body = {
		input: [
			{
				type: "function_call",
				name: "exec",
				call_id: "call_1",
				arguments: '{"time":null,"nested":{"a":1,"a":2},"time":"later"}',
			},
		],
	};
	assert.equal(dedupeDuplicateArgumentKeys(body), 1);
	assert.equal(
		body.input[0].arguments,
		'{"time":"later","nested":{"a":2}}',
	);
});

test("dedupeDuplicateArgumentKeys does not rewrite well-formed arguments", () => {
	const argumentsText = '{ "time": null, "cmd": "echo hi" }';
	const body = {
		input: [
			{
				type: "function_call",
				name: "exec",
				call_id: "call_1",
				arguments: argumentsText,
			},
		],
	};
	assert.equal(dedupeDuplicateArgumentKeys(body), 0);
	assert.equal(body.input[0].arguments, argumentsText);
});

test("replayOwnCompactionItems converts proxy summaries for native Responses", () => {
	const body = {
		input: [
			{
				type: "compaction",
				id: "cmp_1",
				encrypted_content: encodeCompactionSummary("Resume from here."),
			},
		],
	};
	assert.equal(replayOwnCompactionItems(body), 1);
	assert.equal(body.input[0].type, "message");
	assert.equal(body.input[0].role, "user");
	assert.match(body.input[0].content[0].text, /Resume from here\./);
});

test("native Responses proxy repairs blank tool call ids before forwarding", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "resp_native_1",
					object: "response",
					status: "completed",
					output: [],
					usage: null,
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "grok-4.7",
				stream: false,
				input: [
					{ type: "function_call", call_id: "", name: "exec", arguments: "{}" },
					{ type: "function_call_output", call_id: "", output: "ok" },
				],
			}),
		});
		assert.equal(response.status, 200);
		const callId = seen[0].input[0].call_id;
		assert.match(callId, /^call_/);
		assert.equal(seen[0].input[1].call_id, callId);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("native Responses proxy flattens namespace tools and restores response names", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "resp_namespace",
					object: "response",
					status: "completed",
					output: [
						{
							id: "fc_namespace",
							type: "function_call",
							call_id: "call_1",
							name: "mcp__files____read",
							arguments: "{}",
						},
					],
					usage: null,
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "grok-4.7",
				stream: false,
				tools: [
					{
						type: "namespace",
						name: "mcp__files__",
						tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
					},
				],
				input: [{ type: "message", role: "user", content: "read a file" }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen[0].tools[0].type, "function");
		assert.equal(seen[0].tools[0].name, "mcp__files____read");
		const payload = await response.json();
		assert.equal(payload.output[0].name, "read");
		assert.equal(payload.output[0].namespace, "mcp__files__");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("native Responses proxy repairs late arguments before tool completion", async () => {
	const upstream = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				[
					'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_late","type":"function_call","call_id":"call_1","name":"mcp__files____read","arguments":""}}\n\n',
					'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","item_id":"fc_late","output_index":0,"arguments":""}\n\n',
					'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_late","type":"function_call","call_id":"call_1","name":"mcp__files____read","arguments":""}}\n\n',
					'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_late","output_index":0,"delta":"{\\"path\\":\\"README.md\\"}"}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_late","status":"completed","output":[{"id":"fc_late","type":"function_call","call_id":"call_1","name":"mcp__files____read","arguments":"{\\"path\\":\\"README.md\\"}"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
				].join(""),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "grok-4.7",
				stream: true,
				tools: [
					{
						type: "namespace",
						name: "mcp__files__",
						tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
					},
				],
				input: [{ type: "message", role: "user", content: "read a file" }],
			}),
		});
		assert.equal(response.status, 200);
		const text = await response.text();
		const deltas = [
			...text.matchAll(/event: response\.function_call_arguments\.delta/g),
		];
		const doneIndex = text.indexOf('"type":"response.function_call_arguments.done"');
		const deltaIndex = text.indexOf('"type":"response.function_call_arguments.delta"');
		assert.equal(deltas.length, 1);
		assert.ok(deltaIndex >= 0 && doneIndex > deltaIndex);
		assert.match(text, /"arguments":"\{\\"path\\":\\"README.md\\"\}"/);
		assert.match(text, /"name":"read"/);
		assert.match(text, /"namespace":"mcp__files__"/);
		assert.match(text, /response\.completed/);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy creates and replays a local compaction summary", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			if (seen.length === 1) {
				res.end(
					JSON.stringify({
						id: "chatcmpl_compact",
						choices: [
							{
								message: {
									role: "assistant",
									content: "Compacted progress and next steps.",
								},
								finish_reason: "stop",
							},
						],
						usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
					}),
				);
				return;
			}
			res.end(
				JSON.stringify({
					id: "chatcmpl_after_compact",
					choices: [
						{
							message: { role: "assistant", content: "Continued." },
							finish_reason: "stop",
						},
					],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const compactResponse = await fetch(`${proxy.baseUrl}/responses/compact`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				stream: true,
				tools: [{ type: "function", name: "exec", parameters: {} }],
				input: [
					{ type: "message", role: "user", content: "do the work" },
					{ type: "message", role: "assistant", content: "working" },
					{ type: "compaction_trigger" },
				],
			}),
		});
		assert.equal(compactResponse.status, 200);
		const compactText = await compactResponse.text();
		const completed = parseSseEvent(compactText, "response.completed");
		assert.ok(completed);
		const compaction = completed.response.output.find(
			(item) => item.type === "compaction",
		);
		assert.ok(compaction);
		assert.equal(
			decodeCompactionSummary(compaction.encrypted_content),
			"Compacted progress and next steps.",
		);
		assert.equal(seen[0].stream, false);
		assert.equal("tools" in seen[0], false);
		assert.match(seen[0].messages.at(-1).content, /CONTEXT CHECKPOINT COMPACTION/);

		const continued = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				stream: false,
				input: [
					compaction,
					{ type: "message", role: "user", content: "continue from the summary" },
				],
			}),
		});
		assert.equal(continued.status, 200);
		assert.ok(
			seen[1].messages.some(
				(message) =>
					typeof message.content === "string" &&
					message.content.includes("Compacted progress and next steps."),
			),
		);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("native Responses proxy logs final stream usage", async () => {
	const logs = [];
	const upstream = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(
				[
					'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_usage","status":"in_progress"}}\n\n',
					'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_usage","status":"completed","usage":{"input_tokens":301003,"output_tokens":227,"total_tokens":301230,"input_tokens_details":{"cached_tokens":571520},"output_tokens_details":{"reasoning_tokens":79},"opencode":{"billing_source":"go-plus"}}}}\n\n',
				].join(""),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
		log: (message, detail) => logs.push({ message, detail }),
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
				"session-id": "session-usage",
				"x-client-request-id": "client-usage",
			},
			body: JSON.stringify({
				model: "grok-4.7",
				stream: true,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		assert.equal(response.status, 200);
		await response.text();
		const usage = logs.find((entry) => entry.message === "proxy.usage");
		assert.ok(usage);
		assert.equal(usage.detail.inputTokens, 301003);
		assert.equal(usage.detail.outputTokens, 227);
		assert.equal(usage.detail.cachedInputTokens, 571520);
		assert.equal(usage.detail.reasoningTokens, 79);
		assert.equal(usage.detail.billingSource, "go-plus");
		assert.match(usage.detail.traceId, /^[0-9a-f-]{36}$/);
		assert.equal(usage.detail.sessionId, "session-usage");
		assert.equal(usage.detail.clientRequestId, "client-usage");
		assert.equal(usage.detail.requestedModel, "grok-4.7");
		assert.equal(usage.detail.stream, true);
		assert.equal(usage.detail.status, 200);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("responsesToChatRequest flattens namespaced tools and preserves reasoning", () => {
	const request = {
		model: "glm-5.3",
		instructions: "You are Codex.",
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
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "I should run a command." }],
			},
			{
				type: "function_call",
				call_id: "call_1",
				name: "exec",
				namespace: "functions",
				arguments: "{\"cmd\":\"echo hi\"}",
			},
			{ type: "function_call_output", call_id: "call_1", output: "hi" },
		],
		reasoning: { effort: "high" },
		tool_choice: { type: "function", name: "exec", namespace: "functions" },
	};
	const { body, toolMappings } = responsesToChatRequest(request);
	const toolNames = body.tools.map((tool) => tool.function.name);
	assert.deepEqual(toolNames, ["functions__exec", "functions__apply_patch"]);
	assert.equal(body.tools[1].function.parameters.properties.input.type, "string");
	assert.deepEqual(body.tool_choice, { type: "function", function: { name: "functions__exec" } });
	assert.equal(body.reasoning_effort, "high");
	assert.equal(toolMappings.get("functions__exec").namespace, "functions");
	const toolMessage = body.messages.find((message) => message.tool_calls);
	assert.equal(toolMessage.reasoning_content, "I should run a command.");
	assert.equal(toolMessage.tool_calls[0].function.name, "functions__exec");
	assert.equal(body.messages.at(-1).role, "tool");
	assert.equal(body.messages.at(-1).content, "hi");
});

test("responsesToChatRequest preserves input_file and input_audio parts", () => {
	const { body } = responsesToChatRequest({
		model: "glm-5.3",
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "inspect these" },
					{
						type: "input_file",
						filename: "report.pdf",
						file_data: "data:application/pdf;base64,SGVsbG8=",
					},
					{
						type: "input_audio",
						input_audio: { data: "UklGRg==", format: "wav" },
					},
				],
			},
		],
	});
	assert.deepEqual(body.messages[0].content, [
		{ type: "text", text: "inspect these" },
		{
			type: "file",
			file: {
				file_data: "data:application/pdf;base64,SGVsbG8=",
				filename: "report.pdf",
			},
		},
		{
			type: "input_audio",
			input_audio: { data: "UklGRg==", format: "wav" },
		},
	]);
});

test("responsesToChatRequest moves tool media into a following user message", () => {
	const { body } = responsesToChatRequest({
		model: "glm-5.3",
		input: [
			{ type: "message", role: "user", content: "inspect the screenshot" },
			{
				type: "function_call",
				call_id: "call_media",
				name: "view_image",
				arguments: "{}",
			},
			{
				type: "function_call_output",
				call_id: "call_media",
				output: [
					{ type: "input_text", text: "Rendered page" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,aW1hZ2U=",
					},
				],
			},
			{ type: "message", role: "user", content: "what changed?" },
		],
	});
	const tool = body.messages.find((message) => message.role === "tool");
	assert.equal(tool.content, "Rendered page");
	const mediaMessage = body.messages.find(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((part) => part.type === "image_url"),
	);
	assert.ok(mediaMessage);
	assert.deepEqual(mediaMessage.content[0], {
		type: "text",
		text: "[media output of tool call call_media]",
	});
	assert.equal(mediaMessage.content[1].image_url.url, "data:image/png;base64,aW1hZ2U=");
	assert.equal(body.messages.at(-1).content, "what changed?");
});

test("responsesToChatRequest attaches reasoning that arrives after assistant text", () => {
	const request = {
		model: "glm-5.3",
		input: [
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Checked the result." }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
		],
	};
	const { body } = responsesToChatRequest(request);
	const assistant = body.messages.find((message) => message.role === "assistant");
	assert.equal(assistant.reasoning_content, "Checked the result.");
	assert.equal(body.messages.at(-1).role, "user");
});

test("responsesToChatRequest attaches reasoning that arrives after tool output", () => {
	const request = {
		model: "glm-5.3",
		input: [
			{ type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "ok" },
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "The command passed." }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Next." }] },
		],
	};
	const { body } = responsesToChatRequest(request);
	const toolMessage = body.messages.find((message) => message.tool_calls);
	assert.equal(toolMessage.reasoning_content, "The command passed.");
	assert.equal(body.messages.at(-1).role, "user");
});

test("responsesToChatRequest drops reasoning without a matching assistant turn", () => {
	const request = {
		model: "glm-5.3",
		input: [
			{
				type: "reasoning",
				summary: [{ type: "summary_text", text: "Recovered from history." }],
			},
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
		],
	};
	const { body } = responsesToChatRequest(request);
	assert.deepEqual(body.messages, [{ role: "user", content: "Continue." }]);
});

test("responsesToChatRequest backfills reasoning_content for tool-call messages", () => {
	const request = {
		model: "glm-5.3",
		input: [
			{ type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "ok" },
		],
	};
	const { body } = responsesToChatRequest(request);
	const toolMessage = body.messages.find((message) => message.tool_calls);
	assert.equal(toolMessage.reasoning_content, "tool call");
});

test("DeepSeek fills only missing reasoning_content fields for tool history", () => {
	const request = {
		model: "deepseek-v4-pro",
		tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }],
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "ok" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Plain reply." }] },
		],
	};
	const result = responsesToChatRequest(request);
	const toolMessage = result.body.messages.find((message) => message.tool_calls);
	assert.equal(toolMessage.reasoning_content, "");
	const plainAssistant = result.body.messages.find(
		(message) => message.role === "assistant" && !message.tool_calls,
	);
	assert.equal(plainAssistant.reasoning_content, "");
	assert.equal(result.validationError, undefined);
});

test("DeepSeek Chat maps none to thinking disabled", () => {
	const { body } = responsesToChatRequest({
		model: "deepseek-v4-pro",
		reasoning: { effort: "none" },
		input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
	});
	assert.deepEqual(body.thinking, { type: "disabled" });
	assert.equal("reasoning_effort" in body, false);
});

test("proxy separates the local bearer token from the upstream API key", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			seen.push(req.headers.authorization);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "upstream-key",
		resolveProxyToken: async () => deriveProxyToken("upstream-key"),
		resolveWireApi: () => "responses",
	});
	try {
		const unauthorized = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
			body: JSON.stringify({
				model: "deepseek-v4.1-flash",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		assert.equal(unauthorized.status, 401);

		const authorized = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${deriveProxyToken("upstream-key")}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "deepseek-v4.1-flash",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		assert.equal(authorized.status, 200);
		assert.equal(seen[0], "Bearer upstream-key");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy restores tool call and reasoning from previous_response_id", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			if (seen.length === 1) {
				res.end(
					JSON.stringify({
						id: "chatcmpl_history_1",
						choices: [
							{
								message: {
									role: "assistant",
									content: null,
									reasoning_content: "Need to run the command.",
									tool_calls: [
										{
											id: "call_1",
											type: "function",
											function: { name: "exec", arguments: "{}" },
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: {
							prompt_tokens: 100,
							completion_tokens: 20,
							total_tokens: 120,
							opencode: { billing_source: "go-plus" },
						},
					}),
				);
				return;
			}
			res.end(
				JSON.stringify({
					id: "chatcmpl_history_2",
					choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const firstResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				stream: false,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }],
			}),
		});
		assert.equal(firstResponse.status, 200);
		const first = await firstResponse.json();
		assert.equal(first.usage.opencode.billing_source, "go-plus");
		assert.ok(first.output.some((item) => item.type === "reasoning"));
		assert.ok(first.output.some((item) => item.type === "function_call"));

		const secondResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				stream: false,
				previous_response_id: first.id,
				input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
			}),
		});
		assert.equal(secondResponse.status, 200);
		assert.equal(seen.length, 2);
		const assistant = seen[1].messages.find((message) => message.tool_calls);
		assert.ok(assistant, "the cached assistant tool call must be restored");
		assert.equal(assistant.reasoning_content, "Need to run the command.");
		assert.equal(seen[1].messages.at(-1).role, "tool");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("DeepSeek chat restores cached reasoning when Codex replays the tool call", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			if (seen.length === 1) {
				res.end(
					JSON.stringify({
						id: "chatcmpl_replayed_tool",
						choices: [
							{
								message: {
									role: "assistant",
									content: null,
									reasoning_content: "Cached reasoning",
									tool_calls: [
										{
											id: "call_1",
											type: "function",
											function: { name: "exec", arguments: "{}" },
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: {},
					}),
				);
				return;
			}
			res.end(
				JSON.stringify({
					id: "chatcmpl_replayed_result",
					choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const firstResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "deepseek-v4-pro",
				stream: false,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }],
			}),
		});
		assert.equal(firstResponse.status, 200);
		const first = await firstResponse.json();

		const secondResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "deepseek-v4-pro",
				stream: false,
				previous_response_id: first.id,
				input: [
					{ type: "function_call", call_id: "call_1", name: "exec", arguments: "{}" },
					{ type: "function_call_output", call_id: "call_1", output: "ok" },
				],
			}),
		});
		assert.equal(secondResponse.status, 200);
		const assistant = seen[1].messages.find((message) => message.tool_calls);
		assert.equal(assistant.reasoning_content, "Cached reasoning");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("DeepSeek chat restores cached reasoning exactly once when the tool call is absent", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			if (seen.length === 1) {
				res.end(
					JSON.stringify({
						id: "chatcmpl_reasoning_once",
						choices: [
							{
								message: {
									role: "assistant",
									content: null,
									reasoning_content: "Only once",
									tool_calls: [
										{
											id: "call_1",
											type: "function",
											function: { name: "exec", arguments: "{}" },
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: {},
					}),
				);
				return;
			}
			res.end(
				JSON.stringify({
					id: "chatcmpl_reasoning_once_2",
					choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const firstResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "deepseek-v4-pro",
				stream: false,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				tools: [{ type: "function", name: "exec", parameters: { type: "object", properties: {} } }],
			}),
		});
		assert.equal(firstResponse.status, 200);
		const first = await firstResponse.json();

		const secondResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "deepseek-v4-pro",
				stream: false,
				previous_response_id: first.id,
				input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
			}),
		});
		assert.equal(secondResponse.status, 200);
		const assistant = seen[1].messages.find((message) => message.tool_calls);
		assert.equal(assistant.reasoning_content, "Only once");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy maps visible xhigh back to upstream max", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl_effort_1",
					choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
		resolveEfforts: async () => ["low", "high", "max"],
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
				"session-id": "gemini-session",
			},
			body: JSON.stringify({
				model: "deepseek-v4.1-flash",
				stream: false,
				reasoning: { effort: "xhigh" },
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen[0].body.reasoning_effort, "max");
		assert.equal(seen[0].headers["session-id"], "gemini-session");
		assert.equal(seen[0].headers["x-opencode-session"], "gemini-session");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy maps visible low back to upstream minimal when low is absent", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "chatcmpl_effort_minimal",
					choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
		resolveEfforts: async () => ["minimal", "high"],
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "minimal-model",
				stream: false,
				reasoning: { effort: "low" },
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen[0].reasoning_effort, "minimal");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("native proxy repairs reasoning and forwards session headers", async () => {
	setExtensionVersion("9.9.9-test");
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				headers: req.headers,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
				"session-id": "session-1",
				"thread-id": "thread-1",
			},
			body: JSON.stringify({
				model: "deepseek-v4.1-flash",
				input: [
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "thinking" }],
						content: null,
					},
				],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen.length, 1);
		assert.equal(
			seen[0].headers["user-agent"],
			"opencode-go-provider-for-codex/9.9.9-test",
		);
		assert.equal(seen[0].headers["session-id"], "session-1");
		assert.equal(seen[0].headers["thread-id"], "thread-1");
		assert.deepEqual(seen[0].body.input[0].content, [
			{ type: "reasoning_text", text: "thinking" },
		]);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("native proxy derives a stable OpenCode session when the client omits one", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			seen.push(req.headers["x-opencode-session"]);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: `resp_session_${seen.length}`,
					object: "response",
					status: "completed",
					output: [],
					usage: null,
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
	});
	try {
		const request = (turns, requestId) =>
			fetch(`${proxy.baseUrl}/responses`, {
				method: "POST",
				headers: {
					authorization: "Bearer test-key",
					"content-type": "application/json",
					"x-client-request-id": requestId,
				},
				body: JSON.stringify({
					model: "grok-4.7",
					stream: false,
					instructions: "Stable instructions",
					input: turns,
				}),
			});
		const firstUser = { type: "message", role: "user", content: "first question" };
		assert.equal((await request([firstUser], "request-1")).status, 200);
		assert.equal(
			(
				await request(
					[
						firstUser,
						{ type: "message", role: "assistant", content: "answer" },
						{ type: "message", role: "user", content: "follow up" },
					],
					"request-2",
				)
			).status,
			200,
		);
		assert.match(seen[0], /^codexgo-[a-f0-9]{32}$/);
		assert.equal(seen[1], seen[0]);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("native proxy preserves x-session-id and maps it to x-opencode-session", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			seen.push(req.headers);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "resp_x_session",
					object: "response",
					status: "completed",
					output: [],
					usage: null,
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "responses",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
				"x-session-id": "codex-x-session",
			},
			body: JSON.stringify({
				model: "grok-4.7",
				stream: false,
				input: [{ type: "message", role: "user", content: "hi" }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen[0]["x-session-id"], "codex-x-session");
		assert.equal(seen[0]["x-opencode-session"], "codex-x-session");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy restores a no-tool assistant turn from previous_response_id", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			seen.push(body);
			res.writeHead(200, { "content-type": "application/json" });
			if (seen.length === 1) {
				res.end(
					JSON.stringify({
						id: "chatcmpl_no_tool",
						choices: [
							{
								message: {
									role: "assistant",
									content: "Previous answer",
									reasoning_content: "Previous reasoning",
								},
								finish_reason: "stop",
							},
						],
						usage: {},
					}),
				);
				return;
			}
			res.end(
				JSON.stringify({
					id: "chatcmpl_followup",
					choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
					usage: {},
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const firstResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				stream: false,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "first" }] }],
			}),
		});
		assert.equal(firstResponse.status, 200);
		const first = await firstResponse.json();

		const secondResponse = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				stream: false,
				previous_response_id: first.id,
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "second" }] }],
			}),
		});
		assert.equal(secondResponse.status, 200);
		const assistant = seen[1].messages.find((message) => message.role === "assistant");
		assert.equal(assistant.content, "Previous answer");
		assert.equal(assistant.reasoning_content, "Previous reasoning");
		assert.equal(seen[1].messages.at(-1).content, "second");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy converts streaming tool calls to Responses SSE", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.write(
				'data: {"id":"chatcmpl_1","model":"glm-5.3","choices":[{"delta":{"reasoning_content":"Use a tool."}}]}\n\n',
			);
			res.write(
				'data: {"id":"chatcmpl_1","model":"glm-5.3","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"functions__exec"}}]}}]}\n\n',
			);
			res.write(
				'data: {"id":"chatcmpl_1","model":"glm-5.3","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":\\"echo hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "glm-5.3",
				stream: true,
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
										parameters: { type: "object", properties: {} },
									},
								],
							},
						],
					},
					{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				],
			}),
		});
		assert.equal(response.status, 200);
		const text = await response.text();
		assert.match(text, /response\.created/);
		assert.match(text, /reasoning_summary_text\.delta/);
		assert.match(text, /response\.function_call_arguments\.done/);
		assert.match(text, /"name":"exec"/);
		assert.match(text, /"arguments":"\{\\"cmd\\":\\"echo hi\\"\}"/);
	assert.match(text, /"delta":"Use a tool\."/);
		assert.match(text, /response\.completed/);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].model, "glm-5.3");
		assert.equal(seen[0].stream, true);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("chat proxy separates inline thinking tags from visible text (fragment-safe)", async () => {
	const openTag = "<" + "think" + ">";
	const closeTag = "<" + "/" + "think" + ">";
	const upstream = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
			});
			res.write(`data: ${JSON.stringify({
				id: "chatcmpl_inline",
				model: "glm-5.3",
				choices: [{ delta: { content: `Hello ${openTag}secret` } }],
			})}\n\n`);
			res.write(`data: ${JSON.stringify({
				id: "chatcmpl_inline",
				model: "glm-5.3",
				choices: [{ delta: { content: ` plan${closeTag}world` }, finish_reason: "stop" }],
			})}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "glm-5.3",
				stream: true,
				input: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				],
			}),
		});
		assert.equal(response.status, 200);
		const text = await response.text();
		assert.match(text, /reasoning_summary_text\.delta/);
		assert.match(text, /"delta":"secret"/);
		assert.match(text, /"delta":" plan"/);
		assert.match(text, /"delta":"Hello "/);
		assert.match(text, /"delta":"world"/);
		assert.equal(text.includes(openTag), false);
		assert.equal(text.includes(closeTag), false);
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

test("proxy model routes rewrite aliases and select the requested protocol", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				url: req.url,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
			});
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "resp_alias",
					object: "response",
					status: "completed",
					model: "deepseek-v4.1-flash",
					output: [],
				}),
			);
		});
	});
	const upstreamPort = await listen(upstream);
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "chat",
		resolveModel: (modelId) =>
			modelId === "deepseek-v4.1-flash-responses"
				? {
						wireApi: "responses",
						upstreamModelId: "deepseek-v4.1-flash",
						efforts: ["low", "high", "max"],
					}
				: undefined,
	});
	try {
		const response = await fetch(`${proxy.baseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer test-key",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "deepseek-v4.1-flash-responses",
				stream: false,
				reasoning: { effort: "xhigh" },
				input: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
				],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].url, "/v1/responses");
		assert.equal(seen[0].body.model, "deepseek-v4.1-flash");
		assert.equal(seen[0].body.reasoning.effort, "max");
	} finally {
		await proxy.close();
		await close(upstream);
	}
});

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
