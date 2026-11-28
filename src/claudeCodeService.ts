/**
 * Claude Code integration: write the loopback provider into
 * `~/.claude/settings.json`, keep `modelPicker` in step with the catalog, and
 * restore everything this extension touched.
 *
 * Design rules (hard-won from cc-switch's live measurements):
 *   - the real OpenCode key never leaves SecretStorage; Claude Code only gets
 *     the derived loopback token;
 *   - only owned keys are written, everything else in the file survives;
 *   - `ANTHROPIC_API_KEY` is removed on takeover (having both auth keys set
 *     makes Claude Code ask for confirmation and warn);
 *   - a restore reverts keys only while they still hold the value we wrote,
 *     and removes deleted keys through an empty-string tombstone because a
 *     running session merges `env` incrementally.
 */

import * as path from "path";
import * as vscode from "vscode";
import {
	buildClaudeEnv,
	buildClaudePicker,
	captureClaudeOwnership,
	planClaudeRestore,
	planClaudeSettingsUpdate,
	readClaudeSettings,
	resolveClaudeSettingsLocationSync,
	sweepClaudeTombstones,
	writeClaudeSettings,
	type ClaudeOwnership,
	type ClaudeSettingsDocument,
	type ClaudeSettingsLocation,
	type ClaudeSettingsUpdate,
} from "./claudeSettings";
import {
	readClaudeVersion,
	supportsBehavesAs,
	supportsModelPicker,
	type ClaudeVersionInfo,
} from "./claudeCodeCli";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { isChatModel } from "./modelCenterData";
import {
	buildMessagesPickerRows,
	messagesContextFloor,
	suggestClaudeProfile,
	type PickerModelInput,
} from "./modelRouting";
import {
	ensureOfficialCatalogLoadedOnce,
	getOfficialCatalogSnapshot,
} from "./officialCatalog";
import {
	ensureProxyStarted,
	getProxyProviderAuth,
	isProxyActive,
} from "./proxyController";

export interface ClaudeCodeContext {
	secrets: vscode.SecretStorage;
	globalState: vscode.Memento;
}

const OWNERSHIP_KEY = "codexgo.claudeCodeOwnership.v1";
const TOMBSTONE_DELAY_MS = 3000;

/** Cheapest capable defaults, first match wins when the user has not chosen. */
const DEFAULT_MODEL_PREFERENCES = [
	"deepseek-v4.1-flash",
	"glm-5.3-flash",
	"minimax-m3.1-flash",
	"kimi-k3",
];

/** Fast models for background tasks (the Haiku tier). */
const HAIKU_MODEL_PREFERENCES = [
	"glm-5.3-flash",
	"minimax-m3.1-flash",
	"mimo-v2.6-flash",
	"deepseek-v4.1-flash",
];

type ApplyScope = "all" | "picker";

/** Write (or refresh) the Claude Code integration. */
export async function configureClaudeCode(
	context: ClaudeCodeContext,
): Promise<void> {
	await applyIntegration(context, "all");
}

/** Rebuild `modelPicker` after the catalog changed, without touching auth. */
export async function refreshClaudeCodePicker(
	context: ClaudeCodeContext,
): Promise<void> {
	await applyIntegration(context, "picker");
}

