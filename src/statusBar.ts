/**
 * Unified OpenCode Go status bar item.
 *
 * The item shows the selected usage window and the local proxy state. Clicking
 * it toggles the proxy when a key is configured; otherwise it opens the key
 * wizard. Usage refresh still runs on its configured interval.
 */

import * as vscode from "vscode";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { resolveApiKey } from "./apiKey";
import { getProxyStatus, LocalProxyStatus, onDidChangeProxyStatus } from "./proxyController";
import {
	clearUsageCache,
	formatDuration,
	formatProgressBar,
	formatResetDuration,
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

const USAGE_WINDOW_LABELS: Record<UsageWindowKey, string> = {
	rolling: "Rolling",
	weekly: "Weekly",
	monthly: "Monthly",
};

const USAGE_ERROR_COLOR = "#f14c4c";
const USAGE_WARNING_COLOR = "#cca700";

let usageState: UsageItemState = "loading";

export function initStatusBar(ctx: vscode.ExtensionContext): void {
	secrets = ctx.secrets;
	usageItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	usageItem.name = l10n("OpenCode Go status");
	usageItem.command = "codexgo.checkUsage";
	ctx.subscriptions.push(usageItem);
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
		onDidChangeProxyStatus(() => {
			applyUsageSetting();
		}),
	);
	ctx.subscriptions.push({
		dispose: () => {
			stopUsagePolling();
			stopRenderTicker();
		},
	});
}

