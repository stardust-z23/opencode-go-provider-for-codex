(function () {
	"use strict";

	const vscode = acquireVsCodeApi();
	const restored = vscode.getState() || {};
	const columnKeys = new Set([
		"monthly",
		"input",
		"cacheRead",
		"cacheWrite",
		"output",
		"rules",
		"availability",
	]);
	const sortKeys = new Set([
		"name",
		"monthly",
		"input",
		"cacheRead",
		"cacheWrite",
		"output",
	]);
	const state = {
		tab: restored.tab === "updates" ? "updates" : "models",
		search: typeof restored.search === "string" ? restored.search : "",
		hiddenColumns: Array.isArray(restored.hiddenColumns)
			? restored.hiddenColumns.filter((key) => columnKeys.has(key))
			: [],
		sortKey: sortKeys.has(restored.sortKey) ? restored.sortKey : "name",
		sortDirection: restored.sortDirection === "desc" ? "desc" : "asc",
	};
	let data;
	let labels = {};
	let locale = document.documentElement.lang || "en";
	let generatedAt = Date.now();
	const byId = (id) => document.getElementById(id);
	const columnDefinitions = [
		{ key: "model", labelKey: "model", sortKey: "name", required: true },
		{ key: "monthly", labelKey: "monthlyAllowance", sortKey: "monthly" },
		{ key: "input", labelKey: "input", sortKey: "input" },
		{ key: "cacheRead", labelKey: "cacheRead", sortKey: "cacheRead" },
		{ key: "cacheWrite", labelKey: "cacheWrite", sortKey: "cacheWrite" },
		{ key: "output", labelKey: "output", sortKey: "output" },
		{ key: "rules", labelKey: "rules" },
		{ key: "availability", labelKey: "availability" },
	];
	if (
		state.sortKey !== "name" &&
		state.hiddenColumns.includes(state.sortKey)
	) {
		state.sortKey = "name";
		state.sortDirection = "asc";
	}
	const number = new Intl.NumberFormat(locale);
	const priceNumber = new Intl.NumberFormat(locale, {
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
	byId("official-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openOfficialPage" }),
	);
	byId("mobile-official-button").addEventListener("click", () =>
		vscode.postMessage({ type: "action", action: "openOfficialPage" }),
	);
	byId("model-search").addEventListener("input", (event) => {
		state.search = event.target.value;
		saveState();
		renderModels();
	});
	byId("models-tab").addEventListener("click", () => setTab("models"));
	byId("updates-tab").addEventListener("click", () => setTab("updates"));
	byId("columns-button").addEventListener("click", () => {
		setColumnsMenuOpen(byId("columns-menu").hidden);
	});
	document.addEventListener("click", (event) => {
		if (
			!byId("columns-menu").hidden &&
			!event.target.closest(".models-toolbar-actions")
		) {
			setColumnsMenuOpen(false);
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			setColumnsMenuOpen(false);
		}
	});

	vscode.postMessage({ type: "ready" });

	function render() {
		if (!data) return;
		renderLabels();
		renderTabs();
		renderUtilityBand();
		renderColumnsMenu();
		renderMessages();
		renderModels();
		renderUpdates();
	}

	function renderLabels() {
		document.title = labels.title;
		byId("page-title").textContent = labels.title;
		byId("page-subtitle").textContent = labels.subtitle;
		byId("models-tab").textContent = labels.modelsTab;
		byId("updates-tab").textContent = labels.updatesTab;
		byId("official-button").textContent = labels.officialPage;
		byId("mobile-official-button").textContent = labels.officialPage;
		byId("refresh-button").title = labels.refresh;
		byId("refresh-button").setAttribute("aria-label", labels.refresh);
		byId("usage-button").title = labels.openUsage;
		byId("usage-button").setAttribute("aria-label", labels.openUsage);
		byId("usage-button-label").textContent = labels.openUsage;
		byId("model-search").placeholder = labels.search;
		byId("columns-button").textContent = labels.columns;
		byId("columns-button").title = labels.showColumns;
		byId("columns-button").setAttribute("aria-label", labels.showColumns);
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

	function renderUtilityBand() {
		byId("control-band").classList.toggle(
			"has-unread",
			data.unreadCount > 0,
		);
		const unread = byId("unread-label");
		unread.textContent =
			data.unreadCount > 0
				? formatTemplate(labels.unread, [number.format(data.unreadCount)])
				: "";
	}

	function renderColumnsMenu() {
		const menu = byId("columns-menu");
		menu.replaceChildren(
			...columnDefinitions
				.filter((column) => !column.required)
				.map((column) => {
					const label = element("label", "columns-menu-item");
					const checkbox = document.createElement("input");
					checkbox.type = "checkbox";
					checkbox.checked = !state.hiddenColumns.includes(column.key);
					checkbox.addEventListener("change", () => {
						const hidden = new Set(state.hiddenColumns);
						if (checkbox.checked) {
							hidden.delete(column.key);
						} else {
							hidden.add(column.key);
							if (state.sortKey === column.sortKey) {
								state.sortKey = "name";
								state.sortDirection = "asc";
							}
						}
						state.hiddenColumns = [...hidden];
						saveState();
						renderModels();
					});
					label.append(
						checkbox,
						element("span", "", labels[column.labelKey]),
					);
					return label;
				}),
		);
	}

	function setColumnsMenuOpen(open) {
		byId("columns-menu").hidden = !open;
		byId("columns-button").setAttribute("aria-expanded", String(open));
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
		const columns = columnDefinitions.filter(
			(column) => !state.hiddenColumns.includes(column.key),
		);
		byId("models-head").replaceChildren(
			...columns.map((column) => {
				const th = document.createElement("th");
				th.className = `col-${column.key}`;
				if (!column.sortKey) {
					th.textContent = labels[column.labelKey];
					return th;
				}
				const active = state.sortKey === column.sortKey;
				th.setAttribute(
					"aria-sort",
					active
						? state.sortDirection === "asc"
							? "ascending"
							: "descending"
						: "none",
				);
				const button = element(
					"button",
					"sort-button",
					labels[column.labelKey],
				);
				button.type = "button";
				const indicator = element(
					"span",
					"sort-indicator",
					active
						? state.sortDirection === "asc"
							? "▲"
							: "▼"
						: "↕",
				);
				indicator.setAttribute("aria-hidden", "true");
				button.append(indicator);
				button.title = active
					? state.sortDirection === "asc"
						? labels.sortDescending
						: labels.sortAscending
					: labels.sortAscending;
				button.addEventListener("click", () =>
					setSort(column.sortKey),
				);
				th.append(button);
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
		models.sort(compareModels);
		byId("models-body").replaceChildren(
			...models.map((model) => modelRow(model, columns)),
		);
		const table = byId("models-body").closest("table");
		table.style.minWidth = `${Math.max(
			620,
			220 + (columns.length - 1) * 105,
		)}px`;
		const empty = byId("models-empty");
		empty.hidden = models.length > 0;
		empty.textContent = labels.noModels;
		const refreshed = data.lastModelFetchAt
			? dateTime.format(new Date(data.lastModelFetchAt))
			: "—";
		byId("models-meta").textContent =
			`${number.format(models.length)} ${labels.models} · ` +
			`${labels.priceUnit} · ` +
			formatTemplate(labels.lastModelFetch, [refreshed]);
		byId("refresh-button").disabled = data.refreshing === true;
	}

	function setSort(key) {
		if (state.sortKey === key) {
			state.sortDirection =
				state.sortDirection === "asc" ? "desc" : "asc";
		} else {
			state.sortKey = key;
			state.sortDirection = "asc";
		}
		saveState();
		renderModels();
	}

	function compareModels(left, right) {
		if (state.sortKey === "name") {
			const result = left.name.localeCompare(right.name, locale, {
				numeric: true,
			});
			return state.sortDirection === "asc" ? result : -result;
		}
		const leftValue = sortValue(left, state.sortKey);
		const rightValue = sortValue(right, state.sortKey);
		if (leftValue === null && rightValue === null) {
			return left.name.localeCompare(right.name, locale, {
				numeric: true,
			});
		}
		if (leftValue === null) return 1;
		if (rightValue === null) return -1;
		const result = leftValue - rightValue;
		return state.sortDirection === "asc" ? result : -result;
	}

	function sortValue(model, key) {
		if (key === "monthly") {
			const value = model.monthlyUsage.go;
			return typeof value === "number" ? value : null;
		}
		if (key === "input") return numericPrice(model.price.input);
		if (key === "cacheRead") return numericPrice(model.price.cacheRead);
		if (key === "cacheWrite") return numericPrice(model.price.cacheWrite);
		if (key === "output") return numericPrice(model.price.output);
		return null;
	}

	function numericPrice(value) {
		if (typeof value === "number") return value;
		if (value && typeof value === "object") {
			const numbers = Object.values(value).filter(
				(amount) => typeof amount === "number",
			);
			return numbers.length > 0 ? Math.min(...numbers) : null;
		}
		return null;
	}

	function modelRow(model, columns) {
		const row = document.createElement("tr");
		if (model.description) row.title = model.description;

		const nameCell = document.createElement("td");
		nameCell.className = "col-model";
		const name = element("div", "model-name");
		name.append(element("strong", "", model.name));
		const id = element("span", "model-id", model.id);
		id.title = labels.copyModelId;
		id.addEventListener("click", () =>
			vscode.postMessage({ type: "copyModelId", modelId: model.id }),
		);
		name.append(id);
		const facts = element("div", "model-facts");
		if (model.contextLimit !== undefined) {
			facts.append(
				element(
					"span",
					"",
					formatTemplate(labels.contextLength, [
						compact.format(model.contextLimit),
					]),
				),
			);
		}
		if (model.outputLimit !== undefined) {
			facts.append(
				element(
					"span",
					"",
					formatTemplate(labels.outputLimit, [
						compact.format(model.outputLimit),
					]),
				),
			);
		}
		if (facts.childElementCount > 0) name.append(facts);
		const badges = element("div", "badge-row");
		if (model.featured) badges.append(element("span", "badge featured", labels.featured));
		if (model.limitedTime) badges.append(element("span", "badge limited", labels.limitedTime));
		if (model.deprecated) badges.append(element("span", "badge limited", labels.deprecated));
		if (model.vision) badges.append(element("span", "badge vision", labels.vision));
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
		allowanceCell.className = "col-monthly";
		const planRows = [
			["go", labels.go],
			["go-plus", labels.goPlus],
			["go-teams", labels.goTeams],
		];
		const hasPlanQuota = planRows.some(
			([plan]) => model.monthlyUsage[plan] !== null,
		);
		if (!hasPlanQuota && model.limitedTime) {
			allowanceCell.append(
				element("span", "allowance", labels.limitedTime),
			);
		} else {
			const planLimits = element("div", "plan-limits");
			for (const [plan, label] of planRows) {
				const line = element(
					"div",
					`plan-limit plan-${plan}`,
				);
				line.append(
					element("span", "plan-name", label),
					element(
						"strong",
						"plan-value",
						model.monthlyUsage[plan] === null
							? labels.notIncluded
							: formatPrice(model.monthlyUsage[plan]),
					),
				);
				const requests = model.requestsPerFiveHours[plan];
				if (requests !== null) {
					line.append(
						element(
							"span",
							"plan-requests",
							formatTemplate(labels.requestsFiveHours, [
								number.format(requests),
							]),
						),
					);
				}
				planLimits.append(line);
			}
			allowanceCell.append(planLimits);
		}

		const inputCell = priceCell(model.price.input, "input");
		const cacheCell = priceCell(model.price.cacheRead, "cacheRead");
		const cacheWriteCell = priceCell(
			model.price.cacheWrite,
			"cacheWrite",
		);
		const outputCell = document.createElement("td");
		outputCell.className = "col-output";
		outputCell.append(
			element("div", "price-block", formatPrice(model.price.output)),
		);
		const peak = model.price.multiplier > 1;
		const priceMode = peak
			? "peak"
			: model.timeRules.length > 0
				? "off-peak"
				: "standard";
		const priceModeLabel = peak
			? labels.currentPeakPrice
			: priceMode === "off-peak"
				? labels.currentOffPeakPrice
				: labels.currentStandardPrice;
		const priceModeBadge = element(
			"span",
			`price-mode-badge ${priceMode}`,
			priceModeLabel,
		);
		if (peak) {
			priceModeBadge.title = formatTemplate(labels.peakPriceTooltip, [
				String(model.price.multiplier),
			]);
		}
		outputCell.append(priceModeBadge);

		const rulesCell = document.createElement("td");
		rulesCell.className = "col-rules";
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
		availabilityCell.className = "col-availability";
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

		const cells = {
			model: nameCell,
			monthly: allowanceCell,
			input: inputCell,
			cacheRead: cacheCell,
			cacheWrite: cacheWriteCell,
			output: outputCell,
			rules: rulesCell,
			availability: availabilityCell,
		};
		row.append(...columns.map((column) => cells[column.key]));
		return row;
	}

	function priceCell(value, key) {
		const td = document.createElement("td");
		td.className = `col-${key}`;
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

	function formatPrice(value) {
		if (value === null || value === undefined) return "—";
		if (typeof value === "number") return `$${priceNumber.format(value)}`;
		if (typeof value === "object") {
			const entries = Object.entries(value);
			return entries.length
				? entries
						.map(([duration, amount]) =>
							typeof amount === "number"
								? `${duration} $${priceNumber.format(amount)}`
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
