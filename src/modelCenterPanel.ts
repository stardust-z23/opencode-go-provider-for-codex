import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { l10n, l10nFormat } from "./localize";
import {
	effectiveModelPrice,
	type GoModelInfo,
	type GoPlan,
	modelContextPriceTiers,
	modelTimePriceRules,
} from "./modelCenterData";
import {
	type ModelCenterService,
	type ModelCenterViewSnapshot,
} from "./modelCenterService";

interface ModelCenterMessage {
	type?: string;
	action?: string;
	plan?: unknown;
	url?: unknown;
	modelId?: unknown;
}

interface ModelRow {
	id: string;
	name: string;
	canonicalId?: string;
	description?: string;
	releaseDate?: string;
	lastUpdated?: string;
	recommendedApi?: string;
	availableApis: string[];
	contextLimit?: number;
	outputLimit?: number;
	monthlyUsage: Record<GoPlan, number | null>;
	requestsPerFiveHours: Record<GoPlan, number | null>;
	price: {
		input: number | null;
		cacheRead: number | null;
		cacheWrite: unknown;
		output: number | null;
		multiplier: number;
		label?: string;
	};
	contextTiers: ReturnType<typeof modelContextPriceTiers>;
	timeRules: ReturnType<typeof modelTimePriceRules>;
	training: boolean;
	zdr: boolean;
	limitedRegions: boolean;
	limitedTime: boolean;
	featured: boolean;
	deprecated: boolean;
	reasoningEfforts: string[];
	vision: boolean;
	openWeights?: boolean;
}

export function registerModelCenter(
	context: vscode.ExtensionContext,
	service: ModelCenterService,
): vscode.Disposable {
	const statusItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		98,
	);
	statusItem.name = l10n("OpenCode Go model updates");
	statusItem.command = "codexgo.openModelCenter";

	const updateStatus = (): void => {
		const snapshot = service.getSnapshot();
		if (snapshot.unreadCount <= 0) {
			statusItem.hide();
			return;
		}
		statusItem.text = l10nFormat(
			"$(bell) {0} OpenCode Go updates",
			String(snapshot.unreadCount),
		);
		statusItem.tooltip = l10n(
			"Open the OpenCode Go model center to review model and official news updates.",
		);
		statusItem.show();
	};

	const command = vscode.commands.registerCommand(
		"codexgo.openModelCenter",
		() => openModelCenter(context, service),
	);
	const subscription = service.onDidChange(updateStatus);
	updateStatus();
	return {
		dispose: () => {
			command.dispose();
			subscription.dispose();
			statusItem.dispose();
		},
	};
}

async function openModelCenter(
	context: vscode.ExtensionContext,
	service: ModelCenterService,
): Promise<void> {
	if (openPanel) {
		openPanel.reveal(vscode.ViewColumn.Active);
		await service.markAllRead();
		postSnapshot();
		if (isStale(service.getSnapshot())) {
			void service.refreshNow(false);
		}
		return;
	}

	await service.markAllRead();
	const panel = vscode.window.createWebviewPanel(
		"codexgo.modelCenter",
		l10n("OpenCode Go model center"),
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.joinPath(
					context.extensionUri,
					"resources",
					"model-center",
				),
			],
		},
	);
	openPanel = panel;
	const disposables: vscode.Disposable[] = [];

	disposables.push(
		service.onDidChange(() => {
			if (panel.visible) {
				if (service.getSnapshot().unreadCount > 0) {
					void service.markAllRead();
					return;
				}
				postSnapshot();
			}
		}),
		panel.webview.onDidReceiveMessage((message: ModelCenterMessage) => {
			void handleMessage(message);
		}),
		panel.onDidDispose(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			if (openPanel === panel) {
				openPanel = undefined;
				postSnapshot = () => undefined;
			}
		}),
	);

	postSnapshot = () => {
		void panel.webview.postMessage({
			type: "snapshot",
			data: viewData(service.getSnapshot()),
			labels: modelCenterLabels(),
			locale: vscode.env.language,
			generatedAt: Date.now(),
		});
	};

	panel.webview.html = await modelCenterHtml(
		panel.webview,
		context.extensionUri,
	);
	postSnapshot();
	if (isStale(service.getSnapshot())) {
		void service.refreshNow(false);
	}

	async function handleMessage(message: ModelCenterMessage): Promise<void> {
		if (message.type === "ready" || message.type === "refresh") {
			postSnapshot();
			if (message.type === "refresh") {
				await service.refreshNow(true);
				postSnapshot();
			}
			return;
		}
		if (message.type === "setPlan") {
			const plan =
				message.plan === "go" ||
				message.plan === "go-plus" ||
				message.plan === "go-teams"
					? (message.plan as GoPlan)
					: undefined;
			await service.setPlan(plan);
			postSnapshot();
			return;
		}
		if (message.type === "openExternal") {
			if (typeof message.url === "string") {
				await openTrustedUrl(message.url);
			}
			return;
		}
		if (message.type === "copyModelId") {
			if (typeof message.modelId === "string" && message.modelId) {
				await vscode.env.clipboard.writeText(message.modelId);
				void vscode.window.showInformationMessage(
					l10n("Model ID copied to clipboard."),
				);
			}
			return;
		}
		if (message.type === "action") {
			switch (message.action) {
				case "openUsage":
					await vscode.commands.executeCommand(
						"codexgo.openUsageDashboard",
					);
					return;
				case "openOfficialPage":
					await openTrustedUrl("https://opencode.ai/console/go");
					return;
				case "syncModels":
					await vscode.commands.executeCommand(
						"codexgo.syncModelCatalog",
					);
					return;
				case "setApiKey":
					await vscode.commands.executeCommand(
						"codexgo.setApiKey",
					);
					return;
				default:
					return;
			}
		}
	}
}

