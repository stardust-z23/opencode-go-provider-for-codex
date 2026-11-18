import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { l10n } from "./localize";
import {
	getUsagePanelState,
	onDidChangeUsageState,
	refreshGoUsageNow,
} from "./statusBar";
import {
	type UsageRangePreset,
	type UsageStatusFilter,
} from "./usageStats";
import { UsageStore } from "./usageStore";

interface UsagePanelFilters {
	range: UsageRangePreset;
	model?: string;
	status: UsageStatusFilter;
	page: number;
}

interface UsagePanelMessage {
	type?: string;
	range?: unknown;
	model?: unknown;
	status?: unknown;
	page?: unknown;
	action?: unknown;
}

const REQUESTS_PER_PAGE = 20;

export function registerUsageDashboard(
	context: vscode.ExtensionContext,
	store: UsageStore,
): vscode.Disposable {
	return vscode.commands.registerCommand("codexgo.openUsageDashboard", () =>
		openUsageDashboard(context, store),
	);
}

async function openUsageDashboard(
	context: vscode.ExtensionContext,
	store: UsageStore,
): Promise<void> {
	if (openPanel) {
		openPanel.reveal(vscode.ViewColumn.Active);
		await store.reload();
		refreshOpenPanel?.();
		return;
	}
	await store.reload();

	const panel = vscode.window.createWebviewPanel(
		"codexgo.usageDashboard",
		l10n("OpenCode Go usage"),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(context.extensionUri, "resources", "usage-dashboard"),
			],
		},
	);
	openPanel = panel;
	const filters: UsagePanelFilters = {
		range: "1h",
		status: "all",
		page: 1,
	};
	const disposables: vscode.Disposable[] = [];
	const postSnapshot = (): void => {
		let data = store.getSnapshot(queryFor(filters));
		const totalPages = Math.max(
			1,
			Math.ceil(data.totalMatched / REQUESTS_PER_PAGE),
		);
		if (filters.page > totalPages) {
			filters.page = totalPages;
			data = store.getSnapshot(queryFor(filters));
		}
		void panel.webview.postMessage({
			type: "snapshot",
			data,
			quota: getUsagePanelState(),
			labels: usageLabels(),
			filters,
			locale: vscode.env.language,
			generatedAt: Date.now(),
		});
	};
	refreshOpenPanel = postSnapshot;

	disposables.push(
		store.onDidChange(() => {
			if (panel.visible) {
				postSnapshot();
			}
		}),
		onDidChangeUsageState(() => {
			if (panel.visible) {
				postSnapshot();
			}
		}),
		panel.webview.onDidReceiveMessage((message: UsagePanelMessage) => {
			void handleMessage(message);
		}),
		panel.onDidDispose(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			if (openPanel === panel) {
				openPanel = undefined;
				refreshOpenPanel = undefined;
			}
		}),
	);

	panel.webview.html = await dashboardHtml(panel.webview, context.extensionUri);

	async function handleMessage(message: UsagePanelMessage): Promise<void> {
		if (message.type === "ready") {
			if (isRange(message.range)) {
				filters.range = message.range;
			}
			filters.model =
				typeof message.model === "string" && message.model
					? message.model
					: undefined;
			if (isStatus(message.status)) {
				filters.status = message.status;
			}
			if (isPage(message.page)) {
				filters.page = message.page;
			}
			postSnapshot();
			return;
		}
		if (message.type === "setFilters") {
			const previousRange = filters.range;
			const previousModel = filters.model;
			const previousStatus = filters.status;
			if (isRange(message.range)) {
				filters.range = message.range;
			}
			filters.model =
				typeof message.model === "string" && message.model
					? message.model
					: undefined;
			if (isStatus(message.status)) {
				filters.status = message.status;
			}
			if (
				previousRange !== filters.range ||
				previousModel !== filters.model ||
				previousStatus !== filters.status
			) {
				filters.page = 1;
			}
			if (isPage(message.page)) {
				filters.page = message.page;
			}
			postSnapshot();
			return;
		}
		if (message.type === "action" && typeof message.action === "string") {
			await runAction(message.action);
			if (message.action !== "reloadWindow") {
				postSnapshot();
			}
		}
	}

	async function runAction(action: string): Promise<void> {
		switch (action) {
			case "refreshAll":
				await Promise.allSettled([
					store.reload(true),
					refreshGoUsageNow(false),
				]);
				return;
			case "refreshQuota":
				await refreshGoUsageNow(false);
				return;
			case "setApiKey":
				await vscode.commands.executeCommand("codexgo.setApiKey");
				return;
			case "getApiKey":
				await vscode.commands.executeCommand("codexgo.getApiKey");
				return;
			case "syncModels":
				await vscode.commands.executeCommand("codexgo.syncModelCatalog");
				return;
			case "removeCatalog":
				await vscode.commands.executeCommand("codexgo.removeModelCatalog");
				return;
			case "openConfig":
				await vscode.commands.executeCommand("codexgo.openCodexConfig");
				return;
			case "openSettings":
				await vscode.commands.executeCommand("codexgo.openSettings");
				return;
			case "reloadWindow":
				await vscode.commands.executeCommand("workbench.action.reloadWindow");
				return;
			default:
				return;
		}
	}
}

