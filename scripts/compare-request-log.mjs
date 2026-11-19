import fs from "node:fs";
import path from "node:path";

const requestLog = process.argv[2];
const usageDir = process.argv[3];
if (!requestLog || !usageDir) {
	throw new Error(
		"Usage: node compare-request-log.mjs <request-log.csv> <usage-jsonl-dir> [YYYY-MM-DD]",
	);
}
const requestedDay =
	process.argv[4] ??
	`${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(
		new Date().getDate(),
	).padStart(2, "0")}`;

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
		.map((values) =>
			Object.fromEntries(
				headers.map((header, index) => [header, values[index] ?? ""]),
			),
		);
}

function number(value) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function localDayKey(timestamp) {
	const date = new Date(timestamp);
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function sum(rows, key) {
	return rows.reduce((total, row) => total + number(row[key]), 0);
}

function compactTotals(rows, source) {
	if (source === "opencode") {
		return {
			requests: rows.length,
			freshInput: sum(rows, "inputTokens"),
			cacheRead: sum(rows, "cacheReadTokens"),
			cacheWrite: sum(rows, "cacheWriteTokens"),
			output: sum(rows, "outputTokens"),
			reasoning: sum(rows, "reasoningTokens"),
			total:
				sum(rows, "inputTokens") +
				sum(rows, "cacheReadTokens") +
				sum(rows, "cacheWriteTokens") +
				sum(rows, "outputTokens"),
		};
	}
	return {
		requests: rows.length,
		freshInput: sum(rows, "freshInputTokens"),
		cacheRead: sum(rows, "cacheReadTokens"),
		cacheWrite: sum(rows, "cacheWriteTokens"),
		output: sum(rows, "outputTokens"),
		reasoning: sum(rows, "reasoningTokens"),
		total: sum(rows, "realTotalTokens"),
	};
}

const opencodeRows = parseCsv(fs.readFileSync(requestLog, "utf8"))
	.filter(
		(row) =>
			localDayKey(number(row.startedAt)) === requestedDay &&
			row.userAgent.includes("opencode-go-provider-for-codex"),
	)
	.sort((left, right) => number(left.startedAt) - number(right.startedAt));
const localRows = fs
	.readdirSync(usageDir)
	.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
	.flatMap((name) =>
		fs
			.readFileSync(path.join(usageDir, name), "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
	)
	.filter((row) => localDayKey(row.startedAt) === requestedDay)
	.sort((left, right) => left.startedAt - right.startedAt);

const cutoff = Math.max(...opencodeRows.map((row) => number(row.startedAt)));
const localToCutoff = localRows.filter((row) => row.startedAt <= cutoff + 60_000);
function multisetDifference(leftRows, rightRows, leftKeyFor, rightKeyFor) {
	const counts = new Map();
	for (const row of leftRows) {
		const key = leftKeyFor(row);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (const row of rightRows) {
		const key = rightKeyFor(row);
		const count = counts.get(key);
		if (!count) continue;
		if (count === 1) counts.delete(key);
		else counts.set(key, count - 1);
	}
	return [...counts.entries()].map(([key, count]) => ({ key, count }));
}
const opencodeSignature = (row) =>
	[
		row.model,
		number(row.statusCode),
		number(row.inputTokens),
		number(row.cacheReadTokens),
		number(row.cacheWriteTokens),
		number(row.outputTokens),
		number(row.reasoningTokens),
	].join("|");
const localSignature = (row) =>
	[
		row.model,
		number(row.statusCode),
		number(row.freshInputTokens),
		number(row.cacheReadTokens),
		number(row.cacheWriteTokens),
		number(row.outputTokens),
		number(row.reasoningTokens),
	].join("|");
const groupedTotals = (rows, source) =>
	Object.fromEntries(
		[
			...new Set(
				rows.map((row) => `${row.model}|${number(row.statusCode)}`),
			),
		].map((key) => {
			const matches = rows.filter(
				(row) => `${row.model}|${number(row.statusCode)}` === key,
			);
			return [key, compactTotals(matches, source)];
		}),
	);
const localAfterCutoff = localRows.filter((row) => row.startedAt > cutoff + 60_000);
const opencodeOnly = multisetDifference(
	opencodeRows,
	localToCutoff,
	opencodeSignature,
	localSignature,
);
const extensionOnly = multisetDifference(
	localToCutoff,
	opencodeRows,
	localSignature,
	opencodeSignature,
);
console.log(
	JSON.stringify(
		{
			day: requestedDay,
			opencode: compactTotals(opencodeRows, "opencode"),
			extension: compactTotals(localToCutoff, "extension"),
			extensionAllDay: compactTotals(localRows, "extension"),
			extensionAfterOpencodeCutoff: compactTotals(
				localAfterCutoff,
				"extension",
			),
			delta:
				compactTotals(localToCutoff, "extension").total -
				compactTotals(opencodeRows, "opencode").total,
			matching: {
				opencodeRows: opencodeRows.length,
				extensionRowsToCutoff: localToCutoff.length,
				opencodeOnlySignatures: opencodeOnly.length,
				extensionOnlySignatures: extensionOnly.length,
			},
			opencodeOnlySignatures: opencodeOnly.map(({ key, count }) => ({
				key,
				count,
				examples: opencodeRows
					.filter((row) => opencodeSignature(row) === key)
					.slice(0, 5)
					.map((row) => ({
						startedAt: number(row.startedAt),
						requestID: row.requestID,
						outcome: row.outcome,
						errorCode: row.errorCode,
						finish: row.finish,
					})),
			})),
			extensionOnlySignatures: extensionOnly.map(({ key, count }) => ({
				key,
				count,
				examples: localToCutoff
					.filter((row) => localSignature(row) === key)
					.slice(0, 5)
					.map((row) => ({
						startedAt: row.startedAt,
						id: row.id,
						statusCode: row.statusCode,
					})),
			})),
			opencodeGroups: groupedTotals(opencodeRows, "opencode"),
			extensionGroups: groupedTotals(localToCutoff, "extension"),
			timeRange: {
				opencodeFirst: opencodeRows[0]?.startedAt,
				opencodeLast: opencodeRows.at(-1)?.startedAt,
				extensionFirst: localToCutoff[0]?.startedAt,
				extensionLast: localToCutoff.at(-1)?.startedAt,
			},
		},
		null,
		2,
	),
);
