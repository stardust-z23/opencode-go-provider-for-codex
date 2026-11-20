export type GoPlan = "go" | "go-plus" | "go-teams";

export type ModelCacheWritePrice = number | Record<string, unknown> | null;

export interface GoModelInfo {
	id: string;
	name: string;
	canonicalId?: string;
	family?: string;
	ownedBy?: string;
	created?: number;
	releaseDate?: string;
	lastUpdated?: string;
	description?: string;
	recommendedApi?: string;
	inputModalities: string[];
	outputModalities: string[];
	openWeights?: boolean;
	contextLimit?: number;
	outputLimit?: number;
	monthlyUsage: Record<GoPlan, number | null>;
	requestsPerFiveHours?: Record<GoPlan, number | null>;
	training: boolean;
	zdr: boolean;
	limitedRegions: boolean;
	limitedTime: boolean;
	featured: boolean;
	deprecated: boolean;
	cost?: Record<string, unknown>;
	api?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
}

export interface ModelCatalogSnapshot {
	schemaVersion: 1;
	fetchedAt: number;
	models: GoModelInfo[];
}

export type ModelChangeKind =
	| "added"
	| "removed"
	| "monthly_usage"
	| "pricing"
	| "limits"
	| "availability"
	| "metadata";

export interface ModelChangeDetail {
	path: string;
	oldValue: unknown;
	newValue: unknown;
}

export interface ModelChange {
	id: string;
	detectedAt: number;
	kind: ModelChangeKind;
	modelId: string;
	modelName: string;
	title: string;
	details: ModelChangeDetail[];
}

export interface ModelChangeSummary {
	template: string;
	values: unknown[];
}

export interface OfficialNewsItem {
	guid: string;
	title: string;
	link: string;
	description: string;
	publishedAt: number;
}

export interface ModelContextPriceTier {
	threshold: number;
	comparison: "gt" | "gte";
	input: number | null;
	cacheRead: number | null;
	cacheWrite: ModelCacheWritePrice;
	output: number | null;
}

export interface ModelTimePriceRule {
	factor: number;
	dates?: {
		gte?: string;
		lt?: string;
	};
	days?: string[];
	periods?: Array<{
		gte?: string;
		lt?: string;
	}>;
}

const GO_PLANS: GoPlan[] = ["go", "go-plus", "go-teams"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.length > 0,
			)
		: [];
}

function boolValue(value: unknown): boolean {
	return value === true;
}

function planUsages(value: unknown): Record<GoPlan, number | null> {
	if (!isRecord(value)) {
		return { go: null, "go-plus": null, "go-teams": null };
	}
	return {
		go: optionalNumber(value.go) ?? null,
		"go-plus": optionalNumber(value["go-plus"]) ?? null,
		"go-teams": optionalNumber(value["go-teams"]) ?? null,
	};
}

function planRequests(value: unknown): Record<GoPlan, number | null> | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { go: value, "go-plus": value, "go-teams": value };
	}
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		go: optionalNumber(value.go) ?? null,
		"go-plus": optionalNumber(value["go-plus"]) ?? null,
		"go-teams": optionalNumber(value["go-teams"]) ?? null,
	};
}

