#!/usr/bin/env node
/**
 * Claude Code pass-through: native Anthropic Messages, session injection,
 * byte-identical SSE relay, usage capture, error pass-through, count_tokens,
 * Anthropic-shaped model discovery and the local /api/hello probe.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startLocalProxy } = require("../out/proxy/index.js");
const { resolveMessagesModel } = require("../out/modelRouting.js");

const REAL_KEY = "real-upstream-key";
const LOCAL_TOKEN = "derived-local-token";
const KNOWN = ["deepseek-v4.1-flash", "glm-5.3", "claude-haiku-5-5"];
const ROLES = {
	default: "deepseek-v4.1-flash",
	opus: "glm-5.3",
	sonnet: "glm-5.3",
	haiku: "glm-5.3",
};

const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

/** Start a fake Anthropic upstream plus the loopback proxy pointed at it. */
async function withProxy(handler, options = {}) {
	const calls = [];
	const upstream = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const call = {
				method: req.method,
				path: req.url,
				headers: req.headers,
				raw,
				body: raw ? safeJson(raw) : undefined,
			};
			calls.push(call);
			handler(req, res, call);
		});
	});
	const upstreamPort = await listen(upstream);
	const logs = [];
	const proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		anthropicBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => REAL_KEY,
		resolveProxyToken: async () => LOCAL_TOKEN,
		resolveMessagesModel: (modelId) =>
			resolveMessagesModel({
				requestedModelId: modelId,
				knownModelIds: KNOWN,
				roles: ROLES,
			}),
		listMessagesModels: options.listMessagesModels,
		log: (message, detail) => logs.push([message, detail]),
	});
	return {
		calls,
		logs,
		proxy,
		baseUrl: `http://127.0.0.1:${proxy.port}`,
		async close() {
			await proxy.close();
			await new Promise((resolve) => upstream.close(resolve));
		},
	};
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function sse(frames) {
	return frames.map((frame) => `${frame}\n\n`).join("");
}

const MESSAGE_START = `event: message_start\ndata: ${JSON.stringify({
	type: "message_start",
	message: {
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "deepseek-v4.1-flash",
		content: [],
		usage: {
			input_tokens: 11,
			cache_read_input_tokens: 2000,
			cache_creation_input_tokens: 30,
			output_tokens: 1,
		},
	},
})}`;

test("forwards the Anthropic request verbatim and injects routing headers", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"request-id": "req_upstream_1",
		});
		res.end(
			sse([
				MESSAGE_START,
				`event: ping\ndata: ${JSON.stringify({ type: "ping" })}`,
				`event: content_block_start\ndata: ${JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				})}`,
				`event: content_block_delta\ndata: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "hello" },
				})}`,
				`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
				`event: message_delta\ndata: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 7 },
				})}`,
				`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
			]),
		);
	});
	const requestBody = {
		model: "deepseek-v4.1-flash[1m]",
		max_tokens: 4096,
		stream: true,
		thinking: { type: "enabled", budget_tokens: 2048 },
		output_config: { effort: "high" },
		context_management: { edits: [] },
		metadata: { user_id: JSON.stringify({ session_id: "claude-session-abc" }) },
		system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
		tools: [
			{
				name: "Bash",
				description: "Run a command",
				input_schema: { type: "object", properties: { cmd: { type: "string" } } },
				cache_control: { type: "ephemeral" },
			},
		],
		tool_choice: { type: "auto" },
		messages: [{ role: "user", content: [{ type: "text", text: "list files" }] }],
	};
	try {
		const response = await fetch(`${agent.baseUrl}/v1/messages?beta=true`, {
			method: "POST",
			headers: {
				"x-api-key": LOCAL_TOKEN,
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "interleaved-thinking-2025-05-14",
				"x-claude-code-session-id": "header-session-1",
				"user-agent": "claude-cli/2.1.318",
			},
			body: JSON.stringify(requestBody),
		});
		const text = await response.text();
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		assert.equal(response.headers.get("request-id"), "req_upstream_1");
		assert.ok(text.includes("event: ping"), "ping frame must survive the relay");
		assert.ok(text.includes("event: message_stop"));

		const call = agent.calls[0];
		assert.equal(call.path, "/v1/messages?beta=true");
		assert.equal(call.headers.authorization, `Bearer ${REAL_KEY}`);
		assert.equal(call.headers["x-api-key"], REAL_KEY);
		assert.equal(call.headers["anthropic-version"], "2023-06-01");
		assert.equal(call.headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
		assert.equal(call.headers["x-claude-code-session-id"], "header-session-1");
		assert.equal(call.headers["x-opencode-session"], "header-session-1");
		assert.match(call.headers["user-agent"], /^opencode-go-provider-for-codex\//);

		// Only `model` changes: the [1m] marker is local and must not reach upstream.
		assert.equal(call.body.model, "deepseek-v4.1-flash");
		const { model: _upstreamModel, ...rest } = call.body;
		const { model: _clientModel, ...expected } = requestBody;
		assert.deepEqual(rest, expected);

		const usage = agent.logs.find(([message]) => message === "proxy.usage");
		assert.ok(usage, "usage must be reported");
		assert.equal(usage[1].inputTokens, 11 + 2000 + 30);
		assert.equal(usage[1].outputTokens, 7);
		assert.equal(usage[1].cachedInputTokens, 2000);
	} finally {
		await agent.close();
	}
});