let openPanel: vscode.WebviewPanel | undefined;
let postSnapshot: () => void = () => undefined;

function isStale(snapshot: ModelCenterViewSnapshot): boolean {
	return (
		snapshot.fetchedAt === undefined ||
		Date.now() - snapshot.fetchedAt > 60 * 60 * 1000
	);
}

async function openTrustedUrl(raw: string): Promise<void> {
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.hostname !== "opencode.ai") {
			return;
		}
		await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
	} catch {
		// Ignore malformed links from cached feeds.
	}
}

function viewData(snapshot: ModelCenterViewSnapshot): Record<string, unknown> {
	return {
		...snapshot,
		models: snapshot.models.map((model) =>
			modelRow(model),
		),
	};
}

function modelRow(model: GoModelInfo): ModelRow {
	const price = effectiveModelPrice(model);
	const reasoning = model.capabilities?.reasoning;
	const reasoningEfforts =
		typeof reasoning === "object" &&
		reasoning !== null &&
		Array.isArray((reasoning as Record<string, unknown>).effort)
			? (
					(reasoning as Record<string, unknown>).effort as unknown[]
				).filter(
					(effort): effort is string =>
						typeof effort === "string" && effort.length > 0,
				)
			: [];
	return {
		id: model.id,
		name: model.name,
		canonicalId: model.canonicalId,
		description: model.description,
		releaseDate: model.releaseDate,
		lastUpdated: model.lastUpdated,
		recommendedApi: model.recommendedApi,
		availableApis: Object.keys(model.api ?? {}),
		contextLimit: model.contextLimit,
		outputLimit: model.outputLimit,
		monthlyUsage: model.monthlyUsage,
		requestsPerFiveHours: model.requestsPerFiveHours ?? {
			go: null,
			"go-plus": null,
			"go-teams": null,
		},
		price: {
			input: price.input,
			cacheRead: price.cacheRead,
			cacheWrite: price.cacheWrite,
			output: price.output,
			multiplier: price.multiplier,
			label: price.label,
		},
		contextTiers: modelContextPriceTiers(model),
		timeRules: modelTimePriceRules(model),
		training: model.training,
		zdr: model.zdr,
		limitedRegions: model.limitedRegions,
		limitedTime: model.limitedTime,
		featured: model.featured,
		deprecated: model.deprecated,
		reasoningEfforts,
		vision: model.inputModalities.some(
			(modality) => modality !== "text",
		),
		openWeights: model.openWeights,
	};
}