export function normalizeModelInfo(value: unknown): GoModelInfo | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const id = optionalString(value.id);
	if (!id) {
		return undefined;
	}
	const goRaw = isRecord(value.go) ? value.go : {};
	const limit = isRecord(value.limit) ? value.limit : {};
	const modalities = isRecord(value.modalities) ? value.modalities : {};
	const monthlyUsage = planUsages(
		goRaw.monthly_usage ?? value.monthlyUsage,
	);
	const requestsPerFiveHours =
		planRequests(goRaw.requests) ??
		planRequests(value.requestsPerFiveHours);
	const basePrice = isRecord(value.cost) ? getBasePrice(value.cost) : undefined;
	return {
		id,
		name: optionalString(value.name) ?? id,
		canonicalId:
			optionalString(value.canonical_id) ??
			optionalString(value.canonicalId),
		family: optionalString(value.family),
		ownedBy:
			optionalString(value.owned_by) ??
			optionalString(value.ownedBy),
		created: optionalNumber(value.created),
		releaseDate:
			optionalString(value.release_date) ??
			optionalString(value.releaseDate),
		lastUpdated:
			optionalString(value.last_updated) ??
			optionalString(value.lastUpdated),
		description: optionalString(value.description),
		recommendedApi:
			optionalString(value.recommended_api) ??
			optionalString(value.recommendedApi),
		inputModalities:
			stringArray(modalities.input).length > 0
				? stringArray(modalities.input)
				: stringArray(value.inputModalities),
		outputModalities:
			stringArray(modalities.output).length > 0
				? stringArray(modalities.output)
				: stringArray(value.outputModalities),
		openWeights:
			typeof value.open_weights === "boolean"
				? value.open_weights
				: typeof value.openWeights === "boolean"
					? value.openWeights
					: undefined,
		contextLimit:
			optionalNumber(limit.context) ??
			optionalNumber(value.contextLimit),
		outputLimit:
			optionalNumber(limit.output) ??
			optionalNumber(value.outputLimit),
		monthlyUsage,
		requestsPerFiveHours,
		training:
			typeof goRaw.training === "boolean"
				? goRaw.training
				: boolValue(value.training),
		zdr:
			typeof goRaw.zdr === "boolean"
				? goRaw.zdr
				: boolValue(value.zdr),
		limitedRegions:
			typeof goRaw.limited_regions === "boolean"
				? goRaw.limited_regions
				: boolValue(value.limitedRegions),
		limitedTime:
			monthlyUsage.go === null &&
			monthlyUsage["go-plus"] === null &&
			monthlyUsage["go-teams"] === null &&
			basePrice?.input === 0 &&
			basePrice.output === 0,
		featured:
			typeof goRaw.featured === "boolean"
				? goRaw.featured
				: boolValue(value.featured),
		deprecated:
			value.deprecated === true ||
			String(value.status ?? "").toLowerCase() === "deprecated",
		cost: isRecord(value.cost) ? value.cost : undefined,
		api: isRecord(value.api) ? value.api : undefined,
		capabilities: isRecord(value.capabilities) ? value.capabilities : undefined,
	};
}

export function normalizeModelCatalog(payload: unknown, fetchedAt = Date.now()): ModelCatalogSnapshot {
	const data =
		isRecord(payload) && Array.isArray(payload.data)
			? payload.data
			: Array.isArray(payload)
				? payload
				: [];
	const models = data
		.map(normalizeModelInfo)
		.filter((model): model is GoModelInfo => model !== undefined)
		.sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
	return {
		schemaVersion: 1,
		fetchedAt,
		models,
	};
}

export function getBasePrice(cost: Record<string, unknown> | undefined): {
	input: number | null;
	cacheRead: number | null;
	cacheWrite: ModelCacheWritePrice;
	output: number | null;
} {
	const text = cost && isRecord(cost.text) ? cost.text : {};
	const input = isRecord(text.input) ? text.input : {};
	const output = isRecord(text.output) ? text.output : {};
	const cache = isRecord(input.cache) ? input.cache : {};
	return {
		input: optionalNumber(input.price) ?? null,
		cacheRead: optionalNumber(cache.read) ?? null,
		cacheWrite:
			optionalNumber(cache.write) ??
			(isRecord(cache.write) ? cache.write : null),
		output: optionalNumber(output.price) ?? null,
	};
}

