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
