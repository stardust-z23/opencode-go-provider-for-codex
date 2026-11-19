import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { logger } from "./logger";
import { getUsageStore } from "./usageService";
import { getUserAgent } from "./utils";
import {
	detectPlanFromBillingSource,
	diffModelCatalogs,
	type GoPlan,
	type ModelCatalogSnapshot,
	type ModelChange,
	normalizeModelCatalog,
	type OfficialNewsItem,
	parseOfficialNewsFeed,
} from "./modelCenterData";

const MODEL_CATALOG_URL = "https://opencode.ai/inference/go/v1/models";
const NEWS_FEED_URL = "https://opencode.ai/console/changelog/rss.xml";
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5_000;
const FETCH_TIMEOUT_MS = 20_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_NEWS_ITEMS = 500;
const MAX_CHANGE_ITEMS = 5_000;
const AUTO_SYNC_LOCK_STALE_MS = 10 * 60 * 1000;

export type AutoSyncStatus = "synced" | "skipped" | "failed";

export interface AutoSyncResult {
	status: AutoSyncStatus;
	detail?: string;
	count?: number;
}

export interface ModelCenterPlanState {
	detected?: GoPlan;
	selected?: GoPlan;
	effective: GoPlan;
	source: "detected" | "selected" | "default";
}

export interface ModelCenterViewSnapshot {
	models: ModelCatalogSnapshot["models"];
	fetchedAt?: number;
	changes: ModelChange[];
	news: OfficialNewsItem[];
	unreadChangeIds: string[];
	unreadNewsIds: string[];
	unreadCount: number;
	plan: ModelCenterPlanState;
	lastModelFetchAt?: number;
	lastNewsFetchAt?: number;
	lastAutoSyncAt?: number;
	lastAutoSync?: AutoSyncResult;
	modelError?: string;
	newsError?: string;
	refreshing: boolean;
}

export interface ModelCenterUpdateEvent {
	changes: ModelChange[];
	news: OfficialNewsItem[];
	addedModelIds: string[];
	autoSync?: AutoSyncResult;
}

interface ModelCenterServiceOptions {
	storageRoot: string;
	autoSyncCatalog?: (addedModelIds: readonly string[]) => Promise<AutoSyncResult>;
	onDidFindUpdates?: (event: ModelCenterUpdateEvent) => void | Promise<void>;
}

interface PersistedModelCenterState {
	schemaVersion: 1;
	snapshot?: ModelCatalogSnapshot;
	changes: ModelChange[];
	news: OfficialNewsItem[];
	unreadChangeIds: string[];
	unreadNewsIds: string[];
	newsBaselineEstablished: boolean;
	newsEtag?: string;
	newsLastModified?: string;
	selectedPlan?: GoPlan;
	lastModelFetchAt?: number;
	lastNewsFetchAt?: number;
	lastAutoSyncAt?: number;
	lastAutoSync?: AutoSyncResult;
	modelError?: string;
	newsError?: string;
}

interface ModelFetchResult {
	snapshot: ModelCatalogSnapshot;
}

interface NewsFetchResult {
	items?: OfficialNewsItem[];
	notModified: boolean;
	etag?: string;
	lastModified?: string;
}

export class ModelCenterService implements vscode.Disposable {
	private readonly storageDir: string;
	private readonly statePath: string;
	private readonly autoSyncLockPath: string;
	private readonly options: ModelCenterServiceOptions;
	private readonly listeners = new Set<() => void>();
	private state: PersistedModelCenterState = emptyState();
	private refreshPromise: Promise<ModelCenterUpdateEvent | undefined> | undefined;
	private refreshTimer: NodeJS.Timeout | undefined;
	private startupTimer: NodeJS.Timeout | undefined;
	private usageSubscription: vscode.Disposable | undefined;
	private saveQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	private refreshing = false;