function stableStringify(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? String(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(",")}}`;
}

function stableHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, "0");
}

function createChange(
	now: number,
	kind: ModelChangeKind,
	model: GoModelInfo,
	title: string,
	details: ModelChangeDetail[],
): ModelChange {
	const fingerprint = stableHash(
		stableStringify({
			kind,
			modelId: model.id,
			title,
			details,
		}),
	);
	return {
		id: `${now}-${kind}-${model.id}-${fingerprint}`,
		detectedAt: now,
		kind,
		modelId: model.id,
		modelName: model.name,
		title,
		details,
	};
}

export function diffModelCatalogs(
	previous: ModelCatalogSnapshot | undefined,
	next: ModelCatalogSnapshot,
	now = Date.now(),
): ModelChange[] {
	if (!previous) {
		return [];
	}
	const previousById = new Map(previous.models.map((model) => [model.id, model]));
	const nextById = new Map(next.models.map((model) => [model.id, model]));
	const changes: ModelChange[] = [];

	for (const model of next.models) {
		const old = previousById.get(model.id);
		if (!old) {
			changes.push(
				createChange(now, "added", model, "New model", [
					{ path: "name", oldValue: undefined, newValue: model.name },
				]),
			);
			continue;
		}

		const usageDetails: ModelChangeDetail[] = [];
		for (const plan of GO_PLANS) {
			if (old.monthlyUsage[plan] !== model.monthlyUsage[plan]) {
				usageDetails.push({
					path: `monthlyUsage.${plan}`,
					oldValue: old.monthlyUsage[plan],
					newValue: model.monthlyUsage[plan],
				});
			}
			const oldRequests =
				old.requestsPerFiveHours?.[plan] ?? null;
			const newRequests =
				model.requestsPerFiveHours?.[plan] ?? null;
			if (oldRequests !== newRequests) {
				usageDetails.push({
					path: `requestsPerFiveHours.${plan}`,
					oldValue: oldRequests,
					newValue: newRequests,
				});
			}
		}
		if (usageDetails.length > 0) {
			changes.push(
				createChange(
					now,
					"monthly_usage",
					model,
					"Monthly allowance changed",
					usageDetails,
				),
			);
		}

		if (stableStringify(old.cost) !== stableStringify(model.cost)) {
			changes.push(
				createChange(now, "pricing", model, "Pricing rules changed", [
					{
						path: "cost",
						oldValue: old.cost,
						newValue: model.cost,
					},
				]),
			);
		}

		const limitDetails: ModelChangeDetail[] = [];
		for (const key of ["contextLimit", "outputLimit"] as const) {
			if (old[key] !== undefined && old[key] !== model[key]) {
				limitDetails.push({
					path: key,
					oldValue: old[key],
					newValue: model[key],
				});
			}
		}
		if (limitDetails.length > 0) {
			changes.push(
				createChange(now, "limits", model, "Model limits changed", limitDetails),
			);
		}

		const availabilityDetails: ModelChangeDetail[] = [];
		for (const key of [
			"training",
			"zdr",
			"limitedRegions",
			"limitedTime",
			"featured",
			"deprecated",
		] as const) {
			if (old[key] !== undefined && old[key] !== model[key]) {
				availabilityDetails.push({
					path: key,
					oldValue: old[key],
					newValue: model[key],
				});
			}
		}
		if (availabilityDetails.length > 0) {
			changes.push(
				createChange(
					now,
					"availability",
					model,
					"Availability or data policy changed",
					availabilityDetails,
				),
			);
		}

		const metadataDetails: ModelChangeDetail[] = [];
		for (const key of [
			"name",
			"canonicalId",
			"family",
			"ownedBy",
			"description",
			"releaseDate",
			"lastUpdated",
			"recommendedApi",
			"openWeights",
		] as const) {
			if (old[key] !== model[key]) {
				metadataDetails.push({
					path: key,
					oldValue: old[key],
					newValue: model[key],
				});
			}
		}
		if (
			old.capabilities !== undefined &&
			stableStringify(old.capabilities) !==
				stableStringify(model.capabilities)
		) {
			metadataDetails.push({
				path: "capabilities",
				oldValue: old.capabilities,
				newValue: model.capabilities,
			});
		}
		if (
			old.api !== undefined &&
			stableStringify(old.api) !== stableStringify(model.api)
		) {
			metadataDetails.push({
				path: "api",
				oldValue: old.api,
				newValue: model.api,
			});
		}
		if (
			stableStringify(old.inputModalities) !==
				stableStringify(model.inputModalities) ||
			stableStringify(old.outputModalities) !==
				stableStringify(model.outputModalities)
		) {
			metadataDetails.push(
				{
					path: "inputModalities",
					oldValue: old.inputModalities,
					newValue: model.inputModalities,
				},
				{
					path: "outputModalities",
					oldValue: old.outputModalities,
					newValue: model.outputModalities,
				},
			);
		}
		if (metadataDetails.length > 0) {
			changes.push(
				createChange(now, "metadata", model, "Model metadata changed", metadataDetails),
			);
		}
	}

	for (const model of previous.models) {
		if (!nextById.has(model.id)) {
			changes.push(
				createChange(now, "removed", model, "Model removed", [
					{ path: "name", oldValue: model.name, newValue: undefined },
				]),
			);
		}
	}

	return changes;
}

export function summarizeModelChange(change: ModelChange): ModelChangeSummary[] {
	const summaries: ModelChangeSummary[] = [];
	const add = (
		template: string,
		...values: unknown[]
	): void => {
		summaries.push({ template, values });
	};

	if (change.kind === "added") {
		add("Added to the OpenCode Go catalog.");
	} else if (change.kind === "removed") {
		add("Removed from the OpenCode Go catalog.");
	}

	const detailsByPath = new Map(
		change.details.map((detail) => [detail.path, detail]),
	);
	if (change.kind === "monthly_usage") {
		for (const detail of change.details) {
			const [field, plan] = detail.path.split(".");
			const planLabel = planSummaryLabel(plan);
			if (field === "monthlyUsage") {
				if (detail.oldValue === null && typeof detail.newValue === "number") {
					add(
						"Monthly allowance for {0} is now {1}.",
						planLabel,
						detail.newValue,
					);
				} else if (
					typeof detail.oldValue === "number" &&
					detail.newValue === null
				) {
					add("The {0} monthly allowance was removed.", planLabel);
				} else {
					add(
						"{0} monthly allowance changed from {1} to {2}.",
						planLabel,
						detail.oldValue,
						detail.newValue,
					);
				}
			} else if (field === "requestsPerFiveHours") {
				add(
					"{0} request limit changed from {1} to {2} per five hours.",
					planLabel,
					detail.oldValue,
					detail.newValue,
				);
			}
		}
	}

	if (change.kind === "pricing") {
		const detail = detailsByPath.get("cost");
		if (detail) {
			summarizeCostChange(detail, add);
		}
	}

	if (change.kind === "limits") {
		const context = detailsByPath.get("contextLimit");
		if (context) {
			add(
				"Context window changed from {0} to {1} tokens.",
				context.oldValue,
				context.newValue,
			);
		}
		const output = detailsByPath.get("outputLimit");
		if (output) {
			add(
				"Maximum output changed from {0} to {1} tokens.",
				output.oldValue,
				output.newValue,
			);
		}
	}

	if (change.kind === "availability") {
		for (const detail of change.details) {
			const oldEnabled = detail.oldValue === true;
			const newEnabled = detail.newValue === true;
			switch (detail.path) {
				case "training":
					add(
						"Training-data use changed from {0} to {1}.",
						oldEnabled ? "allowed" : "not allowed",
						newEnabled ? "allowed" : "not allowed",
					);
					break;
				case "zdr":
					add(
						"Zero data retention changed from {0} to {1}.",
						oldEnabled ? "enabled" : "disabled",
						newEnabled ? "enabled" : "disabled",
					);
					break;
				case "limitedRegions":
					add(
						"Regional restrictions changed from {0} to {1}.",
						oldEnabled ? "enabled" : "disabled",
						newEnabled ? "enabled" : "disabled",
					);
					break;
				case "limitedTime":
					add(
						"Limited-time availability changed from {0} to {1}.",
						oldEnabled ? "enabled" : "disabled",
						newEnabled ? "enabled" : "disabled",
					);
					break;
				case "featured":
					add(
						"Featured status changed from {0} to {1}.",
						oldEnabled ? "enabled" : "disabled",
						newEnabled ? "enabled" : "disabled",
					);
					break;
				case "deprecated":
					add(
						newEnabled
							? "The model was marked as deprecated."
							: "The model is no longer marked as deprecated.",
					);
					break;
			}
		}
	}

	if (change.kind === "metadata") {
		const name = detailsByPath.get("name");
		if (name) {
			add(
				"Model name changed from {0} to {1}.",
				name.oldValue,
				name.newValue,
			);
		}
		const description = detailsByPath.get("description");
		if (description) {
			add("Model description updated.");
		}
		const lastUpdated = detailsByPath.get("lastUpdated");
		if (lastUpdated) {
			add(
				"Last-updated date changed from {0} to {1}.",
				lastUpdated.oldValue,
				lastUpdated.newValue,
			);
		}
		const releaseDate = detailsByPath.get("releaseDate");
		if (releaseDate) {
			add(
				"Release date changed from {0} to {1}.",
				releaseDate.oldValue,
				releaseDate.newValue,
			);
		}
		const recommendedApi = detailsByPath.get("recommendedApi");
		if (recommendedApi) {
			add(
				"Recommended API changed from {0} to {1}.",
				apiSummaryLabel(recommendedApi.oldValue),
				apiSummaryLabel(recommendedApi.newValue),
			);
		}
		const capabilities = detailsByPath.get("capabilities");
		if (capabilities) {
			if (
				stableStringify(capabilities.oldValue) ===
				stableStringify(capabilities.newValue)
			) {
				add("Model capabilities are unchanged.");
			} else {
				summarizeCapabilities(capabilities, add);
			}
		}
		const api = detailsByPath.get("api");
		if (api) {
			summarizeApiChange(api, add);
		}
		summarizeModalities(
			detailsByPath.get("inputModalities"),
			"input",
			add,
		);
		summarizeModalities(
			detailsByPath.get("outputModalities"),
			"output",
			add,
		);
		for (const path of ["canonicalId", "family", "ownedBy", "openWeights"]) {
			const detail = detailsByPath.get(path);
			if (detail) {
				add("Model catalog metadata was updated.");
				break;
			}
		}
		if (summaries.length === 0 && change.details.length > 0) {
			add("Model metadata changed.");
		}
	}

	const seen = new Set<string>();
	return summaries.filter((entry) => {
		const key = `${entry.template}\u0000${JSON.stringify(entry.values)}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	}).slice(0, 8);
}