/** Refresh the usage payload and repaint the status item. */
export async function refreshStatusBar(): Promise<void> {
	void refreshGoUsage(false);
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

function shouldShowStatusItem(): boolean {
	const proxy = getProxyStatus();
	return isUsageEnabled() || proxy.state === "starting" || proxy.state === "on" || proxy.state === "error";
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
	if (!shouldShowStatusItem()) {
		stopRenderTicker();
		usageItem.hide();
		return;
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
	if (!usageItem) {
		return;
	}
	const proxy = getProxyStatus();
	const proxyLabel = proxyStateLabel(proxy);
	const proxySuffix = l10nFormat("Proxy: {0}", proxyLabel);

	if (!isUsageEnabled()) {
		usageItem.text = `${l10n("OpenCode Go")} · ${proxySuffix}`;
		usageItem.color = proxy.state === "error" ? USAGE_ERROR_COLOR : undefined;
		usageItem.tooltip = proxyTooltip(proxy);
		return;
	}

	switch (usageState) {
		case "setup":
			usageItem.text = `${l10n("OpenCode Go: add API key")} · ${proxySuffix}`;
			usageItem.color = undefined;
			usageItem.tooltip = proxyTooltip(proxy, l10n("No OpenCode Go API key configured. Click to add one."));
			return;
		case "loading":
			usageItem.text = `${l10n("OpenCode Go: loading...")} · ${proxySuffix}`;
			usageItem.color = undefined;
			usageItem.tooltip = proxyTooltip(proxy, l10n("OpenCode Go usage"));
			return;
		case "auth":
			usageItem.text = `${l10n("OpenCode Go: invalid key")} · ${proxySuffix}`;
			usageItem.color = USAGE_ERROR_COLOR;
			usageItem.tooltip = proxyTooltip(
				proxy,
				l10n("The active API key was rejected (401/403). Click to set a new one."),
			);
			return;
		case "error": {
			usageItem.text = `${l10n("OpenCode Go: error")} · ${proxySuffix}`;
			usageItem.color = USAGE_ERROR_COLOR;
			const detail = getUsageErrorDetail();
			usageItem.tooltip = proxyTooltip(
				proxy,
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
		renderUsage();
		return;
	}

	const displayKey = getUsageDisplayWindow();
	const display = usage[displayKey];
	const label = l10n(USAGE_WINDOW_LABELS[displayKey]);
	const percentText = formatUsagePercent(display);
	const reset =
		shouldShowReset(displayKey, display) && display?.resetsAt
			? formatResetDuration(display.resetsAt)
			: "";
	const value = percentText === "?%" || !reset ? percentText : `${percentText} · ${reset}`;
	usageItem.text = `${l10nFormat("OpenCode Go {0}: {1}", label, value)} · ${proxySuffix}`;

	const worst = Math.max(
		usage.rolling?.percent ?? 0,
		usage.weekly?.percent ?? 0,
		usage.monthly?.percent ?? 0,
	);
	const thresholds = getUsageThresholds();
	usageItem.color =
		proxy.state === "error" || worst >= thresholds.error
			? USAGE_ERROR_COLOR
			: worst >= thresholds.warning
				? USAGE_WARNING_COLOR
				: undefined;

	const md = newTooltip();
	md.appendMarkdown(`**${l10nFormat("OpenCode Go - {0} Usage: {1}", label, percentText)}**\n\n`);
	md.appendMarkdown(`| ${l10n("Window")} | ${l10n("Usage")} | ${l10n("Resets in")} |\n`);
	md.appendMarkdown("| --- | --- | :--- |\n");
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
	appendProxyTooltip(md, proxy);
	usageItem.tooltip = md;
}

function proxyStateLabel(proxy: LocalProxyStatus): string {
	switch (proxy.state) {
		case "on":
			return capitalizeAscii(l10n("on"));
		case "starting":
			return capitalizeAscii(l10n("starting"));
		case "error":
			return capitalizeAscii(l10n("error"));
		default:
			return capitalizeAscii(l10n("off"));
	}
}

function capitalizeAscii(value: string): string {
	return /^[a-z]/.test(value) ? value[0].toUpperCase() + value.slice(1) : value;
}

function proxyTooltip(proxy: LocalProxyStatus, summary?: string): vscode.MarkdownString {
	const md = newTooltip();
	if (summary) {
		md.appendMarkdown(`${summary}\n\n`);
		md.appendMarkdown(`| [$(pulse) ${l10n("Check usage")}](command:codexgo.checkUsage)\n\n`);
	}
	md.appendMarkdown(`**${l10n("OpenCode Go local proxy")}**\n\n`);
	appendProxyTooltip(md, proxy);
	return md;
}

function appendProxyTooltip(md: vscode.MarkdownString, proxy: LocalProxyStatus): void {
	const toggle =
		proxy.state === "on" || proxy.state === "starting"
			? l10n("Turn proxy off")
			: l10n("Turn proxy on");
	md.appendMarkdown(
		`\n---\n**${l10nFormat("Proxy: {0}", proxyStateLabel(proxy))}**&emsp;[$(server) ${toggle}](command:codexgo.toggleProxy)\n\n`,
	);
	md.appendMarkdown(`- ${l10n("Address")}: \`${proxy.address}:${proxy.port}\`\n`);
	if (proxy.lastError) {
		md.appendMarkdown(`- ${l10n("Last error")}: \`${proxy.lastError}\`\n`);
	}
	md.appendMarkdown(`\n---\n**${l10n("Actions")}**\n\n`);
	md.appendMarkdown(`[$(key) ${l10n("Set API key")}](command:codexgo.setApiKey)  \n`);
	md.appendMarkdown(
		`[$(cloud-download) ${l10n("Sync models")}](command:codexgo.syncModelCatalog)  \n`,
	);
	md.appendMarkdown(`[$(file-code) ${l10n("Open config.toml")}](command:codexgo.openCodexConfig)  \n`);
	md.appendMarkdown(
		`[$(debug-restart) ${l10n("Restart Extension Host")}](command:workbench.action.restartExtensionHost)`,
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
	const bar = formatProgressBar(window.percent);
	const percent = formatUsagePercent(window);
	const reset =
		shouldShowReset(key, window) && window.resetsAt ? formatResetDuration(window.resetsAt) : "";
	return `| ${label} | ${bar} \`${percent}\` | ${reset} |`;
}

function shouldShowReset(key: UsageWindowKey, window: GoUsageWindow | undefined): boolean {
	if (!window) {
		return false;
	}
	return key !== "rolling" || window.percent > 0;
}

function formatUsagePercent(window: GoUsageWindow | undefined): string {
	if (!window || !Number.isFinite(window.percent)) {
		return "?%";
	}
	if (window.percent >= 100) {
		return l10n("limit");
	}
	if (window.percent <= 0) {
		return "0%";
	}
	if (window.percent < 1) {
		return "<1%";
	}
	return `${Math.round(window.percent)}%`;
}

function formatClockTime24(date: Date): string {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

export async function refreshGoUsageNow(): Promise<void> {
	const usage = await refreshGoUsage(true);
	if (!usage) {
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
			return;
		}
		void vscode.window.showWarningMessage(l10n("Go usage is temporarily unavailable."));
		return;
	}
	const summary = formatUsageSummary(usage);
	if (summary) {
		void vscode.window.showInformationMessage(l10nFormat("OpenCode Go usage: {0}", summary));
	}
}
