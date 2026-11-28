/**
 * `~/.claude/settings.json` projection for Claude Code.
 *
 * Claude Code keeps its provider configuration in the same JSON file users fill
 * with hooks, permissions, plugins and status-line commands, and a running
 * session only merges `env` incrementally (`Object.assign(process.env, env)`).
 * Two consequences shape this module:
 *
 *   - never rewrite the file wholesale: touch only the keys this extension
 *     owns, keep every other key, and write through a temp file + rename;
 *   - deleting a key from the file does not undo it in a running session, so a
 *     restore writes `""` first and removes the empty keys a moment later.
 *
 * No `vscode` import: everything here runs in plain Node and is unit tested.
 * The vscode-facing orchestration lives in `claudeCodeService.ts`.
 */

import * as fs from "fs/promises";
import { randomUUID } from "crypto";
import * as os from "os";
import * as path from "path";
import type { MessagesPickerRow } from "./modelRouting";

export const CLAUDE_SETTINGS_FILE = "settings.json";
export const CLAUDE_PICKER_KEY = "modelPicker";

/**
 * `env` keys this extension may write or remove.
 *
 * `ANTHROPIC_API_KEY` is only ever removed: Claude Code treats it as a
 * user-supplied key and asks for confirmation, and having both it and
 * `ANTHROPIC_AUTH_TOKEN` set triggers the "Both ... set" warning.
 */
export const CLAUDE_ENV_KEYS = [
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_FABLE_MODEL",
	"CLAUDE_CODE_SUBAGENT_MODEL",
	"CLAUDE_CODE_MAX_CONTEXT_TOKENS",
	"CLAUDE_CODE_AUTO_MODE_SERVER",
] as const;

export type ClaudeEnvKey = (typeof CLAUDE_ENV_KEYS)[number];

/**
 * Keys a running Claude Code drops when the file holds an empty string.
 * Keys decided at startup (`ENABLE_TOOL_SEARCH`, `CLAUDE_CODE_DISABLE_1M_CONTEXT`)
 * are intentionally absent: a tombstone cannot undo them.
 */
export const CLAUDE_HOT_UNSET_ENV = [
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_DEFAULT_FABLE_MODEL",
	"CLAUDE_CODE_SUBAGENT_MODEL",
	"CLAUDE_CODE_MAX_CONTEXT_TOKENS",
	"CLAUDE_CODE_AUTO_MODE_SERVER",
] as const;

export interface ClaudeSettingsLocation {
	/** Directory holding `settings.json`. */
	dir: string;
	/** Absolute path of `settings.json`. */
	file: string;
}

export interface ClaudeSettingsDocument {
	path: string;
	exists: boolean;
	/** Parsed document; an empty object when the file is missing. */
	document: Record<string, unknown>;
	/** Raw text, for indentation and trailing-newline preservation. */
	text?: string;
}

export interface ClaudeSettingsError extends Error {
	code: "unreadable" | "unparsable" | "invalid-shape";
}

function settingsError(
	code: ClaudeSettingsError["code"],
	message: string,
): ClaudeSettingsError {
	const error = new Error(message) as ClaudeSettingsError;
	error.code = code;
	return error;
}

/**
 * Resolve the settings file: explicit override → `CLAUDE_CONFIG_DIR` →
 * `~/.claude/settings.json`. An override that ends with `.json` is treated as
 * the file itself so a portable setup can point straight at it.
 */
export function resolveClaudeSettingsLocationSync(
	override?: string,
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): ClaudeSettingsLocation {
	const trimmed = override?.trim();
	const asLocation = (target: string): ClaudeSettingsLocation => {
		const resolved = path.resolve(target);
		return /\.json$/i.test(resolved)
			? { dir: path.dirname(resolved), file: resolved }
			: { dir: resolved, file: path.join(resolved, CLAUDE_SETTINGS_FILE) };
	};
	if (trimmed) {
		return asLocation(trimmed);
	}
	const configDir = env.CLAUDE_CONFIG_DIR?.trim();
	if (configDir) {
		return asLocation(configDir);
	}
	return asLocation(path.join(home, ".claude"));
}

