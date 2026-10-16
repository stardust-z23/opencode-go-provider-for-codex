/**
 * 各模块共用的小工具，零依赖（不引入 `vscode`，单元测试可直接在纯 Node 下运行）。
 */

/**
 * 每次请求 OpenCode Go 时通过 `User-Agent` 头发送的客户端标识。
 *
 * 陷阱（来自 OpenCode Go 文档）：客户端必须用自己的 user agent 标识自身，
 * 使用通用 SDK / HTTP 库名称会被判定为滥用，可能遭到限流。
 * 修改时请与 package.json 保持同步。
 */
export const USER_AGENT = "opencode-go-provider-for-codex/0.1.0";

/** models.dev 镜像用来标识流量的请求头。 */
export const MIRROR_PLATFORM_HEADER = "opencode-go-provider-for-codex";

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface JsonFetchOptions {
	headers?: Record<string, string>;
	timeoutMs?: number;
}

/**
 * 带硬超时、且强制携带客户端 user agent 的 JSON 请求。
 *
 * 规避的陷阱：
 * - 始终带上 `User-Agent` 与 `Accept` 头（绝不使用裸的库默认 UA）。
 * - 中断异常转换成简明友好的 Error（原始 DOMException 只会给出
 *   "The operation was aborted"，没有任何上下文）。
 * - 非 2xx 响应统一变成 `HTTP [<状态码>]` 错误：方括号里的状态码由调用方
 *   解析（例如识别 401/403 密钥问题）。
 * - 错误响应体先截断，再放进消息 / 日志。
 */
export async function fetchJsonWithTimeout<T = unknown>(url: string, options?: JsonFetchOptions): Promise<T> {
	const timeoutMs = options?.timeoutMs ?? 20_000;
	let response: Response;
	try {
		response = await fetch(url, {
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"User-Agent": USER_AGENT,
				Accept: "application/json",
				...options?.headers,
			},
		});
	} catch (err) {
		if (isAbortError(err)) {
			throw new Error(`Request timed out after ${timeoutMs}ms`);
		}
		throw err;
	}
	if (!response.ok) {
		let detail = "";
		try {
			detail = (await response.text()).slice(0, 300);
		} catch {
			// 响应体不可用：有状态行就够了。
		}
		throw new Error(`HTTP [${response.status}] ${response.statusText}${detail ? ` — ${detail}` : ""}`);
	}
	return (await response.json()) as T;
}

function isAbortError(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

/** 从 `HTTP [<状态码>] ...` 消息中提取 HTTP 状态码。 */
export function extractHttpStatus(message: string): number | undefined {
	const match = message.match(/\[(\d{3})\]/);
	return match ? Number(match[1]) : undefined;
}
