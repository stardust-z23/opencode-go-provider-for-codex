#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startLocalProxy } = require("../out/proxy/index.js");

const upstream = http.createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: "claude-haiku-5-5" }] }));
		return;
	}
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		});
		writeEvent(res, "message_start", {
			type: "message_start",
			message: {
				id: "msg_codex_e2e",
				model: "claude-haiku-5-5",
				usage: { input_tokens: 10 },
			},
		});
		writeEvent(res, "content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});
		writeEvent(res, "content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "text_delta",
				text: "First sentence. Second sentence.",
			},
		});
		writeEvent(res, "content_block_stop", {
			type: "content_block_stop",
			index: 0,
		});
		writeEvent(res, "message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 6 },
		});
		writeEvent(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

let codexHome;
let proxy;
try {
	const upstreamPort = await listen(upstream);
	proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
		resolveApiKey: async () => "test-key",
		resolveWireApi: () => "anthropic",
	});
	codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-go-e2e-"));
	await fs.writeFile(
		path.join(codexHome, "config.toml"),
		[
			'model = "claude-haiku-5-5"',
			'model_provider = "opencode-go"',
			"",
			"[model_providers.opencode-go]",
			'name = "OpenCode Go"',
			`base_url = "http://127.0.0.1:${proxy.port}/v1"`,
			'env_key = "OPENCODE_GO_API_KEY"',
			'wire_api = "responses"',
			"requires_openai_auth = false",
			"",
		].join("\n"),
	);
	const result = await runCodex(codexHome);
	assert.equal(
		result.code,
		0,
		`codex exec failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	assert.doesNotMatch(result.stdout + result.stderr, /failed to parse ResponseCompleted/);
	console.log("PASS - real codex exec completed a multi-sentence Messages response");
} finally {
	if (proxy) {
		await proxy.close();
	}
	await close(upstream);
	if (codexHome) {
		try {
			await fs.rm(codexHome, { recursive: true, force: true });
		} catch (error) {
			console.warn(`warning: could not remove ${codexHome}: ${error.message}`);
		}
	}
}

function writeEvent(res, event, payload) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function runCodex(home) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"codex",
			[
				"exec",
				"--skip-git-repo-check",
				"--ephemeral",
				"--color",
				"never",
				"--dangerously-bypass-approvals-and-sandbox",
				"-C",
				process.cwd(),
				"Reply with two short sentences.",
			],
			{
				env: {
					...process.env,
					CODEX_HOME: home,
					OPENCODE_GO_API_KEY: "test-key",
				},
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			void killChildTree(child).finally(() => resolve({ code, stdout, stderr }));
		};
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(new Error(`codex exec timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
			}
		}, 30_000);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (
				(stdout + stderr).includes("First sentence. Second sentence.") &&
				(stdout + stderr).includes("tokens used")
			) {
				finish(0);
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			finish(code ?? 1);
		});
	});
}

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}

function killChildTree(child) {
	return new Promise((resolve) => {
		if (child.exitCode !== null || !child.pid) {
			resolve();
			return;
		}
		if (process.platform === "win32") {
			const killer = spawn(
				"taskkill",
				["/pid", String(child.pid), "/T", "/F"],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.once("close", () => resolve());
			killer.once("error", () => resolve());
			return;
		}
		child.kill("SIGKILL");
		resolve();
	});
}

function close(server) {
	return new Promise((resolve) => server.close(() => resolve()));
}

process.exit(0);
