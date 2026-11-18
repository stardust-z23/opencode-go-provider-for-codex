import { UsageStore } from "./usageStore";

let usageStore: UsageStore | undefined;

export function setUsageStore(store: UsageStore): void {
	usageStore = store;
}

export function getUsageStore(): UsageStore | undefined {
	return usageStore;
}

export async function disposeUsageStore(): Promise<void> {
	const store = usageStore;
	usageStore = undefined;
	await store?.flush();
}