/** Restore the keys this extension wrote. */
export async function restoreClaudeCode(
	context: ClaudeCodeContext,
): Promise<void> {
	const ownership = readOwnership(context.globalState);
	if (!ownership) {
		void vscode.window.showInformationMessage(
			l10n("No Claude Code settings were written by this extension."),
		);
		return;
	}
	const location = locationFromPath(ownership.settingsPath);
	let document: ClaudeSettingsDocument;
	try {
		document = await readClaudeSettings(location);
	} catch (error) {
		void vscode.window.showErrorMessage(
			l10nFormat(
				"Claude Code settings could not be read: {0}",
				error instanceof Error ? error.message : String(error),
			),
		);
		return;
	}
	let plan: ReturnType<typeof planClaudeRestore>;	try {
		plan = planClaudeRestore(document.document, ownership);
	} catch (error) {
		void vscode.window.showErrorMessage(
			l10nFormat(
				"Claude Code settings could not be restored: {0}",
				error instanceof Error ? error.message : String(error),
			),
		);
		return;
	}
	if (!plan.changed) {
		await context.globalState.update(OWNERSHIP_KEY, undefined);
		void vscode.window.showInformationMessage(
			plan.skipped.length > 0
				? l10nFormat(
						"Left unchanged because you edited them: {0}.",
						plan.skipped.join(", "),
					)
				: l10n("Claude Code settings were not changed."),
		);
		return;
	}
	try {
		await writeClaudeSettings(location, plan.next, {
			maxBackups: maxBackups(),
			currentText: document.text,
			currentExists: document.exists,
		});
	} catch (error) {
		void vscode.window.showErrorMessage(
			l10nFormat(
				"Claude Code settings could not be written: {0}",
				error instanceof Error ? error.message : String(error),
			),
		);
		return;
	}
	await context.globalState.update(OWNERSHIP_KEY, undefined);
	scheduleTombstoneSweep(location, plan.tombstones);
	logger.info("claudeCode.restored", {
		path: location.file,
		restored: plan.restored,
		skipped: plan.skipped,
		tombstones: plan.tombstones,
	});
	const parts = [l10nFormat("Restored Claude Code settings: {0}.", plan.restored.join(", ") || "-")];
	if (plan.skipped.length > 0) {
		parts.push(
			l10nFormat("Left unchanged because you edited them: {0}.", plan.skipped.join(", ")),
		);
	}
	parts.push(
		l10n(
			"Reload the Claude Code session or the VS Code window so the change takes effect.",
		),
	);
	void vscode.window
		.showInformationMessage(parts.join(" "), l10n("Reload window"))
		.then((picked) => {
			if (picked === l10n("Reload window")) {
				void vscode.commands.executeCommand("workbench.action.reloadWindow");
			}
		});
}

/**
 * Called on activation. Never rewrites settings silently: if the proxy address
 * or token we wrote earlier no longer matches, offer a one-click repair.
 */
export async function maybeRepairClaudeCodeIntegration(
	context: ClaudeCodeContext,
): Promise<void> {
	const ownership = readOwnership(context.globalState);
	if (!ownership) {
		return;
	}
	const location = locationFromPath(ownership.settingsPath);
	let document: ClaudeSettingsDocument;
	try {
		document = await readClaudeSettings(location);
	} catch {
		return;
	}
	const currentEnv =
		typeof document.document.env === "object" && document.document.env !== null
			? (document.document.env as Record<string, unknown>)
			: {};
	if (currentEnv.ANTHROPIC_BASE_URL !== ownership.appliedEnv.ANTHROPIC_BASE_URL) {
		// The user (or another tool) took the file over; stop tracking it.
		await context.globalState.update(OWNERSHIP_KEY, undefined);
		return;
	}
	const auth = await getProxyProviderAuth(context.secrets);
	if (!auth) {
		return;
	}
	const baseUrl = claudeBaseUrl(auth.baseUrl);
	if (baseUrl === ownership.appliedEnv.ANTHROPIC_BASE_URL) {
		return;
	}
	const configure = l10n("Update Claude Code settings");
	const picked = await vscode.window.showWarningMessage(
		l10nFormat(
			"Claude Code still points at the previous proxy address ({0}).",
			ownership.appliedEnv.ANTHROPIC_BASE_URL ?? "",
		),
		configure,
	);
	if (picked === configure) {
		await configureClaudeCode(context);
	}
}

