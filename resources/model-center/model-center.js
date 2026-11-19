(function () {
	"use strict";

	const vscode = acquireVsCodeApi();
	const restored = vscode.getState() || {};
	const state = {
		tab: restored.tab === "updates" ? "updates" : "models",
		search: typeof restored.search === "string" ? restored.search : "",
	};
	let data;
	let labels = {};
	let locale = document.documentElement.lang || "en";
	let generatedAt = Date.now();
	const byId = (id) => document.getElementById(id);
	const number = new Intl.NumberFormat(locale);
	const currency = new Intl.NumberFormat(locale, {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 0,
		maximumFractionDigits: 4,
	});
	const compact = new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	const dateTime = new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const dateOnly = new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});

	window.addEventListener("message", (event) => {
		const message = event.data;
		if (!message || message.type !== "snapshot") return;
		data = message.data;
		labels = message.labels || {};
		locale = message.locale || locale;
		generatedAt = message.generatedAt || Date.now();
		render();
	});

	byId("refresh-button").addEventListener("click", () => {
		const button = byId("refresh-button");
		button.classList.remove("refreshing");
		void button.offsetWidth;
		button.classList.add("refreshing");
		setTimeout(() => button.classList.remove("refreshing"), 750);
		renderRefreshing();
		vscode.postMessage({ type: "refresh" });
	});
	byId("usage-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openUsage" }),
	);
	byId("limits-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openLimits" }),
	);
	byId("pricing-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openPricing" }),
	);
	byId("mobile-limits-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openLimits" }),
	);
	byId("mobile-pricing-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openPricing" }),
	);
	byId("model-search").addEventListener("input", (event) => {
		state.search = event.target.value;
		saveState();
		renderModels();
	});
	byId("models-tab").addEventListener("click", () => setTab("models"));
	byId("updates-tab").addEventListener("click", () => setTab("updates"));

	vscode.postMessage({ type: "ready" });

	function render() {
		if (!data) return;
		renderLabels();
		renderTabs();
		renderPlan();
		renderMessages();
		renderModels();
		renderUpdates();
	}

	function renderLabels() {
		byId("page-title").textContent = labels.title;
		byId("page-subtitle").textContent =
			data.fetchedAt === undefined
				? labels.subtitle
				: `${labels.subtitle} · ${formatTemplate(labels.lastModelFetch, [
						dateTime.format(new Date(data.fetchedAt)),
					])}`;
		byId("models-tab").textContent = labels.modelsTab;
		byId("updates-tab").textContent = labels.updatesTab;
		byId("plan-label").textContent = labels.plan;
		byId("limits-button").textContent = labels.officialLimits;
		byId("pricing-button").textContent = labels.officialPricing;
		byId("mobile-limits-button").textContent = labels.officialLimits;
		byId("mobile-pricing-button").textContent = labels.officialPricing;
		byId("refresh-button").title = labels.refresh;
		byId("refresh-button").setAttribute("aria-label", labels.refresh);
		byId("usage-button").title = labels.openUsage;
		byId("usage-button").setAttribute("aria-label", labels.openUsage);
		byId("model-search").placeholder = labels.search;
		byId("changes-title").textContent = labels.changes;
		byId("news-title").textContent = labels.officialNews;
		byId("history-window").textContent = labels.historyWindow;
		const search = byId("model-search");
		if (search.value !== state.search) search.value = state.search;
	}

	function renderTabs() {
		const models = state.tab === "models";
		byId("models-tab").setAttribute("aria-selected", String(models));
		byId("updates-tab").setAttribute("aria-selected", String(!models));
		byId("models-tab").tabIndex = models ? 0 : -1;
		byId("updates-tab").tabIndex = models ? -1 : 0;
		byId("models-panel").hidden = !models;
		byId("updates-panel").hidden = models;
	}

	function renderPlan() {
		const segments = [
			[undefined, labels.auto],
			["go", labels.go],
			["go-plus", labels.goPlus],
			["go-teams", labels.goTeams],
		];
		const control = byId("plan-segments");
		control.replaceChildren(
			...segments.map(([value, label]) => {
				const button = element("button", "", label);
				button.type = "button";
				button.setAttribute(
					"aria-pressed",
					String((data.plan.selected || undefined) === value),
				);
				button.addEventListener("click", () =>
					vscode.postMessage({ type: "setPlan", plan: value }),
				);
				return button;
			}),
		);
		const source = byId("plan-source");
		if (data.plan.source === "selected") {
			source.textContent = formatTemplate(labels.manualPlan, [
				planLabel(data.plan.effective),
			]);
		} else if (data.plan.source === "detected") {
			source.textContent = formatTemplate(labels.detectedPlan, [
				planLabel(data.plan.effective),
			]);
		} else {
			source.textContent = labels.defaultPlan;
		}
		const unread = byId("unread-label");
		unread.textContent =
			data.unreadCount > 0
				? formatTemplate(labels.unread, [number.format(data.unreadCount)])
				: "";
	}

	function renderMessages() {
		const modelError = byId("model-error");
		modelError.hidden = !data.modelError;
		modelError.textContent = data.modelError
			? formatTemplate(labels.modelError, [data.modelError])
			: "";
		const newsError = byId("news-error");
		newsError.hidden = !data.newsError;
		newsError.textContent = data.newsError
			? formatTemplate(labels.newsError, [data.newsError])
			: "";
		const sync = byId("sync-state");
		sync.className = "sync-state";
		if (!data.lastAutoSync) {
			sync.hidden = true;
			sync.textContent = "";
			return;
		}
		sync.hidden = false;
		sync.classList.add(data.lastAutoSync.status);
		if (data.lastAutoSync.status === "synced") {
			sync.textContent = labels.lastSyncSynced;
		} else if (data.lastAutoSync.status === "failed") {
			sync.textContent = formatTemplate(labels.lastSyncFailed, [
				data.lastAutoSync.detail || "",
			]);
		} else {
			sync.textContent = formatTemplate(labels.lastSyncSkipped, [
				data.lastAutoSync.detail || "",
			]);
		}
	}

	function renderRefreshing() {
		byId("refresh-button").disabled = true;
		byId("refresh-button").title = labels.refreshing;
	}

	function renderModels() {
		const headers = [
			labels.model,
			labels.monthlyAllowance,
			labels.input,
			labels.cacheRead,
			labels.cacheWrite,
			labels.output,
			labels.context,
			labels.rules,
			labels.availability,
		];
		byId("models-head").replaceChildren(
			...headers.map((label, index) => {
				const th = document.createElement("th");
				th.textContent = index >= 2 && index <= 5
					? `${label} (${labels.perMillion})`
					: label;
				return th;
			}),
		);
		const query = state.search.trim().toLowerCase();
		const models = data.models.filter((model) => {
			if (!query) return true;
			return [model.name, model.id, model.canonicalId, model.description]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(query));
		});
		byId("models-body").replaceChildren(
			...models.map((model) => modelRow(model)),
		);
		const empty = byId("models-empty");
		empty.hidden = models.length > 0;
		empty.textContent = labels.noModels;
		const refreshed = data.lastModelFetchAt
			? dateTime.format(new Date(data.lastModelFetchAt))
			: "—";
		byId("models-meta").textContent = `${number.format(models.length)} ${
			labels.models
		} · ${planLabel(data.plan.effective)} · ${formatTemplate(
			labels.lastModelFetch,
			[refreshed],
		)}`;
		byId("refresh-button").disabled = data.refreshing === true;
	}

	function modelRow(model) {
		const row = document.createElement("tr");
		if (model.description) row.title = model.description;

		const nameCell = document.createElement("td");
		const name = element("div", "model-name");
		name.append(element("strong", "", model.name));
		const id = element("span", "model-id", model.id);
		id.title = labels.copyModelId;
		id.addEventListener("click", () =>
			vscode.postMessage({ type: "copyModelId", modelId: model.id }),
		);
		name.append(id);
		const badges = element("div", "badge-row");
		if (model.featured) badges.append(element("span", "badge featured", labels.featured));
		if (model.limitedTime) badges.append(element("span", "badge limited", labels.limitedTime));
		if (model.vision) badges.append(element("span", "badge", labels.vision));
		if (model.reasoningEfforts.length > 0) {
			badges.append(
				element(
					"span",
					"badge",
					`${labels.reasoning}: ${model.reasoningEfforts.join(" / ")}`,
				),
			);
		}
		if (badges.childElementCount > 0) name.append(badges);
		nameCell.append(name);

		const allowanceCell = document.createElement("td");
		allowanceCell.append(
			element(
				"span",
				"allowance",
				model.monthlyUsage === null
					? model.limitedTime
						? labels.limitedTime
						: labels.notIncluded
					: currency.format(model.monthlyUsage),
			),
		);
		if (model.requestsPerFiveHours !== null) {
			allowanceCell.append(
				element(
					"span",
					"secondary-line",
					formatTemplate(labels.requestsFiveHours, [
						number.format(model.requestsPerFiveHours),
					]),
				),
			);
		}

		const inputCell = priceCell(model.price.input);
		const cacheCell = priceCell(model.price.cacheRead);
		const cacheWriteCell = priceCell(model.price.cacheWrite);
		const outputCell = document.createElement("td");
		outputCell.append(
			element("div", "price-block", formatPrice(model.price.output)),
		);
		if (model.price.multiplier > 1) {
			outputCell.append(
				element(
					"span",
					"secondary-line",
					formatTemplate(labels.peakMultiplier, [
						String(model.price.multiplier),
					]),
				),
			);
		}

		const contextCell = document.createElement("td");
		contextCell.append(
			element(
				"div",
				"",
				model.contextLimit === undefined
					? "—"
					: compact.format(model.contextLimit),
			),
		);
		if (model.outputLimit !== undefined) {
			contextCell.append(
				element(
					"span",
					"secondary-line",
					`out ${compact.format(model.outputLimit)}`,
				),
			);
		}

		const rulesCell = document.createElement("td");
		const rules = element("div", "tier-list");
		if (model.timeRules.length === 0 && model.contextTiers.length === 0) {
			rules.append(element("span", "rule-list", labels.noRules));
		} else {
			for (const tier of model.contextTiers) {
				const threshold = compact.format(tier.threshold);
				rules.append(
					element(
						"span",
						"",
						`${formatTemplate(labels.contextTier, [threshold])}: ${formatPrice(
							tier.input,
						)} / ${formatPrice(tier.cacheRead)} / ${formatPrice(
							tier.cacheWrite,
						)} / ${formatPrice(tier.output)}`,
					),
				);
			}
			for (const rule of model.timeRules) {
				const details = [];
				if (rule.days && rule.days.length) {
					details.push(formatTemplate(labels.days, [rule.days.join(", ")]));
				}
				if (rule.dates && (rule.dates.gte || rule.dates.lt)) {
					details.push(
						formatTemplate(labels.dateRange, [
							rule.dates.gte || "…",
							rule.dates.lt || "…",
						]),
					);
				}
				if (rule.periods && rule.periods.length) {
					details.push(
						rule.periods
							.map((period) =>
								formatTemplate(labels.timeRange, [
									period.gte || "…",
									period.lt || "…",
									labels.utc,
								]),
							)
							.join(", "),
					);
				}
				details.push(formatTemplate(labels.peakMultiplier, [String(rule.factor)]));
				rules.append(element("span", "", details.join(" · ")));
			}
		}
		rulesCell.append(rules);

		const availabilityCell = document.createElement("td");
		const availability = element("div", "availability-list");
		availability.append(
			element(
				"span",
				model.training ? "warn" : "yes",
				model.training ? labels.training : labels.noTraining,
			),
		);
		if (model.zdr) availability.append(element("span", "yes", labels.zdr));
		if (model.limitedRegions) {
			availability.append(
				element("span", "warn", labels.limitedRegions),
			);
		}
		if (model.openWeights) availability.append(element("span", "", labels.openWeights));
		availabilityCell.append(availability);

		row.append(
			nameCell,
			allowanceCell,
			inputCell,
			cacheCell,
			cacheWriteCell,
			outputCell,
			contextCell,
			rulesCell,
			availabilityCell,
		);
		return row;
	}

	function priceCell(value) {
		const td = document.createElement("td");
		td.append(element("div", "price-block", formatPrice(value)));
		return td;
	}

	function renderUpdates() {
		const changes = data.changes || [];
		const news = data.news || [];
		byId("changes-count").textContent = number.format(changes.length);
		byId("news-count").textContent = number.format(news.length);
		const changeItems = changes.map(changeItem);
		byId("changes-list").replaceChildren(...changeItems);
		byId("changes-empty").hidden = changeItems.length > 0;
		byId("changes-empty").textContent = labels.noChanges;
		const newsItems = news.map(newsItem);
		byId("news-list").replaceChildren(...newsItems);
		byId("news-empty").hidden = newsItems.length > 0;
		byId("news-empty").textContent = labels.noNews;
	}

	function changeItem(change) {
		const item = element("article", "update-item");
		const heading = element("div", "update-heading");
		heading.append(
			element("strong", "update-title", kindLabel(change.kind)),
			element(
				"span",
				"update-time",
				dateTime.format(new Date(change.detectedAt)),
			),
		);
		item.append(
			heading,
			element("div", "update-meta", `${change.modelName} · ${change.modelId}`),
		);
		const details = element("div", "update-details");
		for (const detail of change.details || []) {
			const line = element("div", "detail-change");
			line.append(
				element("code", "", detail.path),
				element(
					"span",
					"",
					`${labels.oldValue}: ${displayValue(detail.oldValue)} → ${labels.newValue}: ${displayValue(
						detail.newValue,
					)}`,
				),
			);
			details.append(line);
		}
		item.append(details);
		return item;
	}

	function newsItem(news) {
		const item = element("article", "update-item");
		const heading = element("div", "update-heading");
		heading.append(
			element("strong", "update-title", news.title),
			element(
				"span",
				"update-time",
				dateOnly.format(new Date(news.publishedAt)),
			),
		);
		item.append(heading);
		if (news.description) {
			item.append(
				element(
					"p",
					"news-description",
					stripMarkup(news.description).slice(0, 280),
				),
			);
		}
		const link = element("button", "news-link", labels.readOfficial);
		link.type = "button";
		link.addEventListener("click", () =>
			vscode.postMessage({ type: "openExternal", url: news.link }),
		);
		item.append(link);
		return item;
	}

	function setTab(tab) {
		state.tab = tab;
		saveState();
		renderTabs();
	}

	function saveState() {
		vscode.setState(state);
	}

	function kindLabel(kind) {
		const labelsByKind = {
			added: labels.added,
			removed: labels.removed,
			monthly_usage: labels.monthlyUsage,
			pricing: labels.pricing,
			limits: labels.limits,
			availability: labels.availabilityChanged,
			metadata: labels.metadata,
		};
		return labelsByKind[kind] || kind;
	}

	function planLabel(plan) {
		if (plan === "go-plus") return labels.goPlus;
		if (plan === "go-teams") return labels.goTeams;
		return labels.go;
	}

	function formatPrice(value) {
		if (value === null || value === undefined) return "—";
		if (typeof value === "number") return currency.format(value);
		if (typeof value === "object") {
			const entries = Object.entries(value);
			return entries.length
				? entries
						.map(([duration, amount]) =>
							typeof amount === "number"
								? `${duration} ${currency.format(amount)}`
								: `${duration} —`,
						)
						.join(" · ")
				: "—";
		}
		return String(value);
	}

	function displayValue(value) {
		if (value === undefined) return "—";
		if (value === null) return "null";
		if (typeof value === "number") return number.format(value);
		if (typeof value === "string") return value;
		try {
			const text = JSON.stringify(value);
			return text.length > 160 ? `${text.slice(0, 157)}…` : text;
		} catch {
			return String(value);
		}
	}

	function stripMarkup(value) {
		const textarea = document.createElement("textarea");
		textarea.innerHTML = String(value || "");
		return textarea.value.replace(/\s+/g, " ").trim();
	}

	function formatTemplate(template, values) {
		let output = String(template || "");
		values.forEach((value, index) => {
			output = output.split(`{${index}}`).join(value);
		});
		return output;
	}

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}
})();