	constructor(options: ModelCenterServiceOptions) {
		this.options = options;
		this.storageDir = path.join(options.storageRoot, "model-center");
		this.statePath = path.join(this.storageDir, "state.json");
		this.autoSyncLockPath = path.join(this.storageDir, "auto-sync.lock");
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.storageDir, { recursive: true });
		this.state = await this.loadState();
		this.pruneState();
	}

	start(): void {
		if (this.disposed || this.refreshTimer) {
			return;
		}
		this.usageSubscription = getUsageStore()?.onDidChange(() => this.notify());
		this.startupTimer = setTimeout(() => {
			this.startupTimer = undefined;
			void this.refreshNow(false);
		}, STARTUP_DELAY_MS);
		this.refreshTimer = setInterval(() => {
			void this.refreshNow(false);
		}, REFRESH_INTERVAL_MS);
	}

	dispose(): void {
		this.disposed = true;
		if (this.startupTimer) {
			clearTimeout(this.startupTimer);
			this.startupTimer = undefined;
		}
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.usageSubscription?.dispose();
		this.usageSubscription = undefined;
		this.listeners.clear();
	}

	getSnapshot(): ModelCenterViewSnapshot {
		const detected = detectPlanFromBillingSource(
			getUsageStore()?.getLatestBillingSource(),
		);
		const selected = this.state.selectedPlan;
		const effective = selected ?? detected ?? "go";
		const source = selected
			? "selected"
			: detected
				? "detected"
				: "default";
		return {
			models: this.state.snapshot?.models ?? [],
			fetchedAt: this.state.snapshot?.fetchedAt,
			changes: this.state.changes,
			news: this.state.news,
			unreadChangeIds: this.state.unreadChangeIds,
			unreadNewsIds: this.state.unreadNewsIds,
			unreadCount:
				this.state.unreadChangeIds.length +
				this.state.unreadNewsIds.length,
			plan: {
				detected,
				selected,
				effective,
				source,
			},
			lastModelFetchAt: this.state.lastModelFetchAt,
			lastNewsFetchAt: this.state.lastNewsFetchAt,
			lastAutoSyncAt: this.state.lastAutoSyncAt,
			lastAutoSync: this.state.lastAutoSync,
			modelError: this.state.modelError,
			newsError: this.state.newsError,
			refreshing: this.refreshing,
		};
	}

	onDidChange(listener: () => void): vscode.Disposable {
		this.listeners.add(listener);
		return {
			dispose: () => this.listeners.delete(listener),
		};
	}

	async refreshNow(manual = true): Promise<ModelCenterUpdateEvent | undefined> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}
		this.refreshing = true;
		this.notify();
		this.refreshPromise = this.runRefresh(manual)
			.catch((error) => {
				logger.warn("modelCenter.refresh.failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			})
			.finally(() => {
				this.refreshing = false;
				this.refreshPromise = undefined;
				this.notify();
			});
		return this.refreshPromise;
	}

	async setPlan(plan: GoPlan | undefined): Promise<void> {
		this.state.selectedPlan =
			plan === "go" || plan === "go-plus" || plan === "go-teams"
				? plan
				: undefined;
		await this.saveState();
		this.notify();
	}

	async markAllRead(notify = true): Promise<void> {
		if (
			this.state.unreadChangeIds.length === 0 &&
			this.state.unreadNewsIds.length === 0
		) {
			return;
		}
		this.state.unreadChangeIds = [];
		this.state.unreadNewsIds = [];
		await this.saveState();
		if (notify) {
			this.notify();
		}
	}

	private async runRefresh(
		manual: boolean,
	): Promise<ModelCenterUpdateEvent | undefined> {
		const now = Date.now();
		const previous = this.state.snapshot;
		const [modelResult, newsResult] = await Promise.allSettled([
			this.fetchModels(),
			this.fetchNews(),
		]);

		let changes: ModelChange[] = [];
		let newNews: OfficialNewsItem[] = [];
		let addedModelIds: string[] = [];

		if (modelResult.status === "fulfilled") {
			const next = modelResult.value.snapshot;
			changes = diffModelCatalogs(previous, next, now);
			addedModelIds = changes
				.filter((change) => change.kind === "added")
				.map((change) => change.modelId);
			this.state.snapshot = next;
			this.state.lastModelFetchAt = now;
			this.state.modelError = undefined;
		} else {
			this.state.modelError = errorMessage(modelResult.reason);
		}

		if (newsResult.status === "fulfilled") {
			const result = newsResult.value;
			this.state.lastNewsFetchAt = now;
			this.state.newsError = undefined;
			if (result.etag) {
				this.state.newsEtag = result.etag;
			}
			if (result.lastModified) {
				this.state.newsLastModified = result.lastModified;
			}
			if (!result.notModified && result.items) {
				const existing = new Set(this.state.news.map((item) => item.guid));
				const incoming = result.items.filter((item) => !existing.has(item.guid));
				if (this.state.newsBaselineEstablished) {
					newNews = incoming;
				}
				this.state.newsBaselineEstablished = true;
				this.state.news = mergeNews(this.state.news, result.items);
			}
		} else {
			this.state.newsError = errorMessage(newsResult.reason);
		}

		if (changes.length > 0) {
			this.state.changes = mergeChanges(this.state.changes, changes, now);
			this.state.unreadChangeIds = unique([
				...this.state.unreadChangeIds,
				...changes.map((change) => change.id),
			]);
		}
		if (newNews.length > 0) {
			this.state.unreadNewsIds = unique([
				...this.state.unreadNewsIds,
				...newNews.map((item) => item.guid),
			]);
		}
		this.pruneState();
		await this.saveState();

		let autoSync: AutoSyncResult | undefined;
		if (addedModelIds.length > 0 && this.options.autoSyncCatalog) {
			autoSync = await this.runAutoSync(addedModelIds);
			this.state.lastAutoSyncAt = now;
			this.state.lastAutoSync = autoSync;
			await this.saveState();
		}

		this.notify();
		if (changes.length === 0 && newNews.length === 0) {
			return undefined;
		}
		const event: ModelCenterUpdateEvent = {
			changes,
			news: newNews,
			addedModelIds,
			autoSync,
		};
		if (!manual || changes.length > 0 || newNews.length > 0) {
			void Promise.resolve(this.options.onDidFindUpdates?.(event)).catch(
				(error) => {
					logger.warn("modelCenter.notification.failed", {
						error: errorMessage(error),
					});
				},
			);
		}
		return event;
	}

	private async runAutoSync(
		addedModelIds: readonly string[],
	): Promise<AutoSyncResult> {
		const lock = await this.acquireAutoSyncLock();
		if (!lock) {
			return {
				status: "skipped",
				detail: "Another VS Code window is already syncing the catalog.",
			};
		}
		try {
			return await this.options.autoSyncCatalog!(addedModelIds);
		} catch (error) {
			return { status: "failed", detail: errorMessage(error) };
		} finally {
			await lock.close().catch(() => undefined);
			await fs.unlink(this.autoSyncLockPath).catch(() => undefined);
		}
	}

	private async acquireAutoSyncLock(): Promise<fs.FileHandle | undefined> {
		try {
			return await fs.open(this.autoSyncLockPath, "wx");
		} catch (error) {
			if (!isAlreadyExists(error)) {
				throw error;
			}
		}
		try {
			const stat = await fs.stat(this.autoSyncLockPath);
			if (Date.now() - stat.mtimeMs > AUTO_SYNC_LOCK_STALE_MS) {
				await fs.unlink(this.autoSyncLockPath);
				return await fs.open(this.autoSyncLockPath, "wx");
			}
		} catch {
			// Another process can release the lock between stat and unlink.
		}
		return undefined;
	}

	private async fetchModels(): Promise<ModelFetchResult> {
		const response = await this.fetchWithTimeout(MODEL_CATALOG_URL, {
			Accept: "application/json",
		});
		if (!response.ok) {
			throw new Error(`HTTP [${response.status}] ${response.statusText}`);
		}
		const payload = (await response.json()) as unknown;
		const snapshot = normalizeModelCatalog(payload);
		if (snapshot.models.length === 0) {
			throw new Error("The public model catalog returned no models.");
		}
		return { snapshot };
	}

	private async fetchNews(): Promise<NewsFetchResult> {
		const headers: Record<string, string> = {
			Accept: "application/rss+xml, application/xml, text/xml",
		};
		if (this.state.newsEtag) {
			headers["If-None-Match"] = this.state.newsEtag;
		}
		if (this.state.newsLastModified) {
			headers["If-Modified-Since"] = this.state.newsLastModified;
		}
		const response = await this.fetchWithTimeout(NEWS_FEED_URL, headers);
		if (response.status === 304) {
			return {
				notModified: true,
				etag: response.headers.get("etag") ?? undefined,
				lastModified:
					response.headers.get("last-modified") ?? undefined,
			};
		}
		if (!response.ok) {
			throw new Error(`HTTP [${response.status}] ${response.statusText}`);
		}
		const items = parseOfficialNewsFeed(await response.text());
		return {
			items,
			notModified: false,
			etag: response.headers.get("etag") ?? undefined,
			lastModified: response.headers.get("last-modified") ?? undefined,
		};
	}

	private async fetchWithTimeout(
		url: string,
		headers: Record<string, string>,
	): Promise<Response> {
		try {
			return await fetch(url, {
				headers: {
					"User-Agent": getUserAgent(),
					...headers,
				},
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				(error as { name?: string }).name === "AbortError"
			) {
				throw new Error(
					`Request timed out after ${FETCH_TIMEOUT_MS}ms`,
				);
			}
			throw error;
		}
	}

	private pruneState(): void {
		const cutoff = Date.now() - RETENTION_MS;
		this.state.changes = this.state.changes.filter(
			(change) => change.detectedAt >= cutoff,
		).slice(0, MAX_CHANGE_ITEMS);
		this.state.news = this.state.news
			.filter((item) => item.publishedAt >= cutoff)
			.slice(0, MAX_NEWS_ITEMS);
		const changeIds = new Set(this.state.changes.map((change) => change.id));
		const newsIds = new Set(this.state.news.map((item) => item.guid));
		this.state.unreadChangeIds = this.state.unreadChangeIds.filter((id) =>
			changeIds.has(id),
		);
		this.state.unreadNewsIds = this.state.unreadNewsIds.filter((id) =>
			newsIds.has(id),
		);
	}

	private async loadState(): Promise<PersistedModelCenterState> {
		let raw: unknown;
		try {
			raw = JSON.parse(await fs.readFile(this.statePath, "utf8"));
		} catch (error) {
			if (!isNotFound(error)) {
				logger.warn("modelCenter.state.read.failed", {
					error: errorMessage(error),
				});
			}
			return emptyState();
		}
		if (!isRecord(raw) || raw.schemaVersion !== 1) {
			return emptyState();
		}
		const rawSnapshot = isRecord(raw.snapshot)
			? raw.snapshot
			: undefined;
		const fetchedAt = numeric(rawSnapshot?.fetchedAt);
		const models = Array.isArray(rawSnapshot?.models)
			? rawSnapshot.models
			: undefined;
		const snapshot =
			fetchedAt !== undefined && models
				? normalizeModelCatalog({ data: models }, fetchedAt)
				: undefined;
		return {
			schemaVersion: 1,
			snapshot:
				snapshot && snapshot.models.length > 0 ? snapshot : undefined,
			changes: Array.isArray(raw.changes)
				? raw.changes
						.map(parseModelChange)
						.filter(
							(change): change is ModelChange =>
								change !== undefined,
						)
				: [],
			news: Array.isArray(raw.news)
				? raw.news
						.map(parseNewsItem)
						.filter(
							(item): item is OfficialNewsItem =>
								item !== undefined,
						)
				: [],
			unreadChangeIds: stringArray(raw.unreadChangeIds),
			unreadNewsIds: stringArray(raw.unreadNewsIds),
			newsBaselineEstablished: raw.newsBaselineEstablished === true,
			newsEtag: stringValue(raw.newsEtag),
			newsLastModified: stringValue(raw.newsLastModified),
			selectedPlan: planValue(raw.selectedPlan),
			lastModelFetchAt: numeric(raw.lastModelFetchAt),
			lastNewsFetchAt: numeric(raw.lastNewsFetchAt),
			lastAutoSyncAt: numeric(raw.lastAutoSyncAt),
			lastAutoSync: parseAutoSync(raw.lastAutoSync),
			modelError: stringValue(raw.modelError),
			newsError: stringValue(raw.newsError),
		};
	}

	private async saveState(): Promise<void> {
		const save = async (): Promise<void> => {
			const text = `${JSON.stringify(this.state, null, 2)}\n`;
			const temporary = `${this.statePath}.${process.pid}.tmp`;
			await fs.writeFile(temporary, text, "utf8");
			await fs.rename(temporary, this.statePath);
		};
		this.saveQueue = this.saveQueue.then(save, save);
		await this.saveQueue;
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Model-center listeners must not affect polling.
			}
		}
	}
}

