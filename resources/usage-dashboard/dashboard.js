(function () {
	"use strict";

	const vscode = acquireVsCodeApi();
	const restored = vscode.getState() || {};
	const state = {
		range:
			restored.range === "4h" ||
			restored.range === "today" ||
			restored.range === "yesterday" ||
			restored.range === "7d"
				? restored.range
				: "1h",
		model: typeof restored.model === "string" ? restored.model : "",
		status:
			restored.status === "success" || restored.status === "error"
				? restored.status
				: "all",
		metric: restored.metric === "hitRate" ? restored.metric : "tokens",
		page:
			typeof restored.page === "number" &&
			Number.isInteger(restored.page) &&
			restored.page >= 1
				? restored.page
				: 1,
	};
	let snapshot;
	let quota;
	let labels = {};
	let locale = document.documentElement.lang || "en";
	let generatedAt = Date.now();

	const byId = (id) => document.getElementById(id);
	const refreshButton = byId("refresh-button");
	const modelCenterButton = byId("model-center-button");
	const menuButton = byId("menu-button");
	const previousPageButtons = [...document.querySelectorAll("[data-page-prev]")];
	const nextPageButtons = [...document.querySelectorAll("[data-page-next]")];
	const pageLabels = [...document.querySelectorAll("[data-page-label]")];
	const actionMenu = byId("action-menu");
	const numberCompact = new Intl.NumberFormat(locale, {
		notation: "compact",
		maximumFractionDigits: 1,
	});
	const numberExact = new Intl.NumberFormat(locale);
	const percentFormat = new Intl.NumberFormat(locale, {
		style: "percent",
		maximumFractionDigits: 1,
	});
	const timeFormat = new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const shortDateFormat = new Intl.DateTimeFormat(locale, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});

	window.addEventListener("message", (event) => {
		const message = event.data;
		if (!message || message.type !== "snapshot") {
			return;
		}
		snapshot = message.data;
		quota = message.quota;
		labels = message.labels || {};
		locale = message.locale || locale;
		generatedAt = message.generatedAt || Date.now();
		if (message.filters) {
			if (message.filters.range) state.range = message.filters.range;
			if (message.filters.model) state.model = message.filters.model;
			if (message.filters.status) state.status = message.filters.status;
			if (message.filters.page) state.page = message.filters.page;
		}
		render();
	});

	refreshButton.addEventListener("click", () => {
		refreshButton.classList.remove("refreshing");
		void refreshButton.offsetWidth;
		refreshButton.classList.add("refreshing");
		setTimeout(() => refreshButton.classList.remove("refreshing"), 750);
		vscode.postMessage({ type: "action", action: "refreshAll" });
	});
	modelCenterButton.addEventListener("click", () => {
		vscode.postMessage({ type: "action", action: "openModelCenter" });
	});
	menuButton.addEventListener("click", () => {
		setMenuOpen(actionMenu.hidden);
	});
	for (const button of previousPageButtons) {
		button.addEventListener("click", () => changePage(-1));
	}
	for (const button of nextPageButtons) {
		button.addEventListener("click", () => changePage(1));
	}
	actionMenu.addEventListener("click", (event) => {
		const button = event.target.closest("button[data-action]");
		if (!button) return;
		setMenuOpen(false);
		vscode.postMessage({ type: "action", action: button.dataset.action });
	});
	document.addEventListener("click", (event) => {
		if (!actionMenu.hidden && !event.target.closest(".page-header")) {
			setMenuOpen(false);
		}
	});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			setMenuOpen(false);
		}
	});

	vscode.postMessage({
		type: "ready",
		range: state.range,
		model: state.model,
		status: state.status,
		page: state.page,
	});

	function render() {
		if (!snapshot || !quota) return;
		renderLabels();
		renderQuota();
		renderFilters();
		renderSummary();
		renderTrend();
		renderCacheAlert();
		renderTable();
		byId("page-meta").textContent = formatTemplate(labels.updated, [
			timeFormat.format(new Date(generatedAt)),
		]);
	}

	function renderLabels() {
		byId("page-title").textContent = labels.title;
		byId("quota-title").textContent = labels.quotaSection;
		byId("requests-title").textContent = labels.requestsSection;
		byId("trend-title").textContent = labels.usageTrend;
		byId("recent-title").textContent = labels.recentRequests;
		byId("model-label").textContent = labels.model;
		byId("status-label").textContent = labels.status;
		menuButton.title = labels.moreActions;
		menuButton.setAttribute("aria-label", labels.moreActions);
		refreshButton.title = labels.refreshNow;
		refreshButton.setAttribute("aria-label", labels.refreshNow);
		modelCenterButton.textContent = labels.modelCenter;
		const actionLabels = {
			refreshQuota: labels.refreshQuota,
			setApiKey: labels.setApiKey,
			getApiKey: labels.getApiKey,
			syncModels: labels.syncModels,
			removeCatalog: labels.removeCatalog,
			openConfig: labels.openConfig,
			openSettings: labels.openSettings,
			reloadWindow: labels.reloadWindow,
		};
		for (const button of actionMenu.querySelectorAll("button[data-action]")) {
			button.textContent = actionLabels[button.dataset.action] || "";
		}
	}

	function renderQuota() {
		const stateLabels = {
			loading: labels.loading,
			setup: labels.setup,
			active: labels.active,
			auth: labels.auth,
			error: labels.errorState,
		};
		const stateLabel = byId("quota-state");
		stateLabel.textContent = stateLabels[quota.state] || quota.state;
		stateLabel.className = `state-label ${quota.state}`;
		const rows = byId("quota-rows");
		rows.replaceChildren(
			...quota.windows.map((window) => {
				const row = element("div", "quota-row");
				const label = element("span", "quota-label", window.label);
				const track = element("div", "quota-track");
				const fill = element("div", "quota-fill");
				fill.style.width = `${Math.max(0, Math.min(100, window.percent))}%`;
				if (window.percent >= quota.errorThreshold) fill.classList.add("error");
				else if (window.percent >= quota.warningThreshold) fill.classList.add("warning");
				track.append(fill);
				const value = element("div", "quota-value");
				value.append(element("strong", "", window.percentText));
				if (window.resetText) {
					value.append(
						element(
							"span",
							"quota-reset",
							formatTemplate(labels.resetIn, [window.resetText]),
						),
					);
				}
				row.append(label, track, value);
				return row;
			}),
		);

		const meta = byId("quota-meta");
		meta.replaceChildren();
		if (quota.fetchedAt) {
			meta.append(
				element(
					"span",
					"",
					formatTemplate(labels.updated, [timeFormat.format(new Date(quota.fetchedAt))]),
				),
			);
		}
		meta.append(
			element(
				"span",
				"",
				formatTemplate(labels.autoRefresh, [String(quota.autoRefreshMinutes)]),
			),
		);
		if (quota.useBalance) {
			meta.append(element("span", "", labels.balanceFallback));
		}
		const error = byId("quota-error");
		error.hidden = !quota.errorDetail;
		error.textContent = quota.errorDetail || "";
	}

	function renderFilters() {
		const rangeControl = byId("range-control");
		rangeControl.replaceChildren(
			...[
				["1h", labels.last1h],
				["4h", labels.last4h],
				["today", labels.today],
				["yesterday", labels.yesterday],
				["7d", labels.last7d],
			].map(([value, label]) => {
				const button = element("button", "", label);
				button.type = "button";
				button.dataset.range = value;
				button.setAttribute("aria-pressed", String(state.range === value));
				button.addEventListener("click", () => updateRange(value));
				return button;
			}),
		);

		const models = snapshot.models.slice();
		let modelWasReset = false;
		if (state.model && !models.includes(state.model)) {
			state.model = "";
			modelWasReset = true;
		}
		const modelSelect = byId("model-filter");
		modelSelect.replaceChildren(option("", labels.allModels));
		for (const model of models) {
			modelSelect.append(option(model, model));
		}
		modelSelect.value = state.model;
		modelSelect.onchange = () => {
			state.model = modelSelect.value;
			state.page = 1;
			saveState();
			requestFilters();
		};

		const statusSelect = byId("status-filter");
		statusSelect.replaceChildren(
			option("all", labels.allStatuses),
			option("success", labels.success),
			option("error", labels.error),
		);
		statusSelect.value = state.status;
		statusSelect.onchange = () => {
			state.status = statusSelect.value;
			state.page = 1;
			saveState();
			requestFilters();
		};
		if (modelWasReset) {
			state.page = 1;
			saveState();
			requestFilters();
		}

		const trendControl = byId("trend-control");
		trendControl.replaceChildren(
			...[
				["tokens", labels.tokens],
				["hitRate", labels.cacheHitRate],
			].map(([value, label]) => {
				const button = element("button", "", label);
				button.type = "button";
				button.dataset.metric = value;
				button.setAttribute("aria-pressed", String(state.metric === value));
				button.addEventListener("click", () => {
					state.metric = value;
					saveState();
					renderTrend();
					renderFilters();
				});
				return button;
			}),
		);
	}

	function renderSummary() {
		const summary = snapshot.summary;
		const metrics = [
			[labels.totalRequests, numberExact.format(summary.totalRequests)],
			[labels.realTotalTokens, compact(summary.realTotalTokens)],
			[
				labels.cacheHitRate,
				summary.cacheHitRate === null ? dash() : percentFormat.format(summary.cacheHitRate),
			],
			[labels.successRate, percentFormat.format(summary.successRate)],
		];
		byId("summary-metrics").replaceChildren(
			...metrics.map(([label, value]) => {
				const cell = element("div", "metric");
				cell.append(
					element("span", "metric-label", label),
					element("strong", "metric-value", value),
				);
				cell.lastElementChild.title = value;
				return cell;
			}),
		);
		const submetrics = [
			[labels.freshInput, compact(summary.freshInputTokens), exact(summary.freshInputTokens)],
			[labels.cacheRead, compact(summary.cacheReadTokens), exact(summary.cacheReadTokens)],
			[labels.cacheWrite, compact(summary.cacheWriteTokens), exact(summary.cacheWriteTokens)],
			[labels.output, compact(summary.outputTokens), exact(summary.outputTokens)],
			[labels.reasoning, compact(summary.reasoningTokens), exact(summary.reasoningTokens)],
			[
				labels.averageDuration,
				formatDuration(summary.averageDurationMs),
				`${numberExact.format(summary.averageDurationMs)} ms`,
			],
		];
		byId("token-metrics").replaceChildren(
			...submetrics.map(([label, value, title]) => {
				const cell = element("div", "submetric");
				const valueNode = element("span", "submetric-value", value);
				valueNode.title = title;
				cell.append(element("span", "submetric-label", label), valueNode);
				return cell;
			}),
		);
	}

	function renderTrend() {
		if (!snapshot) return;
		const svg = byId("trend-chart");
		svg.replaceChildren();
		const width = 760;
		const height = 180;
		const left = 48;
		const right = 16;
		const top = 12;
		const bottom = 28;
		const points = snapshot.trend || [];
		const values = points.map((point) => trendValue(point));
		const max = Math.max(1, ...values.filter((value) => value !== null));
		const showEmpty =
			values.every((value) => value === null || value === 0) ||
			(state.metric === "hitRate" && snapshot.summary.totalRequests === 0);
		for (let index = 0; index <= 3; index++) {
			const y = top + ((height - top - bottom) * index) / 3;
			svg.append(
				svgElement("line", {
					x1: String(left),
					x2: String(width - right),
					y1: String(y),
					y2: String(y),
					class: "chart-grid",
				}),
			);
			const label = svgElement("text", {
				x: String(left - 7),
				y: String(y + 3),
				"text-anchor": "end",
				class: "chart-label",
			});
			const axisValue =
				state.metric === "hitRate"
					? `${Math.round((max * (3 - index)) / 3)}%`
					: compact((max * (3 - index)) / 3);
			label.textContent = axisValue;
			svg.append(label);
		}
		if (showEmpty) {
			const text = svgElement("text", {
				x: String(width / 2),
				y: String(height / 2),
				"text-anchor": "middle",
				class: "chart-empty",
			});
			text.textContent = labels.emptyRequests;
			svg.append(text);
			return;
		}
		const usableWidth = width - left - right;
		const usableHeight = height - top - bottom;
		const coordinates = [];
		values.forEach((value, index) => {
			if (value === null) return;
			const x =
				points.length <= 1
					? left + usableWidth / 2
					: left + (index / (points.length - 1)) * usableWidth;
			const y = top + usableHeight - (value / max) * usableHeight;
			coordinates.push({ x, y, point: points[index], value });
		});
		if (coordinates.length > 1) {
			const polyline = svgElement("polyline", {
				points: coordinates.map((point) => `${point.x},${point.y}`).join(" "),
				class: "chart-line",
			});
			svg.append(polyline);
		}
		for (const point of coordinates) {
			const circle = svgElement("circle", {
				cx: String(point.x),
				cy: String(point.y),
				r: "3",
				class: "chart-point",
			});
			const title = svgElement("title", {});
			title.textContent = `${formatTableTime(point.point.start)} · ${formatTrendValue(
				point.point,
			)}`;
			circle.append(title);
			svg.append(circle);
		}
		const first = svgElement("text", {
			x: String(left),
			y: String(height - 8),
			class: "chart-label",
		});
		first.textContent = points.length ? formatTableTime(points[0].start) : "";
		svg.append(first);
		const last = svgElement("text", {
			x: String(width - right),
			y: String(height - 8),
			"text-anchor": "end",
			class: "chart-label",
		});
		last.textContent = points.length
			? formatTableTime(points[points.length - 1].start)
			: "";
		svg.append(last);
	}

	function renderCacheAlert() {
		const alert = byId("cache-alert");
		const visible = snapshot.summary.cacheDropCount > 0;
		alert.hidden = !visible;
		if (!visible) return;
		byId("cache-alert-title").textContent = labels.cacheDropTitle;
		byId("cache-alert-detail").textContent = formatTemplate(labels.cacheDropSummary, [
			String(snapshot.summary.cacheDropCount),
			compact(snapshot.summary.cacheDropTokens),
		]);
	}

	function renderTable() {
		const headers = [
			labels.time,
			labels.model,
			labels.freshInput,
			labels.cacheRead,
			labels.cacheWrite,
			labels.output,
			labels.reasoning,
			labels.cacheHitRate,
			labels.duration,
			labels.status,
		];
		byId("table-head").replaceChildren(
			...headers.map((label) => {
				const th = document.createElement("th");
				th.textContent = label;
				return th;
			}),
		);
		const rows = snapshot.records || [];
		const body = byId("table-body");
		body.replaceChildren(
			...rows.map((record) => {
				const row = document.createElement("tr");
				if (record.errorMessage) {
					row.title = record.errorMessage;
				}
				row.append(
					cell(formatTableTime(record.startedAt)),
					cell(record.model, "model-cell"),
					cell(exact(record.freshInputTokens)),
					cacheReadCell(record),
					cell(exact(record.cacheWriteTokens)),
					cell(exact(record.outputTokens)),
					cell(exact(record.reasoningTokens)),
					cell(
						record.cacheHitRate === null
							? dash()
							: percentFormat.format(record.cacheHitRate),
					),
					cell(formatDuration(record.durationMs)),
					statusCell(record),
				);
				return row;
			}),
		);
		const empty = byId("empty-state");
		empty.hidden = rows.length > 0;
		empty.textContent = labels.emptyRequests;
		const total = snapshot.totalMatched;
		const offset = snapshot.offset;
		const pageSize = snapshot.recordLimit;
		const currentPage = Math.floor(offset / pageSize) + 1;
		const totalPages = Math.max(1, Math.ceil(total / pageSize));
		if (state.page !== currentPage) {
			state.page = currentPage;
			saveState();
		}
		byId("table-meta").textContent =
			total > 0
				? formatTemplate(labels.showingRange, [
						String(offset + 1),
						String(offset + rows.length),
						String(total),
					])
				: "";
		const pageLabel = formatTemplate(labels.pageOf, [
			String(currentPage),
			String(totalPages),
		]);
		for (const label of pageLabels) {
			label.textContent = pageLabel;
		}
		for (const button of previousPageButtons) {
			button.disabled = currentPage <= 1;
			button.title = labels.previousPage;
			button.setAttribute("aria-label", labels.previousPage);
		}
		for (const button of nextPageButtons) {
			button.disabled = currentPage >= totalPages;
			button.title = labels.nextPage;
			button.setAttribute("aria-label", labels.nextPage);
		}
	}

	function cacheReadCell(record) {
		const td = cell(exact(record.cacheReadTokens));
		if (record.cacheDropTokens > 0) {
			td.classList.add("cache-drop");
			td.textContent = `${exact(record.cacheReadTokens)} !`;
			td.title = `${labels.cacheDropTitle}: -${exact(record.cacheDropTokens)}`;
		}
		return td;
	}

	function statusCell(record) {
		const td = document.createElement("td");
		const pill = element(
			"span",
			`status-pill ${record.success ? "success" : "error"}`,
			record.success ? labels.success : labels.error,
		);
		pill.title = record.success ? `HTTP ${record.statusCode}` : record.errorMessage || `HTTP ${record.statusCode}`;
		td.append(pill);
		return td;
	}

	function updateRange(range) {
		state.range = range;
		state.page = 1;
		saveState();
		requestFilters();
	}

	function requestFilters() {
		vscode.postMessage({
			type: "setFilters",
			range: state.range,
			model: state.model,
			status: state.status,
			page: state.page,
		});
	}

	function changePage(delta) {
		const next = Math.max(1, state.page + delta);
		if (next === state.page) return;
		state.page = next;
		saveState();
		requestFilters();
	}

	function saveState() {
		vscode.setState(state);
	}

	function setMenuOpen(open) {
		actionMenu.hidden = !open;
		menuButton.setAttribute("aria-expanded", String(open));
	}

	function trendValue(point) {
		if (state.metric === "hitRate") {
			return point.cacheHitRate === null ? null : point.cacheHitRate * 100;
		}
		return point.tokens;
	}

	function formatTrendValue(point) {
		if (state.metric === "hitRate") {
			return point.cacheHitRate === null ? dash() : percentFormat.format(point.cacheHitRate);
		}
		return exact(point.tokens);
	}

	function formatTableTime(value) {
		const date = new Date(value);
		const now = new Date();
		return date.toDateString() === now.toDateString()
			? timeFormat.format(date)
			: shortDateFormat.format(date);
	}

	function formatDuration(value) {
		const duration = Math.max(0, Number(value) || 0);
		if (duration < 1000) return `${Math.round(duration)} ms`;
		return `${(duration / 1000).toFixed(duration < 10_000 ? 1 : 0)} s`;
	}

	function compact(value) {
		return numberCompact.format(Math.max(0, Number(value) || 0));
	}

	function exact(value) {
		return numberExact.format(Math.max(0, Number(value) || 0));
	}

	function dash() {
		return "\u2014";
	}

	function formatTemplate(template, values) {
		let output = String(template || "");
		values.forEach((value, index) => {
			output = output.split(`{${index}}`).join(value);
		});
		return output;
	}

	function option(value, label) {
		const node = document.createElement("option");
		node.value = value;
		node.textContent = label;
		return node;
	}

	function cell(value, className) {
		const td = document.createElement("td");
		td.textContent = value;
		if (className) td.className = className;
		return td;
	}

	function element(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function svgElement(tag, attributes) {
		const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
		for (const [name, value] of Object.entries(attributes)) {
			node.setAttribute(name, value);
		}
		return node;
	}
})();
