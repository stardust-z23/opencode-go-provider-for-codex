#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { startLocalProxy } = require("../out/proxy/index.js");
const apiKey = process.env.OPENCODE_GO_API_KEY?.trim();
assert.ok(apiKey, "OPENCODE_GO_API_KEY is required for the live test");

let codexHome;
let proxy;
const requestLogs = [];
try {
	proxy = await startLocalProxy({
		port: 0,
		upstreamBaseUrl: "https://opencode.ai/inference/go/v1",
		resolveApiKey: async () => apiKey,
		resolveWireApi: () => "anthropic",
		log: (message, detail) => {
			if (message === "messages.request") {
				requestLogs.push(detail);
			}
		},
	});
	codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-go-live-"));
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

	const first = await runCodex(codexHome, [
		"exec",
		"--skip-git-repo-check",
		"--color",
		"never",
		"--dangerously-bypass-approvals-and-sandbox",
		"-C",
		process.cwd(),
		"Reply with exactly two short sentences. Do not use tools.",
	]);
	assertLiveSuccess("first turn", first);

	const second = await runCodex(codexHome, [
		"exec",
		"resume",
		"--last",
		"--skip-git-repo-check",
		"--dangerously-bypass-approvals-and-sandbox",
		"Reply with exactly one short sentence. Do not use tools.",
	]);
	assertLiveSuccess("second turn", second);

	for (const [index, detail] of requestLogs.entries()) {
		console.log(
			`turn ${index + 1}: max_tokens=${detail.max_tokens} thinking=${detail.thinking}`,
		);
	}
	console.log("PASS - live claude-haiku-5-5 completed two consecutive Codex turns");
} finally {
	if (proxy) {
		await proxy.close();
	}
	if (codexHome) {
		try {
			await fs.rm(codexHome, { recursive: true, force: true });
		} catch (error) {
			console.warn(`warning: could not remove ${codexHome}: ${error.message}`);
		}
	}
}

function assertLiveSuccess(label, result) {
	const output = result.stdout + result.stderr;
	assert.equal(
		result.code,
		0,
		`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
	);
	assert.doesNotMatch(output, /Upstream request failed/);
	assert.doesNotMatch(output, /failed to parse ResponseCompleted/);
	assert.doesNotMatch(output, /assistant message prefill/);
	assert.doesNotMatch(output, /Invalid `signature` in `thinking` block/);
}

function runCodex(home, args) {
	return new Promise((resolve, reject) => {
		const child = spawn("codex", args, {
			env: {
				...process.env,
				CODEX_HOME: home,
				OPENCODE_GO_API_KEY: apiKey,
			},
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
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
				void killChildTree(child).finally(() =>
					reject(new Error(`codex exec timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)),
				);
			}
		}, 60_000);
		const onOutput = () => {
			if ((stdout + stderr).includes("tokens used")) {
				finish(0);
			}
		};
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			onOutput();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			onOutput();
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => finish(code ?? 1));
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

process.exit(0);
