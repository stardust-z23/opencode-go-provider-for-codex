/**
 * OpenCode Go 套餐额度获取。
 *
 * 从官方额度端点（`GET <base>/usage`）拉取 Go 套餐用量，并缓存 5 分钟；
 * 拉取失败时沿用旧缓存（静默降级）。端点与推理共用同一把 Bearer 密钥，
 * 返回滚动（5 小时）、周（7 天）、月三个窗口的使用率，以及「额度用尽后是否
 * 回落到余额」的 `useBalance` 标志。没有 Go 套餐或套餐已过期时表现为
 * HTTP 401。
 *
 * 响应按宽容方式解析（兼容多种字段名），上游的小改动只会降级，不会崩。
 *
 * 不引入 `vscode`：解析与格式化函数都能在纯 Node 下做单元测试
 * （见 scripts/test-go-usage.mjs）。
 */

import { logger } from "./logger";
import { OPENCODE_GO_BASE_URL } from "./tomlEdit";
import { extractHttpStatus, fetchJsonWithTimeout } from "./utils";

/** 缓存有效期：端点要做多表关联，轮询别太频繁。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** 最近一次额度拉取的结果状态。 */
export type UsageFetchStatus = "ok" | "unauthorized" | "error";

/** 单个额度窗口（滚动 / 周 / 月）。 */
export interface GoUsageWindow {
	/** 窗口使用率，0-100。 */
	percent: number;
	/** API 给出时的窗口重置时间（ISO 字符串）。 */
	resetsAt?: string;
}

/** Go 套餐额度快照。 */
export interface GoUsageResult {
	/** 5 小时滚动窗口。 */
	rolling?: GoUsageWindow;
	/** 7 天周窗口。 */
	weekly?: GoUsageWindow;
	/** 月度窗口。 */
	monthly?: GoUsageWindow;
	/** Go 额度用尽后是否回落到余额。 */
	useBalance?: boolean;
	/** 最近一次成功拉取的时刻（用于状态栏的「更新于 …」）。 */
	fetchedAt?: number;
}

// ── 模块级缓存 ──

let cachedUsage: GoUsageResult | null = null;
let cacheTimestamp = 0;
let lastFetchStatus: UsageFetchStatus = "error";
let lastErrorDetail: string | undefined;

/** 额度端点 URL（去掉 base 末尾斜杠，避免拼出 `//usage`）。 */
export function usageUrl(baseUrl: string = OPENCODE_GO_BASE_URL): string {
	return `${baseUrl.replace(/\/+$/, "")}/usage`;
}

/**
 * 宽容解析单个窗口对象。
 * 接受 percent / usagePercent / usage_percent，以及
 * resetsAt / resetAt / reset_in_sec / resets_in_seconds。
 */