function emptyState(): PersistedModelCenterState {
	return {
		schemaVersion: 1,
		changes: [],
		news: [],
		unreadChangeIds: [],
		unreadNewsIds: [],
		newsBaselineEstablished: false,
	};
}

function mergeNews(
	existing: OfficialNewsItem[],
	incoming: OfficialNewsItem[],
): OfficialNewsItem[] {
	const byId = new Map(existing.map((item) => [item.guid, item]));
	for (const item of incoming) {
		byId.set(item.guid, item);
	}
	return [...byId.values()]
		.sort((left, right) => right.publishedAt - left.publishedAt)
		.slice(0, MAX_NEWS_ITEMS);
}

function mergeChanges(
	existing: ModelChange[],
	incoming: ModelChange[],
	now: number,
): ModelChange[] {
	const byId = new Map(existing.map((change) => [change.id, change]));
	for (const change of incoming) {
		byId.set(change.id, change);
	}
	const cutoff = now - RETENTION_MS;
	return [...byId.values()]
		.filter((change) => change.detectedAt >= cutoff)
		.sort((left, right) => right.detectedAt - left.detectedAt)
		.slice(0, MAX_CHANGE_ITEMS);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function parseModelChange(value: unknown): ModelChange | undefined {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.detectedAt !== "number" ||
		typeof value.kind !== "string" ||
		typeof value.modelId !== "string" ||
		typeof value.modelName !== "string" ||
		typeof value.title !== "string" ||
		!Array.isArray(value.details)
	) {
		return undefined;
	}
	return value as unknown as ModelChange;
}

function parseNewsItem(value: unknown): OfficialNewsItem | undefined {
	if (
		!isRecord(value) ||
		typeof value.guid !== "string" ||
		typeof value.title !== "string" ||
		typeof value.link !== "string" ||
		typeof value.publishedAt !== "number"
	) {
		return undefined;
	}
	return {
		guid: value.guid,
		title: value.title,
		link: value.link,
		description:
			typeof value.description === "string" ? value.description : "",
		publishedAt: value.publishedAt,
	};
}

function parseAutoSync(value: unknown): AutoSyncResult | undefined {
	if (!isRecord(value) || typeof value.status !== "string") {
		return undefined;
	}
	if (
		value.status !== "synced" &&
		value.status !== "skipped" &&
		value.status !== "failed"
	) {
		return undefined;
	}
	return {
		status: value.status,
		detail: stringValue(value.detail),
		count: numeric(value.count),
	};
}

function planValue(value: unknown): GoPlan | undefined {
	return value === "go" || value === "go-plus" || value === "go-teams"
		? value
		: undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.length > 0,
			)
		: [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function isAlreadyExists(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as NodeJS.ErrnoException).code === "EEXIST"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
