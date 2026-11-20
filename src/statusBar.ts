/**
 * Unified OpenCode Go status bar item.
 *
 * The item shows the selected usage window. Clicking it refreshes usage;
 * the local proxy has no user-facing control and is managed in the background.
 */

import * as vscode from "vscode";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { getUsageStore } from "./usageService";
import { resolveApiKey } from "./apiKey";
import {
	clearUsageCache,
	formatDuration,
	formatProgressBarHtml,
	formatResetDuration,
	formatUsagePercent,
	formatUsageSummary,
	getGoUsageCached,
	getUsageErrorDetail,
	getUsageFetchStatus,
	getUsageSnapshot,
	GoUsageResult,
	GoUsageWindow,
} from "./goUsage";

let secrets: vscode.SecretStorage | undefined;
let usageItem: vscode.StatusBarItem | undefined;
let usageTimer: NodeJS.Timeout | undefined;
let renderTimer: NodeJS.Timeout | undefined;
let usageRefreshInFlight = false;
let usageKeyFingerprint: string | undefined;

type UsageWindowKey = "rolling" | "weekly" | "monthly";
type UsageItemState = "loading" | "setup" | "auth" | "error" | "active";

export interface UsageQuotaWindowView {
	key: UsageWindowKey;
	label: string;
	percent: number;
	percentText: string;
	resetText?: string;
}

export interface UsageQuotaPanelState {
	state: UsageItemState;
	windows: UsageQuotaWindowView[];
	fetchedAt?: number;
	autoRefreshMinutes: number;
	useBalance: boolean;
	errorDetail?: string;
	warningThreshold: number;
	errorThreshold: number;
}

const USAGE_WINDOW_LABELS: Record<UsageWindowKey, string> = {
	rolling: "Rolling",
	weekly: "Weekly",
	monthly: "Monthly",
};

const USAGE_ERROR_COLOR = "#f14c4c";
const USAGE_WARNING_COLOR = "#cca700";

let usageState: UsageItemState = "loading";
const usageListeners = new Set<() => void>();

export function initStatusBar(ctx: vscode.ExtensionContext): void {
	secrets = ctx.secrets;
	usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	usageItem.name = l10n("OpenCode Go status");
	usageItem.command = "codexgo.openUsageDashboard";
	ctx.subscriptions.push(usageItem);
	const usageStore = getUsageStore();
	if (usageStore) {
		ctx.subscriptions.push(usageStore.onDidChange(() => renderUsage()));
	}
	applyUsageSetting();

	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (
				event.affectsConfiguration("codexgo.showUsage") ||
				event.affectsConfiguration("codexgo.usageRefreshInterval") ||
				event.affectsConfiguration("codexgo.usageDisplayWindow") ||
				event.affectsConfiguration("codexgo.usageWarningThreshold") ||
				event.affectsConfiguration("codexgo.usageErrorThreshold")
			) {
				applyUsageSetting();
			}
		}),
	);
	ctx.subscriptions.push(
		vscode.window.onDidChangeActiveColorTheme(() => renderUsage()),
	);
	ctx.subscriptions.push({
		dispose: () => {
			stopUsagePolling();
			stopRenderTicker();
		},
	});
}

function isUsageEnabled(): boolean {
	return vscode.workspace.getConfiguration("codexgo").get<boolean>("showUsage", true);
}

function getUsageRefreshIntervalMs(): number {
	const raw = vscode.workspace.getConfiguration("codexgo").get<number>("usageRefreshInterval", 5);
	const minutes = Number.isFinite(raw) ? raw : 5;
	return Math.min(Math.max(minutes, 1), 60) * 60_000;
}

function getUsageDisplayWindow(): UsageWindowKey {
	const raw = vscode.workspace.getConfiguration("codexgo").get<string>("usageDisplayWindow", "rolling");
	return raw === "weekly" || raw === "monthly" ? raw : "rolling";
}

function clampPercent(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) ? Math.min(Math.max(value as number, 0), 100) : fallback;
}