export function parseUsageWindow(raw: unknown): GoUsageWindow | undefined {
	if (typeof raw !== "object" || raw === null) {
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const percentValue = obj.percent ?? obj.usagePercent ?? obj.usage_percent;
	const percent = typeof percentValue === "number" ? percentValue : Number.parseFloat(String(percentValue ?? ""));
	if (!Number.isFinite(percent) || percent < 0) {
		return undefined;
	}

	let resetsAt: string | undefined;
	const resetsAtValue = obj.resetsAt ?? obj.resetAt;
	if (typeof resetsAtValue === "string") {
		const timestamp = Date.parse(resetsAtValue);
		if (!Number.isNaN(timestamp)) {
			resetsAt = new Date(timestamp).toISOString();
		}
	}
	if (!resetsAt) {
		const resetInSecValue = obj.reset_in_sec ?? obj.resets_in_seconds;
		const resetInSec =
			typeof resetInSecValue === "number" ? resetInSecValue : Number.parseFloat(String(resetInSecValue ?? ""));
		if (Number.isFinite(resetInSec) && resetInSec > 0) {
			resetsAt = new Date(Date.now() + resetInSec * 1000).toISOString();
		}
	}

	return { percent: Math.min(Math.max(percent, 0), 100), resetsAt };
}

/**
 * 宽容解析整个响应体：接受 `{ usage: {...} }`、`{ windows: {...} }` 或平铺字段。
 */
export function parseGoUsagePayload(payload: unknown): GoUsageResult {
	const body = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
	const nested = (value: unknown): Record<string, unknown> | undefined =>
		typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	const source = nested(body.usage) ?? nested(body.windows) ?? body;

	return {
		rolling: parseUsageWindow(source.rolling ?? source["5h"]),
		weekly: parseUsageWindow(source.weekly ?? source["7d"]),
		monthly: parseUsageWindow(source.monthly ?? source["30d"]),
		useBalance: typeof body.useBalance === "boolean" ? body.useBalance : undefined,
	};
}

/**
 * 把剩余秒数格式化成紧凑时长，例如 "3d 12h"、"2h 13m"、"45m"。
 * 与 OpenCode Go Monitor 的展示保持一致。
 */
export function formatDuration(seconds: number): string {
	const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	if (days > 0) {
		return `${days}d ${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

/** 把 ISO 重置时间格式化成紧凑倒计时，例如 "2h 13m"、"45m"。 */
export function formatResetDuration(iso: string, now: number = Date.now()): string {
	const diffMs = new Date(iso).getTime() - now;
	if (Number.isNaN(diffMs)) {
		return "";
	}
	return formatDuration(diffMs / 1000);
}

export type ProgressBarTheme = "light" | "dark" | "highContrast" | "highContrastLight";

const PROGRESS_BAR_COLORS: Record<ProgressBarTheme, { track: string; fill: string }> = {
	light: { track: "#d8d4c9", fill: "#5f8588" },
	dark: { track: "#4a4a4a", fill: "#8fb6b4" },
	highContrast: { track: "#666666", fill: "#ffffff" },
	highContrastLight: { track: "#c8c8c8", fill: "#000000" },
};

/** 固定像素宽度的 SVG 进度条，不受界面语言和字体回退影响。 */
export function formatProgressBarHtml(
	percent: number,
	theme: ProgressBarTheme,
	width = 160,
	height = 8,
): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filledWidth =
		clamped === 0 ? 0 : Math.max(2, Math.round((clamped / 100) * width * 10) / 10);
	const radius = Math.min(4, height / 2, filledWidth / 2);
	const colors = PROGRESS_BAR_COLORS[theme];
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		`<rect width="${width}" height="${height}" rx="${height / 2}" fill="${colors.track}"/>` +
		(filledWidth > 0
			? `<rect width="${filledWidth}" height="${height}" rx="${radius}" fill="${colors.fill}"/>`
			: "") +
		"</svg>";
	const encoded = Buffer.from(svg, "utf8").toString("base64");
	return `<img alt="" width="${width}" height="${height}" align="absmiddle" src="data:image/svg+xml;base64,${encoded}">`;
}


/** 把额度百分比格式化为紧凑整数显示。 */
export function formatUsagePercent(percent: number | undefined, limitLabel = "limit"): string {
	if (percent === undefined || !Number.isFinite(percent)) {
		return "?%";
	}
	if (percent >= 100) {
		return limitLabel;
	}
	if (percent <= 0) {
		return "0%";
	}
	if (percent < 1) {
		return "<1%";
	}
	return `${Math.round(percent)}%`;
}

/** 生成一行摘要，例如 "5h: 65% · 7d: 30% · 30d: 12%"。 */
export function formatUsageSummary(usage: GoUsageResult, limitLabel = "limit"): string {
	const windows: Array<[string, GoUsageWindow | undefined]> = [
		["5h", usage.rolling],
		["7d", usage.weekly],
		["30d", usage.monthly],
	];
	return windows
		.filter((entry): entry is [string, GoUsageWindow] => entry[1] !== undefined)
		.map(([label, window]) => `${label}: ${formatUsagePercent(window.percent, limitLabel)}`)
		.join(" · ");
}

/** 同步读取缓存的额度快照（供状态栏渲染使用）。 */
export function getUsageSnapshot(): GoUsageResult | null {
	return cachedUsage;
}

/** 最近一次拉取的状态。 */
export function getUsageFetchStatus(): UsageFetchStatus {
	return lastFetchStatus;
}

/** 最近一次拉取失败的原始原因（供状态栏提示，不含密钥）。 */
export function getUsageErrorDetail(): string | undefined {
	return lastErrorDetail;
}

/** 清空额度缓存（例如切换 API 密钥后）。 */
export function clearUsageCache(): void {
	cachedUsage = null;
	cacheTimestamp = 0;
	lastFetchStatus = "error";
	lastErrorDetail = undefined;
}

/**
 * 获取 Go 套餐额度；缓存过期时重新拉取。
 *
 * @param apiKey API 密钥；缺省时跳过拉取。
 * @param force 为 true 时忽略缓存强制拉取（用户手动刷新时使用）。
 * @returns 额度快照；失败时返回旧缓存或 null（静默降级）。
 */
export async function getGoUsageCached(apiKey: string | undefined, force = false): Promise<GoUsageResult | null> {
	const now = Date.now();
	if (!force && cachedUsage !== null && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedUsage;
	}
	if (!apiKey) {
		return cachedUsage;
	}

	const url = usageUrl();
	const start = Date.now();
	try {
		const payload = await fetchJsonWithTimeout<unknown>(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			timeoutMs: FETCH_TIMEOUT_MS,
		});
		const usage: GoUsageResult = { ...parseGoUsagePayload(payload), fetchedAt: Date.now() };
		cachedUsage = usage;
		cacheTimestamp = now;
		lastFetchStatus = "ok";
		lastErrorDetail = undefined;
		logger.info("goUsage.fetch.ok", {
			durationMs: Date.now() - start,
			rolling: usage.rolling?.percent,
			weekly: usage.weekly?.percent,
			monthly: usage.monthly?.percent,
			rollingDisplay: usage.rolling
				? formatUsagePercent(usage.rolling.percent)
				: undefined,
			weeklyDisplay: usage.weekly
				? formatUsagePercent(usage.weekly.percent)
				: undefined,
			monthlyDisplay: usage.monthly
				? formatUsagePercent(usage.monthly.percent)
				: undefined,
			useBalance: usage.useBalance,
		});
		return usage;
	} catch (err) {
		// 拉取失败：保留旧缓存，仅记录状态供诊断（401 表示没有可用的 Go 套餐）。
		const message = err instanceof Error ? err.message : String(err);
		const status = extractHttpStatus(message);
		lastFetchStatus = status === 401 ? "unauthorized" : "error";
		lastErrorDetail = message;
		const detail = { status: lastFetchStatus, url, error: message };
		if (lastFetchStatus === "unauthorized") {
			logger.warn("goUsage.fetch.unauthorized", detail);
		} else {
			logger.warn("goUsage.fetch.failed", detail);
		}
		return cachedUsage;
	}
}