test("accepts the derived token through Authorization as well", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "message", content: [] }));
	});
	try {
		const response = await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${LOCAL_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "glm-5.3",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		assert.equal(response.status, 200);
		assert.equal(agent.calls[0].headers.authorization, `Bearer ${REAL_KEY}`);
	} finally {
		await agent.close();
	}
});

test("rejects a request without the local proxy token", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	});
	try {
		const response = await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		assert.equal(response.status, 401);
		assert.equal(agent.calls.length, 0);
	} finally {
		await agent.close();
	}
});

test("session id survives when only metadata.user_id carries it", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "message", content: [] }));
	});
	try {
		const body = {
			model: "glm-5.3",
			max_tokens: 64,
			metadata: {
				user_id: JSON.stringify({ device_id: "d1", session_id: "json-session-42" }),
			},
			messages: [{ role: "user", content: "hi" }],
		};
		await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(agent.calls[0].headers["x-opencode-session"], "json-session-42");
	} finally {
		await agent.close();
	}
});

test("falls back to a stable conversation fingerprint", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "message", content: [] }));
	});
	const body = {
		model: "glm-5.3",
		max_tokens: 64,
		system: [{ type: "text", text: "You are Claude Code." }],
		messages: [{ role: "user", content: "list files" }],
	};
	const send = () =>
		fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		await send();
		await send();
		const first = agent.calls[0].headers["x-opencode-session"];
		const second = agent.calls[1].headers["x-opencode-session"];
		assert.match(first, /^codexgo-[0-9a-f]{32}$/);
		assert.equal(first, second, "two turns of one conversation must share the session");

		await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ ...body, messages: [{ role: "user", content: "different" }] }),
		});
		assert.notEqual(
			agent.calls[2].headers["x-opencode-session"],
			first,
			"a different conversation must not reuse the fingerprint",
		);
	} finally {
		await agent.close();
	}
});

test("rewrites Claude role models to the configured OpenCode model", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "message", content: [] }));
	});
	try {
		await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-5-5",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		assert.equal(agent.calls[0].body.model, "glm-5.3");
	} finally {
		await agent.close();
	}
});

test("relays upstream errors with status and Anthropic body", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(429, {
			"content-type": "application/json",
			"retry-after": "17",
		});
		res.end(
			JSON.stringify({
				type: "error",
				error: { type: "rate_limit_error", message: "slow down" },
			}),
		);
	});
	try {
		const response = await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		assert.equal(response.status, 429);
		assert.equal(response.headers.get("retry-after"), "17");
		const payload = await response.json();
		assert.equal(payload.error.type, "rate_limit_error");
		const errorLog = agent.logs.find(([message]) => message === "proxy.upstream_error");
		assert.ok(errorLog, "upstream errors must be recorded");
		assert.equal(errorLog[1].status, 429);
	} finally {
		await agent.close();
	}
});

test("passes count_tokens through untouched", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ input_tokens: 123 }));
	});
	try {
		const response = await fetch(`${agent.baseUrl}/v1/messages/count_tokens`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { input_tokens: 123 });
		assert.equal(agent.calls[0].path, "/v1/messages/count_tokens");
	} finally {
		await agent.close();
	}
});

test("reports an Anthropic model list to gateway discovery", async () => {
	const agent = await withProxy(
		(req, res) => {
			res.writeHead(500);
			res.end("discovery must not reach upstream");
		},
		{
			listMessagesModels: () => [
				{ id: "glm-5.3", name: "GLM-5.3", contextLength: 1_000_000 },
				{ id: "hy3", name: "Hy3", contextLength: 256_000 },
			],
		},
	);
	try {
		const anthropic = await fetch(`${agent.baseUrl}/v1/models?limit=1000`, {
			headers: { "anthropic-version": "2023-06-01" },
		});
		const payload = await anthropic.json();
		assert.deepEqual(
			payload.data.map((model) => model.id),
			["glm-5.3", "hy3"],
		);
		assert.equal(payload.data[0].display_name, "GLM-5.3");
		assert.equal(payload.has_more, false);
		assert.equal(payload.first_id, "glm-5.3");

		const codexProbe = await fetch(`${agent.baseUrl}/v1/models`);
		assert.deepEqual(await codexProbe.json(), { object: "list", data: [] });
		assert.equal(agent.calls.length, 0);
	} finally {
		await agent.close();
	}
});

test("answers the startup probe locally instead of hanging upstream", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(500);
		res.end("must not be reached");
	});
	try {
		const head = await fetch(`${agent.baseUrl}/api/hello`, { method: "HEAD" });
		assert.equal(head.status, 200);
		const get = await fetch(`${agent.baseUrl}/api/hello`);
		assert.deepEqual(await get.json(), { status: "ok" });
		assert.equal(agent.calls.length, 0);
	} finally {
		await agent.close();
	}
});

test("honours a base URL that already ends with /v1", async () => {
	const agent = await withProxy((req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "message", content: [] }));
	});
	try {
		await fetch(`${agent.baseUrl}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${LOCAL_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: "glm-5.3",
				max_tokens: 64,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		assert.equal(agent.calls[0].path, "/v1/messages");
	} finally {
		await agent.close();
	}
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
		? `\n${tests.length} Claude Code proxy tests passed.`
		: `\n${failed} Claude Code proxy test(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
