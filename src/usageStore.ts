import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import {
	buildUsageSnapshot,
	type CacheStatusSummary,
	createUsageRecord,
	getCacheStatusSummary,
	parseUsageRecord,
	type UsageDashboardSnapshot,
	type UsageRecord,
	type UsageRecordQuery,
} from "./usageStats";

const RETENTION_DAYS = 30;
const LOAD_DAYS = 7;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_MEMORY_RECORDS = 20_000;

interface UsageStoreOptions {
	onError?: (message: string, detail?: Record<string, unknown>) => void;
}

export class UsageStore {
	private readonly usageDir: string;
	private readonly onError?: UsageStoreOptions["onError"];
	private readonly records = new Map<string, UsageRecord>();
	private readonly listeners = new Set<() => void>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(storageRoot: string, options: UsageStoreOptions = {}) {
		this.usageDir = path.join(storageRoot, "usage");
		this.onError = options.onError;
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.usageDir, { recursive: true });
		await this.cleanup();
		await this.reload();
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const files = await this.listFiles();
		const selected = files.slice(0, LOAD_DAYS);
		const loaded = new Map<string, UsageRecord>();
		for (const file of selected) {
			let text = "";
			try {
				text = await fs.readFile(path.join(this.usageDir, file.name), "utf8");
			} catch (error) {
				this.reportError("usageStore.read.failed", {
					file: file.name,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			for (const line of text.split(/\r?\n/)) {
				if (!line.trim()) {
					continue;
				}
				try {
					const record = parseUsageRecord(JSON.parse(line));
					if (record) {
						loaded.set(record.id, record);
					}
				} catch {
					// A partial trailing line must not hide the rest of the file.
				}
			}
		}
		const newest = [...loaded.values()]
			.sort((left, right) => right.startedAt - left.startedAt)
			.slice(0, MAX_MEMORY_RECORDS);
		this.records.clear();
		for (const record of newest) {
			this.records.set(record.id, record);
		}
		this.notify();
	}

	handleProxyLog(message: string, detail?: Record<string, unknown>): void {
		const record = createUsageRecord(message, detail, randomUUID());
		if (!record) {
			return;
		}
		if (this.records.has(record.id)) {
			return;
		}
		this.records.set(record.id, record);
		this.trimMemory();
		this.persist(record);
		this.notify();
	}

	getSnapshot(query: UsageRecordQuery): UsageDashboardSnapshot {
		return buildUsageSnapshot([...this.records.values()], query);
	}

	getStatusSummary(now = Date.now()): CacheStatusSummary {
		return getCacheStatusSummary([...this.records.values()], now);
	}

	getLatestRecordAt(): number | undefined {
		let latest: number | undefined;
		for (const record of this.records.values()) {
			if (latest === undefined || record.startedAt > latest) {
				latest = record.startedAt;
			}
		}
		return latest;
	}

	onDidChange(listener: () => void): { dispose: () => void } {
		this.listeners.add(listener);
		return {
			dispose: () => this.listeners.delete(listener),
		};
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	private persist(record: UsageRecord): void {
		const fileName = `${localDateKey(record.startedAt)}.jsonl`;
		const filePath = path.join(this.usageDir, fileName);
		const line = `${JSON.stringify(record)}\n`;
		this.writeQueue = this.writeQueue
			.then(async () => {
				await fs.mkdir(this.usageDir, { recursive: true });
				await fs.appendFile(filePath, line, "utf8");
			})
			.catch((error) => {
				this.reportError("usageStore.write.failed", {
					file: fileName,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	private trimMemory(): void {
		if (this.records.size <= MAX_MEMORY_RECORDS) {
			return;
		}
		const oldest = [...this.records.values()]
			.sort((left, right) => left.startedAt - right.startedAt)
			.slice(0, this.records.size - MAX_MEMORY_RECORDS);
		for (const record of oldest) {
			this.records.delete(record.id);
		}
	}

	private async cleanup(): Promise<void> {
		const files = await this.listFiles();
		const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
		let totalBytes = 0;
		for (const file of files) {
			const timestamp = dateKeyTimestamp(file.name);
			if (timestamp !== undefined && timestamp < cutoff) {
				await this.removeFile(file.name);
				continue;
			}
			totalBytes += file.size;
		}
		for (const file of [...files].reverse()) {
			if (totalBytes <= MAX_TOTAL_BYTES) {
				break;
			}
			const removed = await this.removeFile(file.name);
			if (removed) {
				totalBytes -= file.size;
			}
		}
	}

	private async removeFile(name: string): Promise<boolean> {
		try {
			await fs.unlink(path.join(this.usageDir, name));
			return true;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null
					? (error as { code?: string }).code
					: undefined;
			if (code !== "ENOENT") {
				this.reportError("usageStore.remove.failed", {
					file: name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			return false;
		}
	}

	private async listFiles(): Promise<Array<{ name: string; size: number }>> {
		const entries = await fs.readdir(this.usageDir, { withFileTypes: true });
		const files: Array<{ name: string; size: number }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
				continue;
			}
			const stat = await fs.stat(path.join(this.usageDir, entry.name));
			files.push({ name: entry.name, size: stat.size });
		}
		return files.sort((left, right) => right.name.localeCompare(left.name));
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A dashboard listener must not interfere with proxy traffic.
			}
		}
	}

	private reportError(message: string, detail?: Record<string, unknown>): void {
		try {
			this.onError?.(message, detail);
		} catch {
			// Usage logging is best-effort.
		}
	}
}

function localDateKey(timestamp: number): string {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function dateKeyTimestamp(fileName: string): number | undefined {
	const match = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(fileName);
	if (!match) {
		return undefined;
	}
	const date = new Date(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
		0,
		0,
		0,
		0,
	);
	return Number.isFinite(date.getTime()) ? date.getTime() : undefined;
}
