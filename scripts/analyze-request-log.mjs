import fs from "node:fs";

const file = process.argv[2];
if (!file) {
	throw new Error("Usage: node analyze-request-log.mjs <request-log.csv>");
}

function parseCsv(text) {
	const records = [];
	let record = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (char === '"' && text[index + 1] === '"') {
				field += '"';
				index++;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"') {
			quoted = true;
		} else if (char === ",") {
			record.push(field);
			field = "";
		} else if (char === "\n") {
			record.push(field.replace(/\r$/, ""));
			records.push(record);
			record = [];
			field = "";
		} else {
			field += char;
		}
	}
	if (field || record.length) {
		record.push(field.replace(/\r$/, ""));
		records.push(record);
	}
	const headers = records.shift();
	return records
		.filter((values) => values.length > 1)
		.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function percentile(values, ratio) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function summarize(rows) {
	const input = rows.map((row) => number(row.inputTokens));
	const cache = rows.map((row) => number(row.cacheReadTokens));
	const body = rows.map((row) => {
		try {
			return number(JSON.parse(row.requestHeaders || "{}")["content-length"]);
		} catch {
			return 0;
		}
	});
	return {
		count: rows.length,
		first: rows.at(-1)?.startedAt,
		last: rows[0]?.startedAt,
		input: {
			min: Math.min(...input),
			median: percentile(input, 0.5),
			p90: percentile(input, 0.9),
			max: Math.max(...input),
		},
		cacheRead: {
			median: percentile(cache, 0.5),
			p90: percentile(cache, 0.9),
			max: Math.max(...cache),
		},
		bodyBytes: {
			median: percentile(body, 0.5),
			max: Math.max(...body),
		},
	};
}

function effectiveInput(row) {
	return number(row.inputTokens) + number(row.cacheReadTokens);
}

function formatTime(timestamp) {
	return new Date(number(timestamp)).toISOString();
}

function parseHeaders(row) {
	try {
		return JSON.parse(row.requestHeaders || "{}");
	} catch {
		return {};
	}
}

function bodyLength(row) {
	return number(parseHeaders(row)["content-length"]);
}

function millisecondsBetween(earlier, later) {
	return number(later) - number(earlier);
}

const rows = parseCsv(fs.readFileSync(file, "utf8"));
const groups = Map.groupBy(rows, (row) => `${row.userAgent}|${row.protocol}|${row.model}`);

console.log(`rows=${rows.length}`);
for (const [key, groupRows] of groups) {
	console.log(key);
	console.log(JSON.stringify(summarize(groupRows), null, 2));
}

for (const [session, sessionRows] of Map.groupBy(rows, (row) => row.sessionID || "(empty)")) {
	const comparable = [...sessionRows]
		.filter((row) => row.protocol === "anthropic-messages" && row.model === "deepseek-v4.1-flash")
		.sort((a, b) => number(a.startedAt) - number(b.startedAt));
	const before = comparable.filter((row) => row.userAgent.includes("/0.1.21"));
	const after = comparable.filter((row) => row.userAgent.includes("/0.1.19-ab"));
	if (before.length === 0 && after.length === 0) {
		continue;
	}
	const summarizeEffective = (groupRows) => {
		const values = groupRows.map(effectiveInput);
		return {
			count: groupRows.length,
			effectiveInputMedian: percentile(values, 0.5),
			uncachedInputMedian: percentile(
				groupRows.map((row) => number(row.inputTokens)),
				0.5,
			),
			cacheReadMedian: percentile(
				groupRows.map((row) => number(row.cacheReadTokens)),
				0.5,
			),
			bodyBytesMedian: percentile(
				groupRows.map((row) => bodyLength(row)),
				0.5,
			),
			outputMedian: percentile(
				groupRows.map((row) => number(row.outputTokens)),
				0.5,
			),
			requestGapMedianMs: (() => {
				const gaps = [];
				for (let index = 1; index < groupRows.length; index++) {
					gaps.push(number(groupRows[index].startedAt) - number(groupRows[index - 1].startedAt));
				}
				return percentile(gaps, 0.5);
			})(),
		};
	};
	console.log(`session=${session} count=${comparable.length} first=${formatTime(comparable[0]?.startedAt)} last=${formatTime(comparable.at(-1)?.startedAt)}`);
	console.log(`before=${JSON.stringify(summarizeEffective(before))}`);
	console.log(`after=${JSON.stringify(summarizeEffective(after))}`);
}