/** Read and parse the settings file. Never overwrites an unreadable file. */
export async function readClaudeSettings(
	location: ClaudeSettingsLocation,
): Promise<ClaudeSettingsDocument> {
	let text: string;
	try {
		text = await fs.readFile(location.file, "utf8");
	} catch (error) {
		if (isNotFound(error)) {
			return { path: location.file, exists: false, document: {} };
		}
		throw settingsError(
			"unreadable",
			`Could not read ${location.file}: ${errorMessage(error)}`,
		);
	}
	if (!text.trim()) {
		return { path: location.file, exists: true, document: {}, text };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw settingsError(
			"unparsable",
			`${location.file} is not valid JSON: ${errorMessage(error)}`,
		);
	}
	if (!isRecord(parsed)) {
		throw settingsError(
			"invalid-shape",
			`${location.file} does not contain a JSON object`,
		);
	}
	return { path: location.file, exists: true, document: parsed, text };
}

export interface ClaudeRoleModels {
	opus?: string;
	sonnet?: string;
	haiku?: string;
	fable?: string;
	subagent?: string;
}

export interface ClaudeEnvPlanInput {
	/** Local loopback base URL, without `/v1`. */
	baseUrl: string;
	/** Derived low-value proxy token. */
	proxyToken: string;
	/** `ANTHROPIC_MODEL`; omitted when unset. */
	defaultModel?: string;
	roleModels?: ClaudeRoleModels;
	/** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for sub-1M rows. */
	maxContextTokens?: number;
	/** Gateways need `CLAUDE_CODE_AUTO_MODE_SERVER=0`. */
	gatewayCompat?: boolean;
}

/** Build the `env` entries this extension owns. Empty values are skipped. */
export function buildClaudeEnv(input: ClaudeEnvPlanInput): Record<string, string> {
	const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		throw new Error("baseUrl must not be empty");
	}
	const proxyToken = input.proxyToken.trim();
	if (!proxyToken) {
		throw new Error("proxyToken must not be empty");
	}
	const env: Record<string, string> = {
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: proxyToken,
	};
	const set = (key: ClaudeEnvKey, value: string | undefined): void => {
		const trimmed = value?.trim();
		if (trimmed) {
			env[key] = trimmed;
		}
	};
	set("ANTHROPIC_MODEL", input.defaultModel);
	const roles = input.roleModels ?? {};
	set("ANTHROPIC_DEFAULT_OPUS_MODEL", roles.opus);
	set("ANTHROPIC_DEFAULT_SONNET_MODEL", roles.sonnet);
	set("ANTHROPIC_DEFAULT_HAIKU_MODEL", roles.haiku);
	set("ANTHROPIC_DEFAULT_FABLE_MODEL", roles.fable);
	set("CLAUDE_CODE_SUBAGENT_MODEL", roles.subagent);
	if (input.maxContextTokens && Number.isFinite(input.maxContextTokens)) {
		env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(
			Math.trunc(input.maxContextTokens),
		);
	}
	if (input.gatewayCompat !== false) {
		env.CLAUDE_CODE_AUTO_MODE_SERVER = "0";
	}
	return env;
}

export interface ClaudePickerRowConfig {
	rows: MessagesPickerRow[];
	/** Behaviour profile per model id; empty when `behavesAs` is disabled. */
	profiles?: Record<string, string>;
	replaceBuiltInOptions?: boolean;
}

/** Build the top-level `modelPicker` value. */
export function buildClaudePicker(
	config: ClaudePickerRowConfig,
): Record<string, unknown> {
	const options = config.rows.map((row) => {
		const behavesAs = config.profiles?.[row.model.replace(/\[1m\]$/i, "")];
		return {
			model: row.model,
			label: row.label,
			description: row.description,
			...(behavesAs ? { behavesAs } : {}),
		};
	});
	return {
		replaceBuiltInOptions: config.replaceBuiltInOptions !== false,
		options,
	};
}

export interface ClaudeEnvChange {
	key: string;
	/** Previous value, or undefined when the key was absent. */
	before?: string;
	/** New value, or undefined when the key is removed. */
	after?: string;
}

export interface ClaudeSettingsUpdate {
	next: Record<string, unknown>;
	envChanges: ClaudeEnvChange[];
	pickerChanged: boolean;
	/** `ANTHROPIC_API_KEY` was present and is being removed. */
	apiKeyRemoved: boolean;
	changed: boolean;
}

/**
 * Compute the target document. Only `env` entries from {@link buildClaudeEnv},
 * the removal of `ANTHROPIC_API_KEY`, and `modelPicker` are touched.
 */
