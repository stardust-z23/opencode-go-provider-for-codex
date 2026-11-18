/**
 * 定位并驱动本机安装的 Codex 可执行文件。
 *
 * 为什么要这么做：手写模型目录太脆弱。条目结构庞大且随版本变化，一旦条目
 * 不合法，Codex 会**直接拒绝加载配置**（`Error loading config.toml: failed to
 * parse model_catalog_json ...`）。稳妥的做法是从用户正在运行的那份 Codex
 * 安装里取一条已知可用的条目：
 *
 * - `codex debug models` 会以 JSON 打印内置目录，即一份现成的、与版本匹配的
 *   模板（含 `model_messages`/`base_instructions`）。
 * - `codex doctor` 会报告配置是否仍能加载，用作写盘后的检查，再决定是否提示
 *   用户重启 Codex。
 *
 * Codex VS Code 扩展把**所有**平台的构建都放在同一个 `bin/` 目录里
 * （`bin/linux-x86_64/codex`、`bin/windows-x86_64/codex.exe` 等），而它自己的
 * bin 目录只加入**终端**环境，不加入扩展宿主进程的 `PATH`。因此只按文件名
 * 扫描该目录，在 Windows 上会选中 Linux ELF，随后以 `spawn ... ENOENT` 失败。
 * 来自扩展目录的候选必须与宿主平台匹配。
 *
 * 不引入 `vscode`：本模块在纯 Node 下运行。
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CatalogEntry } from "./catalog";

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	/** 进程完全无法启动或被迫终止时为 true。 */
	failed: boolean;
}

/** Codex 可执行文件候选列表，越显式越靠前。 */
export function findCodexExecutables(explicitPath?: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (candidate: string | undefined): void => {
		const trimmed = candidate?.trim();
		if (!trimmed) {
			return;
		}
		// Windows 路径不区分大小写，而 `findOnPath` 与目录遍历对盘符大小写的
		// 处理并不一致。
		const key = trimmed.toLowerCase();
		if (seen.has(key) || !isFile(trimmed)) {
			return;
		}
		seen.add(key);
		candidates.push(trimmed);
	};

	push(explicitPath);
	push(findOnPath());
	for (const found of findInExtensionDirs()) {
		push(found);
	}
	return candidates;
}

/**
 * Codex 在 `platform` 上提供的文件名。在 Windows 上刻意排除裸 `codex`：那只会
 * 匹配到其他平台的构建。
 */
export function executableNamesFor(platform: NodeJS.Platform = process.platform): string[] {
	return platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
}

/** Codex 扩展按平台提供的 `bin/` 子目录前缀。 */
const PLATFORM_DIR_PREFIX: Partial<Record<NodeJS.Platform, string>> = {
	win32: "windows-",
	linux: "linux-",
	darwin: "darwin-",
};

/**
 * 判断 `candidate` 是否为面向 `platform` 构建的 Codex 二进制：同时看文件名
 * 与它所在的 `bin/<平台>-<架构>` 父目录。
 */
export function isPlatformCodexBinary(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
	const prefix = PLATFORM_DIR_PREFIX[platform];
	if (!prefix) {
		return false;
	}
	if (!executableNamesFor(platform).includes(path.basename(candidate))) {
		return false;
	}
	return path.basename(path.dirname(candidate)).toLowerCase().startsWith(prefix);
}