for (const [session, sessionRows] of Map.groupBy(rows, (row) => row.sessionID || "(empty)")) {
	const comparable = sessionRows.filter(
		(row) => row.protocol === "anthropic-messages" && row.model === "deepseek-v4.1-flash",
	);
	const groupsForSession = Map.groupBy(comparable, (row) =>
		row.userAgent.includes("/0.1.21") ? "0.1.21" : row.userAgent.includes("/0.1.19-ab") ? "0.1.19-ab" : "other",
	);
	const result = {};
	for (const [version, versionRows] of groupsForSession) {
		const cost = versionRows.map((row) => number(row.cost));
		result[version] = {
			count: versionRows.length,
			averageCost: cost.reduce((sum, value) => sum + value, 0) / Math.max(1, cost.length),
			totalCost: cost.reduce((sum, value) => sum + value, 0),
			totalOutputTokens: versionRows.reduce((sum, row) => sum + number(row.outputTokens), 0),
		};
	}
	if (Object.keys(result).length > 0) {
		console.log(`cost session=${session} ${JSON.stringify(result)}`);
	}
	for (const row of [...comparable].sort((a, b) => number(a.startedAt) - number(b.startedAt))) {
		console.log(
			`sample session=${session} time=${formatTime(row.startedAt)} version=${row.userAgent} input=${row.inputTokens} cache=${row.cacheReadTokens} body=${bodyLength(row)} output=${row.outputTokens} reasoning=${row.reasoningTokens} cost=${row.cost}`,
		);
	}
}

for (const row of rows) {
	const input = number(row.inputTokens);
	const cacheRead = number(row.cacheReadTokens);
	const bodyBytes = (() => {
		try {
			return number(JSON.parse(row.requestHeaders || "{}")["content-length"]);
		} catch {
			return 0;
		}
	})();
	if (input >= 250000 || cacheRead >= 550000 || bodyBytes >= 6000000) {
		console.log(
			[
				`time=${formatTime(row.startedAt)}`,
				`session=${row.sessionID}`,
				`version=${row.userAgent}`,
				`protocol=${row.protocol}`,
				`input=${input}`,
				`output=${row.outputTokens}`,
				`reasoning=${row.reasoningTokens}`,
				`cacheRead=${cacheRead}`,
				`bodyBytes=${bodyBytes}`,
				`finish=${row.finish}`,
			].join(" "),
		);
	}
}

for (const [session, sessionRows] of Map.groupBy(rows, (row) => row.sessionID || "(empty)")) {
	const ordered = [...sessionRows].sort((a, b) => number(a.startedAt) - number(b.startedAt));
	const observed = [];
	for (let index = 1; index < ordered.length; index++) {
		const previous = ordered[index - 1];
		const current = ordered[index];
		const gapMs = millisecondsBetween(previous.startedAt, current.startedAt);
		const inputDelta = number(current.inputTokens) - number(previous.inputTokens);
		const bodyDelta = bodyLength(current) - bodyLength(previous);
		if (gapMs <= 0 || gapMs > 60_000) {
			continue;
		}
		if (inputDelta >= 10_000 || bodyDelta >= 100_000) {
			observed.push({
				at: formatTime(current.startedAt),
				protocol: current.protocol,
				version: current.userAgent,
				gapMs,
				inputDelta,
				bodyDelta,
				fromInput: number(previous.inputTokens),
				toInput: number(current.inputTokens),
				fromBody: bodyLength(previous),
				toBody: bodyLength(current),
			});
		}
	}
	if (observed.length > 0) {
		console.log(`large-step session=${session} count=${observed.length}`);
		for (const item of observed.slice(-20)) {
			console.log(JSON.stringify(item));
		}
	}
}