let openPanel: vscode.WebviewPanel | undefined;
let refreshOpenPanel: (() => void) | undefined;

function queryFor(filters: UsagePanelFilters): {
	start: number;
	end: number;
	model?: string;
	status: UsageStatusFilter;
	limit: number;
	offset: number;
} {
	const end = Date.now();
	const today = new Date(end);
	today.setHours(0, 0, 0, 0);
	const start =
		filters.range === "1h"
			? end - 60 * 60 * 1000
			: filters.range === "7d"
				? end - 7 * 24 * 60 * 60 * 1000
				: today.getTime();
	return {
		start,
		end,
		model: filters.model,
		status: filters.status,
		limit: REQUESTS_PER_PAGE,
		offset: (filters.page - 1) * REQUESTS_PER_PAGE,
	};
}

function isRange(value: unknown): value is UsageRangePreset {
	return value === "1h" || value === "today" || value === "7d";
}

function isStatus(value: unknown): value is UsageStatusFilter {
	return value === "all" || value === "success" || value === "error";
}

function isPage(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

async function dashboardHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
): Promise<string> {
	const root = vscode.Uri.joinPath(extensionUri, "resources", "usage-dashboard");
	const htmlPath = vscode.Uri.joinPath(root, "index.html");
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "dashboard.css"));
	const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "dashboard.js"));
	const nonce = randomBytes(16).toString("hex");
	let html = await fs.readFile(htmlPath.fsPath, "utf8");
	html = html
		.replaceAll("{{cspSource}}", webview.cspSource)
		.replaceAll("{{styleUri}}", cssUri.toString())
		.replaceAll("{{scriptUri}}", scriptUri.toString())
		.replaceAll("{{nonce}}", nonce)
		.replaceAll("{{lang}}", vscode.env.language || "en");
	return html;
}

function usageLabels(): Record<string, string> {
	return {
		title: l10n("OpenCode Go usage"),
		moreActions: l10n("More actions"),
		quotaSection: l10n("Go plan quota"),
		requestsSection: l10n("Requests through this extension"),
		last1h: l10n("Last 1 hour"),
		today: l10n("Today"),
		last7d: l10n("Last 7 days"),
		model: l10n("Model"),
		allModels: l10n("All models"),
		status: l10n("Status"),
		allStatuses: l10n("All"),
		success: l10n("Success"),
		error: l10n("Error"),
		totalRequests: l10n("Requests"),
		previousPage: l10n("Previous page"),
		nextPage: l10n("Next page"),
		pageOf: l10n("Page {0} of {1}"),
		showingRange: l10n("Showing {0}-{1} of {2}"),
		realTotalTokens: l10n("Real total tokens"),
		cacheHitRate: l10n("Cache hit rate"),
		successRate: l10n("Success rate"),
		freshInput: l10n("Fresh input"),
		cacheRead: l10n("Cache read"),
		cacheWrite: l10n("Cache write"),
		output: l10n("Output"),
		reasoning: l10n("Reasoning"),
		averageDuration: l10n("Average duration"),
		usageTrend: l10n("Usage trend"),
		tokens: l10n("Tokens"),
		cacheDropTitle: l10n("Suspected cache drop"),
		cacheDropSummary: l10n("{0} events, {1} fewer cached tokens"),
		recentRequests: l10n("Recent requests"),
		time: l10n("Time"),
		duration: l10n("Duration"),
		emptyRequests: l10n("No requests in this range."),
		loading: l10n("Loading"),
		setup: l10n("API key required"),
		active: l10n("Active"),
		auth: l10n("Invalid API key"),
		errorState: l10n("Unavailable"),
		updated: l10n("Updated {0}"),
		autoRefresh: l10n("Auto refresh: {0} min"),
		resetIn: l10n("Resets in {0}"),
		balanceFallback: l10n("After the Go quota runs out, usage falls back to your balance."),
		refreshQuota: l10n("Refresh quota"),
		refreshNow: l10n("Refresh now"),
		setApiKey: l10n("Set API key"),
		getApiKey: l10n("Get API key"),
		syncModels: l10n("Sync models"),
		removeCatalog: l10n("Remove generated model catalog"),
		openConfig: l10n("Open config.toml"),
		openSettings: l10n("Open settings"),
		reloadWindow: l10n("Reload window"),
	};
}