function planSummaryLabel(plan: string | undefined): string {
	if (plan === "go") {
		return "Go";
	}
	if (plan === "go-plus") {
		return "Go Plus";
	}
	if (plan === "go-teams") {
		return "Go Teams";
	}
	return plan ?? "Plan";
}

type AddSummary = (
	template: string,
	...values: unknown[]
) => void;

function summarizeCostChange(detail: ModelChangeDetail, add: AddSummary): void {
	const oldCost = isRecord(detail.oldValue) ? detail.oldValue : {};
	const newCost = isRecord(detail.newValue) ? detail.newValue : {};
	let addedSpecificSummary = false;
	const addSpecific: AddSummary = (template, ...values) => {
		addedSpecificSummary = true;
		add(template, ...values);
	};
	const changed = (path: string): boolean =>
		stableStringify(valueAtPath(oldCost, path)) !==
		stableStringify(valueAtPath(newCost, path));
	const addPrice = (
		path: string,
		template: string,
	): void => {
		if (!changed(path)) {
			return;
		}
		addSpecific(
			template,
			valueAtPath(oldCost, path),
			valueAtPath(newCost, path),
		);
	};

	addPrice(
		"text.input.price",
		"Input token price changed from {0} to {1} USD per 1M tokens.",
	);
	addPrice(
		"text.input.cache.read",
		"Cache-read price changed from {0} to {1} USD per 1M tokens.",
	);
	addPrice(
		"text.input.cache.write",
		"Cache-write price changed from {0} to {1}.",
	);
	addPrice(
		"text.output.price",
		"Output token price changed from {0} to {1} USD per 1M tokens.",
	);
	addPrice(
		"audio.input.price",
		"Audio input price changed from {0} to {1}.",
	);
	if (changed("text.input.overrides")) {
		addSpecific("Context-tier input pricing changed.");
	}
	if (changed("text.output.overrides")) {
		addSpecific("Context-tier output pricing changed.");
	}
	if (changed("multipliers")) {
		addSpecific("Time-based pricing multipliers changed.");
	}
	if (
		!addedSpecificSummary &&
		stableStringify(oldCost) !== stableStringify(newCost)
	) {
		add("Pricing rules changed.");
	}
}