function getUsageThresholds(): { warning: number; error: number } {
	const config = vscode.workspace.getConfiguration("codexgo");
	const warning = clampPercent(config.get<number>("usageWarningThreshold", 80), 80);
	const error = clampPercent(config.get<number>("usageErrorThreshold", 95), 95);
	return { warning, error: Math.max(warning, error) };
}

function applyUsageSetting(): void {
	if (!usageItem) {
		return;
	}
	if (isUsageEnabled()) {
		startUsagePolling();
	} else {
		stopUsagePolling();
	}
	usageItem.show();
	startRenderTicker();
	renderUsage();
}

function startUsagePolling(): void {
	stopUsagePolling();
	void refreshGoUsage(false);
	const intervalMs = getUsageRefreshIntervalMs();
	usageTimer = setInterval(() => void refreshGoUsage(false), intervalMs);
	logger.debug("goUsage.poll.start", { intervalMs });
}

function stopUsagePolling(): void {
	if (usageTimer) {
		clearInterval(usageTimer);
		usageTimer = undefined;
	}
}

function startRenderTicker(): void {
	if (renderTimer) {
		return;
	}
	renderTimer = setInterval(() => {
		if (usageItem && isUsageEnabled() && usageState === "active") {
			renderUsage();
		}
	}, 60_000);
}

function stopRenderTicker(): void {
	if (renderTimer) {
		clearInterval(renderTimer);
		renderTimer = undefined;
	}
}

function fingerprint(apiKey: string): string {
	return `${apiKey.length}:${apiKey.slice(-4)}`;
}

async function refreshGoUsage(force: boolean): Promise<GoUsageResult | null> {
	if (!usageItem || !secrets || usageRefreshInFlight) {
		return null;
	}
	usageRefreshInFlight = true;
	try {
		const keyInfo = await resolveApiKey(secrets);
		if (!keyInfo.key) {
			usageState = "setup";
			renderUsage();
			return null;
		}
		const keyFingerprint = fingerprint(keyInfo.key);
		if (keyFingerprint !== usageKeyFingerprint) {
			usageKeyFingerprint = keyFingerprint;
			clearUsageCache();
		}
		const usage = await getGoUsageCached(keyInfo.key, force);
		const fetchStatus = getUsageFetchStatus();
		usageState = usage ? "active" : fetchStatus === "unauthorized" ? "auth" : "error";
		renderUsage();
		return usage;
	} finally {
		usageRefreshInFlight = false;
	}
}

function renderUsage(): void {
	renderUsageContent();
	notifyUsageListeners();
}