function modelCenterLabels(): Record<string, string> {
	return {
		title: l10n("OpenCode Go model center"),
		subtitle: l10n("Model pricing, monthly allowances, and official updates"),
		modelsTab: l10n("Models and pricing"),
		updatesTab: l10n("Updates"),
		search: l10n("Search models"),
		officialPage: l10n("Official page"),
		openUsage: l10n("Usage dashboard"),
		refresh: l10n("Refresh model data"),
		refreshing: l10n("Refreshing..."),
		plan: l10n("Plan"),
		auto: l10n("Auto"),
		go: l10n("Go"),
		goPlus: l10n("Go Plus"),
		goTeams: l10n("Go Teams"),
		detectedPlan: l10n("Detected from the latest request: {0}"),
		defaultPlan: l10n("No billing plan detected; highlighting Go by default."),
		manualPlan: l10n("Manual plan override: {0}"),
		models: l10n("Models"),
		featured: l10n("Featured"),
		limitedTime: l10n("Free for a limited time"),
		deprecated: l10n("Deprecated"),
		notIncluded: l10n("Not included"),
		unread: l10n("{0} unread updates"),
		model: l10n("Model"),
		monthlyAllowance: l10n("Monthly allowance"),
		input: l10n("Input"),
		cacheRead: l10n("Cache read"),
		cacheWrite: l10n("Cache write"),
		output: l10n("Output"),
		context: l10n("Context"),
		contextLength: l10n("{0} context"),
		outputLimit: l10n("{0} output"),
		rules: l10n("Rules"),
		availability: l10n("Availability"),
		priceUnit: l10n("$ / 1M tokens"),
		priceAt: l10n("Current: {0}"),
		peakMultiplier: l10n("{0}x multiplier"),
		contextTier: l10n("Above {0} context"),
		utc: l10n("UTC"),
		days: l10n("Days: {0}"),
		dateRange: l10n("Dates: {0} to {1}"),
		timeRange: l10n("{0}-{1} {2}"),
		noRules: l10n("Standard pricing"),
		training: l10n("May train"),
		noTraining: l10n("No training"),
		zdr: l10n("Zero data retention"),
		limitedRegions: l10n("Region restrictions"),
		reasoning: l10n("Reasoning"),
		vision: l10n("Vision"),
		openWeights: l10n("Open weights"),
		requestsFiveHours: l10n("{0} requests / 5h"),
		noModels: l10n("No models match the current search."),
		changes: l10n("Model changes"),
		officialNews: l10n("Official news"),
		noChanges: l10n("No model changes in the last 90 days."),
		noNews: l10n("No official news in the last 90 days."),
		historyWindow: l10n("Changes and news are retained for 90 days."),
		added: l10n("New model"),
		removed: l10n("Model removed"),
		monthlyUsage: l10n("Monthly allowance changed"),
		pricing: l10n("Pricing changed"),
		limits: l10n("Limits changed"),
		availabilityChanged: l10n("Availability changed"),
		metadata: l10n("Metadata changed"),
		oldValue: l10n("Before"),
		newValue: l10n("After"),
		readOfficial: l10n("Read official announcement"),
		lastModelFetch: l10n("Model data updated {0}"),
		lastNewsFetch: l10n("Official news checked {0}"),
		lastSyncSynced: l10n("Codex catalog auto-synced after new models appeared."),
		lastSyncSkipped: l10n("Automatic catalog sync was skipped: {0}"),
		lastSyncFailed: l10n("Automatic catalog sync failed: {0}"),
		modelError: l10n("Model data is temporarily unavailable: {0}"),
		newsError: l10n("Official news is temporarily unavailable: {0}"),
		copyModelId: l10n("Copy Model ID"),
		setApiKey: l10n("Set API key"),
		syncModels: l10n("Sync models now"),
		columns: l10n("Columns"),
		showColumns: l10n("Show columns"),
		current: l10n("Current"),
		sortAscending: l10n("Sort ascending"),
		sortDescending: l10n("Sort descending"),
	};
}

async function modelCenterHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
): Promise<string> {
	const root = vscode.Uri.joinPath(extensionUri, "resources", "model-center");
	const htmlPath = vscode.Uri.joinPath(root, "index.html");
	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(root, "model-center.css"));
	const scriptUri = webview.asWebviewUri(
		vscode.Uri.joinPath(root, "model-center.js"),
	);
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
