/**
 * Locate the Claude Code CLI and read its version.
 *
 * `modelPicker` (v2.1.242), `behavesAs` (v2.1.257) and per-model
 * `autoCompactWindow` (v2.1.288) are gated by version, so the settings writer
 * must know what the installed client supports. Detection is best effort: an
 * unknown version only downgrades the configuration, it never blocks it.
 *
 * No `vscode` import: this module runs in plain Node.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface ClaudeVersionInfo {
	executable?: string;
	version?: string;
	raw?: string;
	error?: string;
}

export const MODEL_PICKER_MIN_VERSION = "2.1.242";
export const BEHAVES_AS_MIN_VERSION = "2.1.257";
export const PER_MODEL_WINDOW_MIN_VERSION = "2.1.288";

/** Claude Code shims. Windows installs `.cmd` through npm, so a bare name misses it. */
export function claudeExecutableNames(
	platform: NodeJS.Platform = process.platform,
): string[] {
	return platform === "win32"
		? ["claude.cmd", "claude.exe", "claude.bat"]
		: ["claude"];
}

/** Candidate executables, most explicit first. */
export function findClaudeExecutables(
	explicitPath?: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (candidate: string | undefined): void => {
		const trimmed = candidate?.trim();
		if (!trimmed) {
			return;
		}
		const key = trimmed.toLowerCase();
		if (seen.has(key) || !isFile(trimmed)) {
			return;
		}
		seen.add(key);
		candidates.push(trimmed);
	};

	push(explicitPath);
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir.trim()) {
			continue;
		}
		for (const name of claudeExecutableNames(platform)) {
			push(path.join(dir, name));
		}
	}
	// Native installations and npm global prefixes that are not always on PATH.
	for (const dir of nativeInstallDirs(platform, env, home)) {
		for (const name of claudeExecutableNames(platform)) {
			push(path.join(dir, name));
		}
		push(path.join(dir, "claude"));
	}
	return candidates;
}

function nativeInstallDirs(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	home: string,
): string[] {
	const dirs = [path.join(home, ".claude", "local"), path.join(home, ".local", "bin")];
	if (platform === "win32") {
		const appData = env.APPDATA?.trim();
		if (appData) {
			dirs.push(path.join(appData, "npm"));
		}
		const localAppData = env.LOCALAPPDATA?.trim();
		if (localAppData) {
			dirs.push(path.join(localAppData, "Programs", "claude"));
		}
	} else {
		dirs.push(path.join(home, ".npm-global", "bin"));
	}
	return dirs;
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** Parse the first semantic version in `claude --version` output. */
export function parseClaudeVersion(text: string): string | undefined {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
	if (!match) {
		return undefined;
	}
	return `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
}

/** Numeric semantic-version comparison; missing segments count as zero. */
export function compareVersions(left: string, right: string): number {
	const parse = (value: string): number[] =>
		value
			.split(".")
			.slice(0, 3)
			.map((part) => {
				const parsed = Number.parseInt(part, 10);
				return Number.isFinite(parsed) ? parsed : 0;
			});
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) {
			return difference > 0 ? 1 : -1;
		}
	}
	return 0;
}

/** Unknown versions are treated as "too old" so the writer stays conservative. */
export function versionAtLeast(
	version: string | undefined,
	minimum: string,
): boolean {
	if (!version) {
		return false;
	}
	return compareVersions(version, minimum) >= 0;
}

export function supportsModelPicker(version: string | undefined): boolean {
	return versionAtLeast(version, MODEL_PICKER_MIN_VERSION);
}

export function supportsBehavesAs(version: string | undefined): boolean {
	return versionAtLeast(version, BEHAVES_AS_MIN_VERSION);
}

export function supportsPerModelWindow(version: string | undefined): boolean {
	return versionAtLeast(version, PER_MODEL_WINDOW_MIN_VERSION);
}

/**
 * Run `claude --version` against the first working candidate. Never throws:
 * the caller degrades to role-alias-only configuration.
 */
export async function readClaudeVersion(
	explicitPath?: string,
	timeoutMs = 15_000,
): Promise<ClaudeVersionInfo> {
	const candidates = findClaudeExecutables(explicitPath);
	if (candidates.length === 0) {
		return { error: "Claude Code CLI not found on PATH" };
	}
	const failures: string[] = [];
	for (const executable of candidates) {
		const result = await runVersion(executable, timeoutMs);
		if (result.version) {
			return { executable, version: result.version, raw: result.raw };
		}
		failures.push(`${executable}: ${result.error ?? "no version in output"}`);
	}
	return { error: failures.join("; ") };
}

async function runVersion(
	executable: string,
	timeoutMs: number,
): Promise<{ version?: string; raw?: string; error?: string }> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (value: { version?: string; raw?: string; error?: string }): void => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(value);
			}
		};
		// `.cmd` shims on Windows need a shell; quoting keeps spaces in the path.
		const useShell = process.platform === "win32";
		const command = useShell ? `"${executable}"` : executable;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, ["--version"], {
				shell: useShell,
				env: process.env,
				windowsHide: true,
			});
		} catch (error) {
			resolve({ error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			finish({ error: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			finish({ error: error.message });
		});
		child.on("close", () => {
			const raw = `${stdout}\n${stderr}`.trim();
			const version = parseClaudeVersion(raw);
			finish(version ? { version, raw } : { raw, error: "no version in output" });
		});
	});
}
