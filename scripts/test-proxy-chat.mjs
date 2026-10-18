#!/usr/bin/env node
import assert from "node:assert/strict";
import * as http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { repairNativeResponsesRequest, responsesToChatRequest, startLocalProxy } = require(
	"../out/proxy/index.js",
);

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

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
						usage: {},
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

test("chat proxy maps visible xhigh back to upstream max", async () => {
	const seen = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
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
			headers: { authorization: "Bearer test-key", "content-type": "application/json" },
			body: JSON.stringify({
				model: "deepseek-v4.1-flash",
				stream: false,
				reasoning: { effort: "xhigh" },
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(seen[0].reasoning_effort, "max");
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
