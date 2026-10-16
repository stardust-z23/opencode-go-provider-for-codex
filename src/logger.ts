/**
 * 输出通道日志器，支持请求头脱敏（与 OpenCode Go Provider for Copilot 的
 * 日志器一致，另加一个可防循环引用的 JSON 序列化）。
 */

import * as vscode from "vscode";

const SENSITIVE_HEADER_KEYS = [
	"authorization",
	"proxy-authorization",
	"x-api-key",
	"x-goog-api-key",
	"x-mirror-token",
	"api-key",
];

class Logger {
	private channel?: vscode.LogOutputChannel;

	/** 创建 VS Code 输出通道，激活时调用一次。 */
	init(): void {
		this.channel = vscode.window.createOutputChannel("OpenCode Go for Codex", { log: true });
	}

	debug(tag: string, data: unknown): void {
		this.channel?.debug(`[${tag}]`, safeStringify(data));
	}

	info(tag: string, data: unknown): void {
		this.channel?.info(`[${tag}]`, safeStringify(data));
	}

	warn(tag: string, data: unknown): void {
		this.channel?.warn(`[${tag}]`, safeStringify(data));
	}

	error(tag: string, data: unknown): void {
		this.channel?.error(`[${tag}]`, safeStringify(data));
	}

	/** 记录日志前对敏感请求头做脱敏。 */
	sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
		const sanitized: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			const isSensitive = SENSITIVE_HEADER_KEYS.includes(key.toLowerCase());
			sanitized[key] = isSensitive ? "***" : value;
		}
		return sanitized;
	}

	dispose(): void {
		this.channel?.dispose();
	}
}

/** 永不抛异常的 `JSON.stringify`（循环引用、BigInt 等都能兜住）。 */
function safeStringify(value: unknown): string {
	if (value === undefined) {
		return "undefined";
	}
	try {
		return JSON.stringify(value);
	} catch {
		try {
			return String(value);
		} catch {
			return "<unserializable>";
		}
	}
}

export const logger = new Logger();