export function planClaudeSettingsUpdate(
	current: Record<string, unknown>,
	env: Record<string, string>,
	picker: Record<string, unknown> | undefined,
	options?: { removeApiKey?: boolean },
): ClaudeSettingsUpdate {
	const next = cloneRecord(current);
	const currentEnv = next.env;
	if (currentEnv !== undefined && !isRecord(currentEnv)) {
		throw settingsError(
			"invalid-shape",
			"`env` in Claude Code settings is not an object, refusing to modify it",
		);
	}
	const envObject: Record<string, unknown> = isRecord(currentEnv)
		? { ...currentEnv }
		: {};
	const envChanges: ClaudeEnvChange[] = [];
	const apply = (key: string, value: string | undefined): void => {
		const before = typeof envObject[key] === "string" ? (envObject[key] as string) : undefined;
		if (value === undefined) {
			if (!(key in envObject)) {
				return;
			}
			delete envObject[key];
			envChanges.push({ key, before });
			return;
		}
		if (before === value) {
			return;
		}
		envObject[key] = value;
		envChanges.push({ key, before, after: value });
	};

	for (const key of Object.keys(env)) {
		apply(key, env[key]);
	}
	const apiKeyRemoved =
		options?.removeApiKey !== false &&
		typeof envObject.ANTHROPIC_API_KEY === "string" &&
		envObject.ANTHROPIC_API_KEY.trim().length > 0;
	if (options?.removeApiKey !== false) {
		apply("ANTHROPIC_API_KEY", undefined);
	}

	if (Object.keys(envObject).length > 0) {
		next.env = envObject;
	} else if ("env" in next) {
		next.env = envObject;
	}

	let pickerChanged = false;
	if (picker !== undefined) {
		pickerChanged = !deepEqual(next[CLAUDE_PICKER_KEY], picker);
		next[CLAUDE_PICKER_KEY] = picker;
	}

	return {
		next,
		envChanges,
		pickerChanged,
		apiKeyRemoved,
		changed: envChanges.length > 0 || pickerChanged,
	};
}

export interface ClaudeOwnedValue {
	present: boolean;
	value?: string;
}

export interface ClaudeOwnership {
	settingsPath: string;
	createdAt: string;
	baseUrl: string;
	env: Record<string, ClaudeOwnedValue>;
	picker?: { present: boolean; value?: unknown };
	appliedEnv: Record<string, string>;
	appliedPicker?: unknown;
}

/** Snapshot the previous values of every key the update may touch. */
export function captureClaudeOwnership(
	document: Record<string, unknown>,
	update: ClaudeSettingsUpdate,
	baseUrl: string,
	settingsPath: string,
	now = new Date(),
): ClaudeOwnership {
	const currentEnv = isRecord(document.env) ? document.env : {};
	const env: Record<string, ClaudeOwnedValue> = {};
	for (const change of update.envChanges) {
		const value = currentEnv[change.key];
		env[change.key] = typeof value === "string"
			? { present: true, value }
			: { present: false };
	}
	const appliedEnv: Record<string, string> = {};
	for (const change of update.envChanges) {
		if (typeof change.after === "string") {
			appliedEnv[change.key] = change.after;
		}
	}
	const pickerValue = document[CLAUDE_PICKER_KEY];
	const ownership: ClaudeOwnership = {
		settingsPath,
		createdAt: now.toISOString(),
		baseUrl,
		env,
		appliedEnv,
	};
	if (update.pickerChanged) {
		ownership.picker = pickerValue === undefined
			? { present: false }
			: { present: true, value: pickerValue };
		ownership.appliedPicker = update.next[CLAUDE_PICKER_KEY];
	}
	return ownership;
}

export interface ClaudeRestorePlan {
	next: Record<string, unknown>;
	restored: string[];
	skipped: string[];
	tombstones: string[];
	changed: boolean;
}

/**
 * Three-way restore: a key is only reverted while it still holds the value this
 * extension wrote, so edits the user made in the meantime survive.
 */