function findOnPath(): string | undefined {
	const entries = (process.env.PATH ?? "").split(path.delimiter);
	for (const dir of entries) {
		if (!dir.trim()) {
			continue;
		}
		for (const name of executableNamesFor()) {
			const candidate = path.join(dir, name);
			if (isFile(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/**
 * Codex VS Code 扩展自带二进制，是 CLI 不在 PATH 上时最可能的查找位置。
 */
function findInExtensionDirs(platform: NodeJS.Platform = process.platform): string[] {
	const roots = ["vscode", "vscode-insiders", "cursor", "windsurf"].map((flavour) =>
		path.join(os.homedir(), `.${flavour}`, "extensions"),
	);
	const found: string[] = [];
	for (const root of roots) {
		let entries: string[];
		try {
			entries = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!/^openai\.chatgpt-|^openai\.codex-/.test(entry)) {
				continue;
			}
			const binDir = path.join(root, entry, "bin");
			for (const relative of walk(binDir, 4)) {
				if (isPlatformCodexBinary(relative, platform)) {
					found.push(relative);
				}
			}
		}
	}
	return found;
}

function* walk(dir: string, depth: number): Generator<string> {
	if (depth < 0) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full, depth - 1);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** 运行 Codex 子命令，永不抛异常。 */
export async function runCodex(
	exePath: string,
	args: readonly string[],
	options?: { timeoutMs?: number; env?: Record<string, string | undefined> },
): Promise<RunResult> {
	const timeoutMs = options?.timeoutMs ?? 30_000;
	return await new Promise<RunResult>((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(exePath, [...args], { env: { ...process.env, ...options?.env }, windowsHide: true });
		} catch (err) {
			resolve({ code: null, stdout: "", stderr: String(err), failed: true });
			return;
		}
		const finish = (result: RunResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// 进程已经退出
			}
			finish({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms`, failed: true });
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (err) => finish({ code: null, stdout, stderr: `${stderr}\n${String(err)}`, failed: true }));
		child.on("close", (code) => finish({ code, stdout, stderr, failed: false }));
	});
}

/** {@link exportCatalogTemplate} 的结果：模板，或没有模板的原因。 */
export interface TemplateLookup {
	template?: CatalogEntry;
	/** 单行原因，前面带上试过的可执行文件路径。 */
	error?: string;
}

/**
 * 挑选生成目录时克隆的条目。
 *
 * 优先级：
 * 1. 带 instructions 且使用**经典** Responses 传输的条目，也就是既没开启
 *    `use_responses_lite`、也没有代码模式 `tool_mode` 的条目。这两种第一方
 *    传输方式会把工具定义移出请求顶层的 `tools` 数组，第三方网关根本看不到
 *    （见 `catalog.applyThirdPartyTransport`）；
 * 2. 任何带 instructions 的条目；
 * 3. 第一条条目。
 */
export function selectCatalogTemplate(entries: Array<Record<string, unknown>>): CatalogEntry | undefined {
	if (entries.length === 0) {
		return undefined;
	}
	const withInstructions = entries.filter((entry) => {
		const messages = entry.model_messages as { instructions_template?: unknown } | undefined;
		return typeof messages?.instructions_template === "string" || typeof entry.base_instructions === "string";
	});
	const candidates = withInstructions.length > 0 ? withInstructions : entries;
	const classic = candidates.find(
		(entry) => entry.use_responses_lite !== true && entry.tool_mode === undefined,
	);
	return JSON.parse(JSON.stringify(classic ?? candidates[0])) as CatalogEntry;
}

/**
 * 从本机 Codex（`codex debug models`）读取一条已知可用的目录条目。
 * 永不抛异常：失败会以 `error` 返回，调用方可以记录**原因**，而不是只显示
 * 一句干巴巴的「无法读取」。
 */
export async function exportCatalogTemplate(
	exePath: string,
	timeoutMs = 30_000,
): Promise<TemplateLookup> {
	const result = await runCodex(exePath, ["debug", "models"], { timeoutMs });
	if (result.failed) {
		return { error: `${exePath}: ${lastLine(result.stderr) || "could not be started"}` };
	}
	const text = result.stdout.replace(/^\uFEFF/, "").trim();
	if (!text) {
		const detail = lastLine(result.stderr);
		return { error: `${exePath}: no output (exit ${String(result.code)})${detail ? ` — ${detail}` : ""}` };
	}
	// 某些构建会在载荷前加一行 WARNING；从第一个花括号开始解析。
	const start = text.indexOf("{");
	let parsed: unknown;
	try {
		parsed = JSON.parse(start > 0 ? text.slice(start) : text);
	} catch (err) {
		return { error: `${exePath}: unreadable output (${err instanceof Error ? err.message : String(err)})` };
	}
	const models = (parsed as { models?: unknown })?.models;
	if (!Array.isArray(models) || models.length === 0) {
		return { error: `${exePath}: output carries no models array` };
	}
	const entries = models as Array<Record<string, unknown>>;
	return { template: selectCatalogTemplate(entries) };
}

/** 捕获流中最后一行非空内容（Rust panic 里最有用的那一行）。 */
function lastLine(text: string): string {
	const lines = text.trim().split(/\r?\n/).filter((line) => line.trim().length > 0);
	return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

/**
 * 询问 Codex 是否仍接受该配置。写入目录后使用：不合法条目会让 Codex 拒绝
 * 启动，绝不能把它留在磁盘上。检查根本无法运行时按成功处理，扩展不能因为
 * 缺少二进制而卡住。
 */
export async function checkConfigLoads(
	exePath: string,
	codexHome: string,
	timeoutMs = 60_000,
): Promise<{ ok: boolean; detail?: string }> {
	const result = await runCodex(exePath, ["doctor"], { timeoutMs, env: { CODEX_HOME: codexHome } });
	if (result.failed && result.code === null && !result.stdout && !result.stderr) {
		return { ok: true };
	}
	const output = `${result.stdout}\n${result.stderr}`;
	const match = output.match(/^.*config could not be loaded.*$/m);
	if (match) {
		return { ok: false, detail: match[0].trim() };
	}
	return { ok: true };
}