/** Markdown report used by the diagnostics command. */
export async function showClaudeCodeDiagnostics(
	context: ClaudeCodeContext,
): Promise<void> {
	const lines: string[] = ["# OpenCode Go for Codex — Claude Code diagnostics", ""];
	const ownership = readOwnership(context.globalState);
	const location = resolveLocation(ownership);
	lines.push(`- ${l10n("Claude Code settings path")}: \`${location.file}\``);
	lines.push(`- ${l10n("Owned by this extension")}: ${ownership ? "yes" : "no"}`);
	if (ownership) {
		lines.push(`  - since ${ownership.createdAt}`);
		lines.push(
			`  - ${l10n("Owned keys")}: ${Object.keys(ownership.appliedEnv).join(", ") || "-"}`,
		);
	}
	const auth = await getProxyProviderAuth(context.secrets);
	lines.push(`- ${l10n("Local proxy")}: ${isProxyActive() ? "listening" : "not owned by this window"}`);
	if (auth) {
		lines.push(`  - ${l10n("Proxy base URL")}: \`${claudeBaseUrl(auth.baseUrl)}\``);
	}
	try {
		const document = await readClaudeSettings(location);
		const picker = document.document.modelPicker;
		const rows =
			typeof picker === "object" && picker !== null && Array.isArray((picker as { options?: unknown[] }).options)
				? ((picker as { options: unknown[] }).options.length)
				: 0;
		lines.push(`- ${l10n("Model picker rows")}: ${rows}`);
		lines.push(`- ${l10n("Claude Code settings exist")}: ${document.exists ? "yes" : "no"}`);
	} catch (error) {
		lines.push(
			`- ${l10nFormat(
				"Claude Code settings could not be read: {0}",
				error instanceof Error ? error.message : String(error),
			)}`,
		);
	}
	const version = await readClaudeVersion(configuredExecutable());
	lines.push(
		`- Claude Code CLI: ${version.version ? `v${version.version}` : version.error ?? "unknown"}`,
	);
	lines.push(
		`  - modelPicker: ${supportsModelPicker(version.version) ? "supported" : "not supported"}`,
	);
	lines.push(
		`  - behavesAs: ${supportsBehavesAs(version.version) ? "supported" : "not supported"}`,
	);
	const document = await vscode.workspace.openTextDocument({
		language: "markdown",
		content: `${lines.join("\n")}\n`,
	});
	await vscode.window.showTextDocument(document, { preview: true });
}