function renderUsageContent(): void {
	if (!usageItem) {
		return;
	}

	if (!isUsageEnabled()) {
		usageItem.text = l10n("OpenCode Go");
		usageItem.color = undefined;
		usageItem.tooltip = actionTooltip(l10n("OpenCode Go usage is hidden."));
		return;
	}

	switch (usageState) {
		case "setup":
			usageItem.text = l10n("OpenCode Go: add API key");
			usageItem.color = undefined;
			usageItem.tooltip = actionTooltip(
				l10n("No OpenCode Go API key configured. Click to add one."),
			);
			return;
		case "loading":
			usageItem.text = l10n("OpenCode Go: loading...");
			usageItem.color = undefined;
			usageItem.tooltip = actionTooltip(l10n("OpenCode Go usage"));
			return;
		case "auth":
			usageItem.text = l10n("OpenCode Go: invalid key");
			usageItem.color = USAGE_ERROR_COLOR;
			usageItem.tooltip = actionTooltip(
				l10n("The active API key was rejected (401/403). Click to set a new one."),
			);
			return;
		case "error": {
			usageItem.text = l10n("OpenCode Go: error");
			usageItem.color = USAGE_ERROR_COLOR;
			const detail = getUsageErrorDetail();
			usageItem.tooltip = actionTooltip(
				detail
					? l10nFormat("OpenCode Go usage is unavailable: {0}", detail)
					: l10n("Go usage is temporarily unavailable."),
			);
			return;
		}
	}

	const usage = getUsageSnapshot();
	if (!usage) {
		usageState = "loading";
		renderUsageContent();
		return;
	}

	const displayKey = getUsageDisplayWindow();
	const display = usage[displayKey];
	const label = l10n(USAGE_WINDOW_LABELS[displayKey]);
	const percentText = formatUsagePercent(display?.percent, l10n("limit"));
	const reset =
		shouldShowReset(displayKey, display) && display?.resetsAt
			? formatResetDuration(display.resetsAt)
			: "";
	const value = percentText === "?%" || !reset ? percentText : `${percentText} · ${reset}`;
	const cacheText = currentCacheLabel();
	usageItem.text =
		l10nFormat("OpenCode Go {0}: {1}", label, value) +
		(cacheText ? ` · ${cacheText}` : "");

	const worst = Math.max(
		usage.rolling?.percent ?? 0,
		usage.weekly?.percent ?? 0,
		usage.monthly?.percent ?? 0,
	);
	const thresholds = getUsageThresholds();
	usageItem.color =
		worst >= thresholds.error
			? USAGE_ERROR_COLOR
			: worst >= thresholds.warning
				? USAGE_WARNING_COLOR
				: undefined;

	const md = newTooltip();
	md.appendMarkdown(`**${l10nFormat("OpenCode Go - {0} Usage: {1}", label, percentText)}**\n\n`);
	md.appendMarkdown(`| ${l10n("Window")} | ${l10n("Usage")} | ${l10n("Resets in")} |\n`);
	md.appendMarkdown("| --- | --- | ---: |\n");
	for (const key of ["rolling", "weekly", "monthly"] as const) {
		md.appendMarkdown(`${usageRow(key, l10n(USAGE_WINDOW_LABELS[key]), usage[key])}\n`);
	}
	const updated = usage.fetchedAt
		? formatClockTime24(new Date(usage.fetchedAt))
		: "?";
	const refreshInterval = formatDuration((getUsageRefreshIntervalMs() / 60_000) * 60);
	md.appendMarkdown(
		`\n${l10n("Auto refresh:")} **${refreshInterval}**&ensp;·&ensp;` +
			`${l10n("Last updated:")} **${updated}**&ensp;·&ensp;` +
			`[$(pulse) ${l10n("Check usage")}](command:codexgo.checkUsage)\n`,
	);
	if (usage.useBalance) {
		md.appendMarkdown(`\n${l10n("After the Go quota runs out, usage falls back to your balance.")}\n`);
	}
	appendActions(md);
	usageItem.tooltip = md;
}

function actionTooltip(summary?: string): vscode.MarkdownString {
	const md = newTooltip();
	if (summary) {
		md.appendMarkdown(`${summary}\n\n`);
		md.appendMarkdown(`| [$(pulse) ${l10n("Check usage")}](command:codexgo.checkUsage)\n\n`);
	}
	appendActions(md);
	return md;
}

function appendActions(md: vscode.MarkdownString): void {
	md.appendMarkdown(`\n---\n**${l10n("Actions")}**\n\n`);
	md.appendMarkdown(
		`[$(graph) ${l10n("Open usage dashboard")}](command:codexgo.openUsageDashboard)  \n`,
	);
	md.appendMarkdown(`[$(key) ${l10n("Set API key")}](command:codexgo.setApiKey)  \n`);
	md.appendMarkdown(
		`[$(cloud-download) ${l10n("Sync models")}](command:codexgo.syncModelCatalog)  \n`,
	);
	md.appendMarkdown(`[$(file-code) ${l10n("Open config.toml")}](command:codexgo.openCodexConfig)  \n`);
	md.appendMarkdown(
		`[$(refresh) ${l10n("Reload Window")}](command:workbench.action.reloadWindow)`,
	);
}

function newTooltip(): vscode.MarkdownString {
	const md = new vscode.MarkdownString();
	md.isTrusted = true;
	md.supportThemeIcons = true;
	md.supportHtml = true;
	return md;
}