function valueAtPath(root: Record<string, unknown>, path: string): unknown {
	let current: unknown = root;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function summarizeCapabilities(
	detail: ModelChangeDetail,
	add: AddSummary,
): void {
	const oldCapabilities = isRecord(detail.oldValue)
		? detail.oldValue
		: {};
	const newCapabilities = isRecord(detail.newValue)
		? detail.newValue
		: {};
	const changed = (path: string): boolean =>
		stableStringify(valueAtPath(oldCapabilities, path)) !==
		stableStringify(valueAtPath(newCapabilities, path));

	if (changed("tools.supported")) {
		add(
			"Tool-use support changed from {0} to {1}.",
			valueAtPath(oldCapabilities, "tools.supported"),
			valueAtPath(newCapabilities, "tools.supported"),
		);
	}
	if (changed("reasoning.supported")) {
		add(
			"Reasoning support changed from {0} to {1}.",
			valueAtPath(oldCapabilities, "reasoning.supported"),
			valueAtPath(newCapabilities, "reasoning.supported"),
		);
	}
	if (changed("reasoning.effort")) {
		add(
			"Reasoning effort levels changed from {0} to {1}.",
			summaryList(valueAtPath(oldCapabilities, "reasoning.effort")),
			summaryList(valueAtPath(newCapabilities, "reasoning.effort")),
		);
	}
	if (changed("cache.implicit")) {
		add(
			"Implicit prompt caching changed from {0} to {1}.",
			valueAtPath(oldCapabilities, "cache.implicit"),
			valueAtPath(newCapabilities, "cache.implicit"),
		);
	}
	if (changed("structured_output")) {
		add(
			"Structured-output support changed from {0} to {1}.",
			valueAtPath(oldCapabilities, "structured_output"),
			valueAtPath(newCapabilities, "structured_output"),
		);
	}
	if (!changed("tools.supported") &&
		!changed("reasoning.supported") &&
		!changed("reasoning.effort") &&
		!changed("cache.implicit") &&
		!changed("structured_output")) {
		add("Model capability settings changed.");
	}
}

function summarizeApiChange(
	detail: ModelChangeDetail,
	add: AddSummary,
): void {
	const oldApi = isRecord(detail.oldValue) ? detail.oldValue : {};
	const newApi = isRecord(detail.newValue) ? detail.newValue : {};
	const oldKeys = Object.keys(oldApi);
	const newKeys = Object.keys(newApi);
	const added = newKeys.filter((key) => !oldKeys.includes(key));
	const removed = oldKeys.filter((key) => !newKeys.includes(key));
	const retained = oldKeys.filter((key) => newKeys.includes(key));

	for (const key of added) {
		add("Added the {0} API adapter.", apiSummaryLabel(key));
	}
	for (const key of removed) {
		add("Removed the {0} API adapter.", apiSummaryLabel(key));
	}
	if (added.length > 0 || removed.length > 0) {
		for (const key of retained) {
			if (stableStringify(oldApi[key]) === stableStringify(newApi[key])) {
				add("Existing {0} API adapter remains available.", apiSummaryLabel(key));
			}
		}
	}
	for (const key of retained) {
		if (stableStringify(oldApi[key]) !== stableStringify(newApi[key])) {
			add(
				"Configuration changed for the {0} API adapter.",
				apiSummaryLabel(key),
			);
		}
	}
}

function summarizeModalities(
	detail: ModelChangeDetail | undefined,
	direction: "input" | "output",
	add: AddSummary,
): void {
	if (!detail) {
		return;
	}
	const oldValues = Array.isArray(detail.oldValue)
		? detail.oldValue.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const newValues = Array.isArray(detail.newValue)
		? detail.newValue.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const added = newValues.filter((value) => !oldValues.includes(value));
	const removed = oldValues.filter((value) => !newValues.includes(value));
	if (added.length > 0) {
		add(
			"Added supported {0} types: {1}.",
			direction,
			added.join(", "),
		);
	}
	if (removed.length > 0) {
		add(
			"Removed supported {0} types: {1}.",
			direction,
			removed.join(", "),
		);
	}
}

function summaryList(value: unknown): string {
	return Array.isArray(value)
		? value.filter((item) => typeof item === "string").join(", ")
		: String(value ?? "none");
}

function apiSummaryLabel(value: unknown): string {
	if (typeof value !== "string" || !value) {
		return "unknown";
	}
	const labels: Record<string, string> = {
		responses: "Responses",
		"chat-completions": "Chat Completions",
		chat: "Chat Completions",
		messages: "Messages",
		"anthropic-messages": "Messages",
		"generate-content": "Generate Content",
		interactions: "Interactions",
	};
	return labels[value] ?? value;
}

export function removeLegacyHydrationChangeBatches(
	changes: ModelChange[],
): {
	changes: ModelChange[];
	removedChanges: number;
	removedModels: number;
	batches: number;
} {
	const byTimestamp = new Map<number, ModelChange[]>();
	for (const change of changes) {
		const batch = byTimestamp.get(change.detectedAt) ?? [];
		batch.push(change);
		byTimestamp.set(change.detectedAt, batch);
	}
	const suspicious = new Set<number>();
	let removedChanges = 0;
	let removedModels = 0;
	for (const [detectedAt, batch] of byTimestamp) {
		const models = new Set(batch.map((change) => change.modelId));
		const metadata = batch.filter(
			(change) =>
				change.kind === "metadata" || change.kind === "limits",
		).length;
		if (
			batch.length >= 20 &&
			models.size >= 10 &&
			metadata >= Math.ceil(batch.length / 2)
		) {
			suspicious.add(detectedAt);
			removedChanges += batch.length;
			removedModels = Math.max(removedModels, models.size);
		}
	}
	return {
		changes: changes.filter(
			(change) => !suspicious.has(change.detectedAt),
		),
		removedChanges,
		removedModels,
		batches: suspicious.size,
	};
}

function decodeXml(value: string): string {
	return value
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&#39;", "'")
		.trim();
}

function xmlTag(block: string, tag: string): string {
	const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
	return match ? decodeXml(match[1]) : "";
}

export function parseOfficialNewsFeed(xml: string): OfficialNewsItem[] {
	return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
		.map((match) => {
			const block = match[1];
			const rawLink = xmlTag(block, "link");
			let link = "";
			try {
				const parsed = new URL(rawLink, "https://opencode.ai");
				if (parsed.protocol === "https:" && parsed.hostname === "opencode.ai") {
					link = parsed.toString();
				}
			} catch {
				// Ignore malformed feed links rather than exposing arbitrary URLs.
			}
			const guid = xmlTag(block, "guid") || link;
			const title = xmlTag(block, "title");
			const publishedAt = Date.parse(xmlTag(block, "pubDate"));
			if (!guid || !title || !link || !Number.isFinite(publishedAt)) {
				return undefined;
			}
			return {
				guid,
				title,
				link,
				description: xmlTag(block, "description"),
				publishedAt,
			};
		})
		.filter((item): item is OfficialNewsItem => item !== undefined)
		.sort((left, right) => right.publishedAt - left.publishedAt);
}

export function modelHasContextPricing(model: GoModelInfo): boolean {
	const text = model.cost && isRecord(model.cost.text) ? model.cost.text : {};
	for (const section of ["input", "output"]) {
		const entry = isRecord(text[section]) ? text[section] : {};
		if (Array.isArray(entry.overrides) && entry.overrides.length > 0) {
			return true;
		}
	}
	return false;
}

export function modelHasTimeMultiplier(model: GoModelInfo): boolean {
	return Boolean(
		model.cost &&
			Array.isArray(model.cost.multipliers) &&
			model.cost.multipliers.length,
	);
}

export function effectiveModelPrice(
	model: GoModelInfo,
	now = Date.now(),
): {
	input: number | null;
	cacheRead: number | null;
	cacheWrite: ModelCacheWritePrice;
	output: number | null;
	multiplier: number;
	label?: string;
} {
	const base = getBasePrice(model.cost);
	const multipliers =
		model.cost && Array.isArray(model.cost.multipliers)
			? model.cost.multipliers.filter(isRecord)
			: [];
	for (const rule of multipliers) {
		if (!multiplierMatches(rule.when, now)) {
			continue;
		}
		const factor = optionalNumber(rule.factor);
		if (factor === undefined) {
			continue;
		}
		return {
			input: base.input === null ? null : base.input * factor,
			cacheRead: base.cacheRead === null ? null : base.cacheRead * factor,
			cacheWrite:
				typeof base.cacheWrite === "number"
					? base.cacheWrite * factor
					: base.cacheWrite,
			output: base.output === null ? null : base.output * factor,
			multiplier: factor,
			label: factor === 2 ? "Peak" : `${factor}x`,
		};
	}
	return { ...base, multiplier: 1 };
}

function priceOverrideThreshold(rule: Record<string, unknown>): {
	threshold: number;
	comparison: "gt" | "gte";
} | undefined {
	const when = isRecord(rule.when) ? rule.when : {};
	const context = isRecord(when.context) ? when.context : {};
	const gt = optionalNumber(context.gt);
	if (gt !== undefined) {
		return { threshold: gt, comparison: "gt" };
	}
	const gte = optionalNumber(context.gte);
	if (gte !== undefined) {
		return { threshold: gte, comparison: "gte" };
	}
	return undefined;
}

export function modelContextPriceTiers(model: GoModelInfo): ModelContextPriceTier[] {
	const text = model.cost && isRecord(model.cost.text) ? model.cost.text : {};
	const input = isRecord(text.input) ? text.input : {};
	const output = isRecord(text.output) ? text.output : {};
	const outputOverrides = Array.isArray(output.overrides)
		? output.overrides.filter(isRecord)
		: [];
	const inputOverrides = Array.isArray(input.overrides)
		? input.overrides.filter(isRecord)
		: [];
	const thresholds = new Map<
		string,
		{ threshold: number; comparison: "gt" | "gte" }
	>();
	for (const rule of [...inputOverrides, ...outputOverrides]) {
		const threshold = priceOverrideThreshold(rule);
		if (threshold) {
			thresholds.set(`${threshold.comparison}:${threshold.threshold}`, threshold);
		}
	}
	return [...thresholds.values()]
		.sort((left, right) => left.threshold - right.threshold)
		.map((threshold) => {
			const inputRule = inputOverrides.find((rule) => {
				const candidate = priceOverrideThreshold(rule);
				return (
					candidate?.threshold === threshold.threshold &&
					candidate.comparison === threshold.comparison
				);
			});
			const outputRule = outputOverrides.find((rule) => {
				const candidate = priceOverrideThreshold(rule);
				return (
					candidate?.threshold === threshold.threshold &&
					candidate.comparison === threshold.comparison
				);
			});
			const cache =
				inputRule && isRecord(inputRule.cache) ? inputRule.cache : {};
			return {
				...threshold,
				input:
					(inputRule ? optionalNumber(inputRule.price) : undefined) ??
					optionalNumber(input.price) ??
					null,
				cacheRead:
					optionalNumber(cache.read) ??
					(input && isRecord(input.cache)
						? optionalNumber(input.cache.read)
						: undefined) ??
					null,
				cacheWrite:
					optionalNumber(cache.write) ??
					(isRecord(cache.write) ? cache.write : null),
				output:
					(outputRule ? optionalNumber(outputRule.price) : undefined) ??
					optionalNumber(output.price) ??
					null,
			};
		});
}

export function modelTimePriceRules(model: GoModelInfo): ModelTimePriceRule[] {
	const multipliers =
		model.cost && Array.isArray(model.cost.multipliers)
			? model.cost.multipliers.filter(isRecord)
			: [];
	return multipliers
		.map((rule): ModelTimePriceRule | undefined => {
			const factor = optionalNumber(rule.factor);
			const when = isRecord(rule.when) ? rule.when : undefined;
			if (factor === undefined || !when) {
				return undefined;
			}
			const date = isRecord(when.date) ? when.date : undefined;
			const days =
				isRecord(when.utc_days) && Array.isArray(when.utc_days.in)
					? when.utc_days.in.filter(
							(day): day is string => typeof day === "string",
						)
					: undefined;
			const any = Array.isArray(when.any) ? when.any : [];
			const periods = any
				.map((entry): { gte?: string; lt?: string } | undefined => {
					const all =
						isRecord(entry) && Array.isArray(entry.all) ? entry.all : [];
					let gte: string | undefined;
					let lt: string | undefined;
					for (const part of all) {
						if (!isRecord(part) || !isRecord(part.utc_hours)) {
							continue;
						}
						gte ??= optionalString(part.utc_hours.gte);
						lt ??= optionalString(part.utc_hours.lt);
					}
					return gte || lt ? { gte, lt } : undefined;
				})
				.filter(
					(
						period,
					): period is {
						gte?: string;
						lt?: string;
					} => period !== undefined,
				);
			return {
				factor,
				dates: date
					? {
							gte: optionalString(date.gte),
							lt: optionalString(date.lt),
						}
					: undefined,
				days,
				periods: periods.length > 0 ? periods : undefined,
			};
		})
		.filter((rule): rule is ModelTimePriceRule => rule !== undefined);
}

function multiplierMatches(when: unknown, now: number): boolean {
	if (!isRecord(when)) {
		return false;
	}
	const date = new Date(now);
	const dateRule = isRecord(when.date) ? when.date : undefined;
	if (dateRule) {
		const gte = optionalString(dateRule.gte);
		const lt = optionalString(dateRule.lt);
		const dateKey = date.toISOString().slice(0, 10);
		if (gte && dateKey < gte) {
			return false;
		}
		if (lt && dateKey >= lt) {
			return false;
		}
	}
	const daysRule = isRecord(when.utc_days) && Array.isArray(when.utc_days.in)
		? when.utc_days.in.filter((day): day is string => typeof day === "string")
		: undefined;
	if (daysRule) {
		const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][date.getUTCDay()];
		if (!day || !daysRule.includes(day)) {
			return false;
		}
	}
	const anyRules = Array.isArray(when.any) ? when.any : [];
	if (anyRules.length > 0 && !anyRules.some((rule) => timeRuleMatches(rule, date))) {
		return false;
	}
	return Boolean(dateRule || daysRule || anyRules.length > 0);
}

function timeRuleMatches(value: unknown, date: Date): boolean {
	if (!isRecord(value)) {
		return false;
	}
	if (Array.isArray(value.all)) {
		return value.all.every((rule) => timeRuleMatches(rule, date));
	}
	const hours = isRecord(value.utc_hours) ? value.utc_hours : undefined;
	if (!hours) {
		return false;
	}
	const hourText = `${String(date.getUTCHours()).padStart(2, "0")}:${String(
		date.getUTCMinutes(),
	).padStart(2, "0")}`;
	const gte = optionalString(hours.gte);
	const lt = optionalString(hours.lt);
	if (gte && hourText < gte) {
		return false;
	}
	if (lt && hourText >= lt) {
		return false;
	}
	return Boolean(gte || lt);
}