async function applyIntegration(
	context: ClaudeCodeContext,
	scope: ApplyScope,
): Promise<void> {
	await ensureProxyStarted(false);
	const auth = await getProxyProviderAuth(context.secrets);
	if (!auth) {
		const setKey = l10n("Set API Key");
		const picked = await vscode.window.showWarningMessage(
			l10n("Set an OpenCode Go API key before configuring Claude Code."),
			setKey,
		);
		if (picked === setKey) {
			await vscode.commands.executeCommand("codexgo.setApiKey");
		}
		return;
	}
	const models = await loadCatalogModels();
	if (models.length === 0) {
		void vscode.window.showErrorMessage(
			l10n("Could not load the OpenCode Go model catalog. Try again in a minute."),
		);
		return;
	}

	const version = await readClaudeVersion(configuredExecutable());
	// An unknown version (CLI not on PATH) still gets the picker: the VS Code
	// extension bundles a recent Claude Code. Only a known-too-old client skips it.
	const pickerSupported =
		!version.version || supportsModelPicker(version.version);
	const useBehavesAs =
		vscode.workspace
			.getConfiguration("codexgo.claudeCode")
			.get<boolean>("useBehavesAs", false) &&
		(!version.version || supportsBehavesAs(version.version));
	const replaceBuiltInOptions = vscode.workspace
		.getConfiguration("codexgo.claudeCode")
		.get<boolean>("replaceBuiltInPicker", true);
	const rows = buildMessagesPickerRows(models);
	const profiles: Record<string, string> = {};
	if (useBehavesAs) {
		for (const model of models) {
			profiles[model.id] = suggestClaudeProfile({ efforts: model.efforts });
		}
	}
	const picker = pickerSupported
		? buildClaudePicker({
				rows,
				profiles: useBehavesAs ? profiles : undefined,
				replaceBuiltInOptions,
			})
		: undefined;

	const env =
		scope === "all"
			? buildClaudeEnv({
					baseUrl: claudeBaseUrl(auth.baseUrl),
					proxyToken: auth.bearerToken,
					defaultModel:
						configuredRole("defaultModel") ?? pickPreferred(models, DEFAULT_MODEL_PREFERENCES) ?? models[0]?.id,
					roleModels: {
						opus: configuredRole("opusModel"),
						sonnet: configuredRole("sonnetModel"),
						haiku: configuredRole("haikuModel") ?? pickPreferred(models, HAIKU_MODEL_PREFERENCES),
						fable: configuredRole("fableModel"),
						subagent: configuredRole("subagentModel"),
					},
					maxContextTokens: messagesContextFloor(models),
				})
			: {};

	const location = resolveLocation(readOwnership(context.globalState));
	let document: ClaudeSettingsDocument;
	try {
		document = await readClaudeSettings(location);
	} catch (error) {
		void vscode.window.showErrorMessage(
			l10nFormat(
				"Claude Code settings could not be read: {0}",
				error instanceof Error ? error.message : String(error),
			),
		);
		return;
	}
	let update: ClaudeSettingsUpdate;
	try {
		update = planClaudeSettingsUpdate(document.document, env, picker, {
			removeApiKey: scope === "all",
		});
	} catch (error) {
		void vscode.window.showErrorMessage(
			l10nFormat(
				"Claude Code settings could not be updated: {0}",
				error instanceof Error ? error.message : String(error),
			),
		);
		return;
	}
	if (!update.changed) {
		void vscode.window.showInformationMessage(
			l10n("Claude Code settings are already up to date."),
		);
		return;
	}

	const previous = readOwnership(context.globalState);
	const ownership = captureClaudeOwnership(
		document.document,
		update,
		claudeBaseUrl(auth.baseUrl),
		location.file,
	);
	mergeOwnership(ownership, previous, location.file);

	let result: Awaited<ReturnType<typeof writeClaudeSettings>>;
	try {
		result = await writeClaudeSettings(location, update.next, {
			maxBackups: maxBackups(),
			currentText: document.text,
			currentExists: document.exists,
		});
	} catch (error) {
		void vscode.window.showErrorMessage(
			l10nFormat(
				"Claude Code settings could not be written: {0}",
				error instanceof Error ? error.message : String(error),
			),
		);
		return;
	}
	await context.globalState.update(OWNERSHIP_KEY, ownership);
	logger.info("claudeCode.applied", {
		path: location.file,
		scope,
		envKeys: update.envChanges.map((change) => change.key),
		pickerRows: rows.length,
		pickerSupported,
		behavesAs: useBehavesAs,
		backup: result.backupPath,
		version: version.version,
	});

	const parts: string[] = [];
	parts.push(
		scope === "picker"
			? l10nFormat("Rebuilt the Claude Code model list with {0} models.", String(rows.length))
			: l10nFormat(
					"Configured Claude Code for OpenCode Go ({0} models).",
					String(rows.length),
				),
	);
	if (update.apiKeyRemoved) {
		parts.push(
			l10n(
				"Removed ANTHROPIC_API_KEY so Claude Code does not treat the proxy token as a custom key.",
			),
		);
	}
	if (!pickerSupported) {
		parts.push(
			l10n(
				"Claude Code 2.1.242 or newer is required for the model list, so only the role aliases were written.",
			),
		);
	}
	parts.push(
		l10n(
			"Reload the Claude Code session or the VS Code window so Claude Code picks up the new provider settings.",
		),
	);
	const reload = l10n("Reload window");
	void vscode.window.showInformationMessage(parts.join(" "), reload).then((picked) => {
		if (picked === reload) {
			void vscode.commands.executeCommand("workbench.action.reloadWindow");
		}
	});
}

interface CatalogModel extends PickerModelInput {
	efforts?: string[];
}