function usageRow(
	key: UsageWindowKey,
	label: string,
	window: GoUsageWindow | undefined,
): string {
	if (!window) {
		return `| ${label} | \`?%\` |  |`;
	}
	const bar = formatProgressBarHtml(window.percent, getProgressBarTheme());
	const percent = formatUsagePercent(window.percent, l10n("limit"));
	const reset =
		shouldShowReset(key, window) && window.resetsAt ? formatResetDuration(window.resetsAt) : "";
	return `| ${label} | ${bar} **${percent}** | ${reset} |`;
}

function getProgressBarTheme(): "light" | "dark" | "highContrast" | "highContrastLight" {
	switch (vscode.window.activeColorTheme.kind) {
		case vscode.ColorThemeKind.Dark:
			return "dark";
		case vscode.ColorThemeKind.HighContrast:
			return "highContrast";
		case vscode.ColorThemeKind.HighContrastLight:
			return "highContrastLight";
		default:
			return "light";
	}
}

function shouldShowReset(key: UsageWindowKey, window: GoUsageWindow | undefined): boolean {
	if (!window) {
		return false;
	}
	return key !== "rolling" || window.percent > 0;
}

function formatClockTime24(date: Date): string {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

export async function refreshGoUsageNow(showSummary = true): Promise<GoUsageResult | null> {
	const usage = await refreshGoUsage(true);
	if (!usage) {
		if (!showSummary) {
			return null;
		}
		const setKey = l10n("Set API Key");
		if (usageState === "setup" || usageState === "auth") {
			const message =
				usageState === "setup"
					? l10n("No OpenCode Go API key configured. Click to add one.")
					: l10n("The active API key was rejected (401/403). Click to set a new one.");
			const picked = await vscode.window.showWarningMessage(message, setKey);
			if (picked === setKey) {
				await vscode.commands.executeCommand("codexgo.setApiKey");
			}
			return null;
		}
		void vscode.window.showWarningMessage(l10n("Go usage is temporarily unavailable."));
		return null;
	}
	const summary = formatUsageSummary(usage, l10n("limit"));
	if (summary && showSummary) {
		void vscode.window.showInformationMessage(l10nFormat("OpenCode Go usage: {0}", summary));
	}
	return usage;
}

export function getUsagePanelState(): UsageQuotaPanelState {
	const usage = getUsageSnapshot();
	const thresholds = getUsageThresholds();
	const windows: UsageQuotaWindowView[] = (
		["rolling", "weekly", "monthly"] as const
	).map((key) => {
		const window = usage?.[key];
		return {
			key,
			label: l10n(USAGE_WINDOW_LABELS[key]),
			percent: window?.percent ?? 0,
			percentText: formatUsagePercent(window?.percent, l10n("limit")),
			resetText:
				window &&
				shouldShowReset(key, window) &&
				window.resetsAt
					? formatResetDuration(window.resetsAt) || undefined
					: undefined,
		};
	});
	return {
		state: usageState,
		windows,
		fetchedAt: usage?.fetchedAt,
		autoRefreshMinutes: Math.round(getUsageRefreshIntervalMs() / 60_000),
		useBalance: usage?.useBalance === true,
		errorDetail: usageState === "error" ? getUsageErrorDetail() : undefined,
		warningThreshold: thresholds.warning,
		errorThreshold: thresholds.error,
	};
}

export function onDidChangeUsageState(listener: () => void): vscode.Disposable {
	usageListeners.add(listener);
	return {
		dispose: () => usageListeners.delete(listener),
	};
}

function notifyUsageListeners(): void {
	for (const listener of usageListeners) {
		try {
			listener();
		} catch {
			// Dashboard listeners must not affect status-bar rendering.
		}
	}
}

function currentCacheLabel(): string {
	const cache = getUsageStore()?.getStatusSummary();
	if (!cache || cache.requests === 0 || cache.cacheHitRate === null) {
		return "";
	}
	return l10nFormat("Cache(20): {0}", formatPercent(cache.cacheHitRate * 100));
}

function formatPercent(percent: number): string {
	return `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
}