export function planClaudeRestore(
	current: Record<string, unknown>,
	ownership: ClaudeOwnership,
): ClaudeRestorePlan {
	const next = cloneRecord(current);
	const currentEnv = next.env;
	if (currentEnv !== undefined && !isRecord(currentEnv)) {
		throw settingsError(
			"invalid-shape",
			"`env` in Claude Code settings is not an object, refusing to modify it",
		);
	}
	const envObject: Record<string, unknown> = isRecord(currentEnv)
		? { ...currentEnv }
		: {};
	const restored: string[] = [];
	const skipped: string[] = [];
	const tombstones: string[] = [];

	for (const [key, prior] of Object.entries(ownership.env)) {
		const applied = ownership.appliedEnv[key];
		const currentValue =
			typeof envObject[key] === "string" ? (envObject[key] as string) : undefined;
		if (currentValue !== applied) {
			skipped.push(key);
			continue;
		}
		if (prior.present && typeof prior.value === "string") {
			envObject[key] = prior.value;
			restored.push(key);
			continue;
		}
		if (CLAUDE_HOT_UNSET_ENV.includes(key as (typeof CLAUDE_HOT_UNSET_ENV)[number])) {
			envObject[key] = "";
			tombstones.push(key);
		} else {
			delete envObject[key];
		}
		restored.push(key);
	}

	if (Object.keys(envObject).length > 0 || "env" in next) {
		next.env = envObject;
	}

	let pickerChanged = false;
	if (ownership.picker) {
		const currentPicker = next[CLAUDE_PICKER_KEY];
		const stillOurs = deepEqual(currentPicker, ownership.appliedPicker);
		if (!stillOurs) {
			skipped.push(CLAUDE_PICKER_KEY);
		} else if (ownership.picker.present) {
			next[CLAUDE_PICKER_KEY] = ownership.picker.value;
			restored.push(CLAUDE_PICKER_KEY);
			pickerChanged = true;
		} else {
			delete next[CLAUDE_PICKER_KEY];
			restored.push(CLAUDE_PICKER_KEY);
			pickerChanged = true;
		}
	}

	return {
		next,
		restored,
		skipped,
		tombstones,
		changed: restored.length > 0 || tombstones.length > 0 || pickerChanged,
	};
}

export interface ClaudeWriteResult {
	changed: boolean;
	backupPath?: string;
}

/**
 * Write the document atomically: temp file in the same directory, then rename.
 * A timestamped backup is taken before the first real change.
 */
export async function writeClaudeSettings(
	location: ClaudeSettingsLocation,
	document: Record<string, unknown>,
	options?: { maxBackups?: number; currentText?: string; currentExists?: boolean },
): Promise<ClaudeWriteResult> {
	const text = `${JSON.stringify(document, null, detectIndent(options?.currentText))}\n`;
	if (options?.currentExists && options.currentText === text) {
		return { changed: false };
	}
	let backupPath: string | undefined;
	if (options?.currentExists) {
		backupPath = await backupClaudeSettings(location.file);
	}
	await fs.mkdir(location.dir, { recursive: true });
	const temp = path.join(
		location.dir,
		`.${path.basename(location.file)}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`,
	);
	await fs.writeFile(temp, text, "utf8");
	try {
		// Validate before it can replace the real file.
		JSON.parse(await fs.readFile(temp, "utf8"));
		await fs.rename(temp, location.file);
	} catch (error) {
		await fs.unlink(temp).catch(() => undefined);
		throw error;
	}
	await pruneClaudeBackups(location.dir, options?.maxBackups ?? 5);
	return { changed: true, backupPath };
}

/** Remove tombstone keys that still hold an empty string. */
export async function sweepClaudeTombstones(
	location: ClaudeSettingsLocation,
	keys: readonly string[],
): Promise<string[]> {
	if (keys.length === 0) {
		return [];
	}
	const read = await readClaudeSettings(location);
	if (!read.exists || !isRecord(read.document.env)) {
		return [];
	}
	const envObject = { ...read.document.env };
	const removed: string[] = [];
	for (const key of keys) {
		if (envObject[key] === "") {
			delete envObject[key];
			removed.push(key);
		}
	}
	if (removed.length === 0) {
		return [];
	}
	const next = { ...read.document, env: envObject };
	await writeClaudeSettings(location, next, {
		currentText: read.text,
		currentExists: true,
	});
	return removed;
}

async function backupClaudeSettings(file: string): Promise<string> {
	const stamp = stampFor(new Date());
	let target = `${file}.bak-${stamp}`;
	let counter = 1;
	while (await pathExists(target)) {
		target = `${file}.bak-${stamp}-${counter++}`;
	}
	await fs.copyFile(file, target);
	return target;
}

async function pruneClaudeBackups(dir: string, keep: number): Promise<number> {
	let removed = 0;
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return 0;
	}
	const backups = entries
		.filter((name) => name.startsWith(`${CLAUDE_SETTINGS_FILE}.bak-`))
		.sort()
		.reverse();
	for (const name of backups.slice(Math.max(keep, 1))) {
		try {
			await fs.unlink(path.join(dir, name));
			removed++;
		} catch {
			// A locked backup is not worth failing the write.
		}
	}
	return removed;
}

function detectIndent(text: string | undefined): string {
	if (!text) {
		return "\t";
	}
	const match = /\n([ \t]+)"/.exec(text);
	return match?.[1] || "\t";
}

function stampFor(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: string }).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