async function loadCatalogModels(): Promise<CatalogModel[]> {
	try {
		await ensureOfficialCatalogLoadedOnce();
	} catch (error) {
		logger.warn("claudeCode.catalog.failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	const snapshot = getOfficialCatalogSnapshot();
	return (snapshot?.models ?? [])
		.filter((model) => isChatModel(model))
		.map((model) => ({
			id: model.id,
			name: model.name,
			contextLength: model.contextLimit,
			wireApi: undefined,
			deprecated: model.deprecated,
			efforts: modelEfforts(model),
		}));
}

function modelEfforts(model: { capabilities?: Record<string, unknown> }): string[] | undefined {
	const reasoning = model.capabilities?.reasoning;
	if (typeof reasoning !== "object" || reasoning === null) {
		return undefined;
	}
	const effort = (reasoning as Record<string, unknown>).effort;
	return Array.isArray(effort)
		? effort.filter((value): value is string => typeof value === "string")
		: undefined;
}

function pickPreferred(models: CatalogModel[], preferences: string[]): string | undefined {
	for (const candidate of preferences) {
		if (models.some((model) => model.id === candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function claudeBaseUrl(proxyBaseUrl: string): string {
	return proxyBaseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function configuredExecutable(): string | undefined {
	const value = vscode.workspace
		.getConfiguration("codexgo.claudeCode")
		.get<string>("executable", "")
		.trim();
	return value || undefined;
}

function configuredRole(key: string): string | undefined {
	const value = vscode.workspace
		.getConfiguration("codexgo.claudeCode")
		.get<string>(key, "")
		.trim();
	return value || undefined;
}

function maxBackups(): number {
	const value = vscode.workspace
		.getConfiguration("codexgo")
		.get<number>("maxBackups", 5);
	return Number.isFinite(value) ? Math.max(1, Math.min(50, Math.trunc(value))) : 5;
}

function resolveLocation(ownership: ClaudeOwnership | undefined): ClaudeSettingsLocation {
	if (ownership?.settingsPath) {
		return locationFromPath(ownership.settingsPath);
	}
	const override = vscode.workspace
		.getConfiguration("codexgo.claudeCode")
		.get<string>("settingsPath", "");
	return resolveClaudeSettingsLocationSync(override);
}

function locationFromPath(file: string): ClaudeSettingsLocation {
	return { dir: path.dirname(file), file };
}

function readOwnership(globalState: vscode.Memento): ClaudeOwnership | undefined {
	const raw = globalState.get<ClaudeOwnership>(OWNERSHIP_KEY);
	if (!raw || typeof raw.settingsPath !== "string" || typeof raw.env !== "object") {
		return undefined;
	}
	return raw;
}

/** Whether this extension currently owns the Claude Code settings file. */
export function isClaudeCodeConfigured(globalState: vscode.Memento): boolean {
	return Boolean(readOwnership(globalState));
}

/**
 * Keep the original pre-takeover values when the user configures twice: the
 * restore must return the file to the state before the first takeover, not to
 * the state after the first one.
 */
function mergeOwnership(
	next: ClaudeOwnership,
	previous: ClaudeOwnership | undefined,
	settingsPath: string,
): void {
	if (!previous || previous.settingsPath !== settingsPath) {
		return;
	}
	for (const [key, value] of Object.entries(previous.env)) {
		if (!(key in next.env)) {
			next.env[key] = value;
			if (typeof previous.appliedEnv[key] === "string") {
				next.appliedEnv[key] = previous.appliedEnv[key];
			}
		}
	}
	if (previous.picker && !next.picker) {
		next.picker = previous.picker;
		next.appliedPicker = previous.appliedPicker;
	}
}

function scheduleTombstoneSweep(
	location: ClaudeSettingsLocation,
	keys: readonly string[],
): void {
	if (keys.length === 0) {
		return;
	}
	setTimeout(() => {
		void sweepClaudeTombstones(location, keys)
			.then((removed) => {
				if (removed.length > 0) {
					logger.info("claudeCode.tombstones.removed", { path: location.file, removed });
				}
			})
			.catch((error) => {
				logger.warn("claudeCode.tombstones.failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}, TOMBSTONE_DELAY_MS);
}
