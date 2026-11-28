/**
 * Native Anthropic Messages pass-through for Claude Code.
 *
 * Codex speaks Responses and needs translation in both directions. Claude Code
 * already speaks Anthropic Messages, and OpenCode Go exposes the same wire
 * format (it translates for models whose native API differs), so the only work
 * left is routing:
 *
 *   - rewrite `model` to the OpenCode Go id the account actually serves;
 *   - swap the derived local proxy token for the real upstream key;
 *   - inject `x-opencode-session`, which the Go gateway requires and rejects
 *     with `400 MissingSessionID` before authentication otherwise;
 *   - report the client as this extension rather than as a bare SDK.
 *
 * The request body is never reshaped. That keeps `thinking`, `output_config`,
 * `context_management`, `cache_control`, `anthropic-beta` and anything Anthropic
 * adds later intact, and it keeps the SSE stream byte-identical, which Claude
 * Code relies on for tool streaming and thinking blocks.
 */

import * as http from "http";
import type { MessagesModelDecision } from "../modelRouting";
import { getUserAgent } from "../utils";
import { anthropicUsageToResponsesUsage } from "./messages";

export type NativeMessagesEndpoint = "messages" | "count_tokens";

export interface NativeMessagesOptions {
	/**
	 * Anthropic-compatible upstream base without the endpoint path, e.g.
	 * `https://opencode.ai/inference/go/anthropic`. A trailing `/v1` is also
	 * accepted so tests and older configurations keep working.
	 */
	upstreamBaseUrl: string;
	log?: (message: string, detail?: Record<string, unknown>) => void;
	usage?: (purpose: string, usage: Record<string, unknown> | undefined) => void;
	upstreamError?: (upstream: Response, detail: string) => void;
}

export interface NativeMessagesContext {
	/** Parsed Anthropic Messages request; only `model` is rewritten. */
	body: Record<string, unknown>;
	apiKey: string;
	sessionId?: string;
	stream: boolean;
	route: MessagesModelDecision;
}

const ANTHROPIC_VERSION = "2023-06-01";

/** Headers the proxy owns; everything else is forwarded untouched. */
const OWNED_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"content-length",
	"accept-encoding",
	"upgrade",
	"te",
	"trailer",
	"authorization",
	"x-api-key",
	"user-agent",
	"accept",
	"content-type",
	"expect",
	"x-codexgo-loopback-probe",
]);

const RELAYED_RESPONSE_HEADERS = [
	"content-type",
	"request-id",
	"x-request-id",
	"retry-after",
];

export async function proxyNativeMessages(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: NativeMessagesOptions,
	context: NativeMessagesContext,
	endpoint: NativeMessagesEndpoint,
): Promise<void> {
	const upstreamModelId = context.route.upstreamModelId.trim();
	if (!upstreamModelId) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "Missing model",
				},
			}),
		);
		return;
	}
	context.body.model = upstreamModelId;

	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) {
			controller.abort();
		}
	});

	const stream = endpoint === "messages" && context.stream;
	const upstream = await fetch(
		messagesUrl(
			options.upstreamBaseUrl,
			endpoint,
			new URL(req.url ?? "/", "http://127.0.0.1").search,
		),
		{
			method: "POST",
			headers: buildNativeMessagesHeaders(
				req.headers,
				context.apiKey,
				stream,
				context.sessionId,
			),
			body: JSON.stringify(context.body),
			signal: controller.signal,
		},
	);

	if (!upstream.ok) {
		const text = await upstream.text();
		options.upstreamError?.(upstream, text);
		relayResponse(res, upstream, text);
		return;
	}

	const contentType = upstream.headers.get("content-type") ?? "";
	if (endpoint === "count_tokens" || !stream || !contentType.includes("text/event-stream")) {
		const text = await upstream.text();
		const payload = parseJsonRecord(text);
		const usage = payload ? usageFromPayload(payload) : undefined;
		if (usage) {
			options.usage?.("messages", usage);
		}
		relayResponse(res, upstream, text);
		return;
	}

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
		...pickHeaders(upstream, RELAYED_RESPONSE_HEADERS, ["content-type"]),
	});
	const relay = await pipeAnthropicSseVerbatim(upstream, res);
	const usage = mergeAnthropicUsage(relay.usage);
	if (usage) {
		options.usage?.("messages", usage);
	}
	if (!relay.sawMessageStop) {
		options.log?.("messages.stream.incomplete", {
			model: upstreamModelId,
			stopReason: relay.stopReason,
			events: relay.events,
		});
	}
	if (relay.errorMessage) {
		options.log?.("messages.stream.error_event", {
			model: upstreamModelId,
			error: relay.errorMessage.slice(0, 500),
		});
	}
}

/**
 * Forward the upstream SSE stream byte for byte while parsing a copy of the
 * events for usage. Nothing is buffered on the client path: every chunk is
 * written as soon as it arrives, so `ping` frames keep Claude Code's idle
 * timers alive exactly as Anthropic sends them.
 */
async function pipeAnthropicSseVerbatim(
	upstream: Response,
	res: http.ServerResponse,
): Promise<{
	usage: Record<string, unknown>;
	sawMessageStop: boolean;
	stopReason?: string;
	events: number;
	errorMessage?: string;
}> {
	const usage: Record<string, unknown> = {};
	let sawMessageStop = false;
	let stopReason: string | undefined;
	let events = 0;
	let errorMessage: string | undefined;

	if (!upstream.body) {
		res.end();
		return { usage, sawMessageStop, stopReason, events, errorMessage };
	}

	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const consume = (block: string): void => {
		const event = parseAnthropicSseBlock(block);
		if (!event) {
			return;
		}
		events++;
		const type = typeof event.type === "string" ? event.type : "";
		if (type === "message_start") {
			mergeUsage(usage, isRecord(event.message) ? event.message.usage : undefined);
			return;
		}
		if (type === "message_delta") {
			mergeUsage(usage, event.usage);
			const delta = isRecord(event.delta) ? event.delta : undefined;
			if (delta && typeof delta.stop_reason === "string") {
				stopReason = delta.stop_reason;
			}
			return;
		}
		if (type === "message_stop") {
			sawMessageStop = true;
			return;
		}
		if (type === "error") {
			const error = isRecord(event.error) ? event.error : event;
			errorMessage =
				typeof error.message === "string" ? error.message : JSON.stringify(error);
		}
	};

	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		if (value && value.byteLength > 0) {
			res.write(Buffer.from(value));
		}
		buffer += decoder.decode(value, { stream: true });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			if (block.trim()) {
				consume(block);
			}
			boundary = buffer.indexOf("\n\n");
		}
	}
	buffer += decoder.decode();
	buffer = buffer.replace(/\r\n/g, "\n");
	if (buffer.trim()) {
		consume(buffer);
	}
	res.end();
	return { usage, sawMessageStop, stopReason, events, errorMessage };
}

function buildNativeMessagesHeaders(
	headers: http.IncomingHttpHeaders,
	apiKey: string,
	stream: boolean,
	sessionId?: string,
): Record<string, string> {
	const result: Record<string, string> = {
		authorization: `Bearer ${apiKey}`,
		"x-api-key": apiKey,
		"content-type": "application/json",
		accept: stream ? "text/event-stream" : "application/json",
		"user-agent": getUserAgent(),
		"anthropic-version": headerValue(headers["anthropic-version"]) ?? ANTHROPIC_VERSION,
	};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (OWNED_REQUEST_HEADERS.has(lower)) {
			continue;
		}
		const text = headerValue(value);
		if (text) {
			result[lower] = text;
		}
	}
	const session = sessionId?.trim();
	if (session) {
		result["x-opencode-session"] = session;
	}
	return result;
}

function relayResponse(
	res: http.ServerResponse,
	upstream: Response,
	text: string,
): void {
	res.writeHead(
		upstream.status,
		pickHeaders(upstream, RELAYED_RESPONSE_HEADERS, []),
	);
	res.end(text);
}

function pickHeaders(
	upstream: Response,
	names: string[],
	skip: string[],
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const name of names) {
		if (skip.includes(name)) {
			continue;
		}
		const value = upstream.headers.get(name);
		if (value) {
			result[name] = value;
		}
	}
	return result;
}

/** `base/v1/messages` unless the base already carries the version segment. */
export function messagesUrl(
	baseUrl: string,
	endpoint: NativeMessagesEndpoint,
	search = "",
): string {
	const base = baseUrl.replace(/\/+$/, "");
	const path =
		endpoint === "count_tokens" ? "v1/messages/count_tokens" : "v1/messages";
	const suffix = search && search !== "?" ? search : "";
	if (/\/v1$/i.test(base)) {
		return `${base}${path.replace(/^v1/, "")}${suffix}`;
	}
	return `${base}/${path}${suffix}`;
}

function usageFromPayload(
	payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const usage = isRecord(payload.usage) ? payload.usage : undefined;
	return usage ? mergeAnthropicUsage(usage) : undefined;
}

function mergeAnthropicUsage(
	usage: Record<string, unknown>,
): Record<string, unknown> | undefined {
	return Object.keys(usage).length > 0
		? anthropicUsageToResponsesUsage(usage)
		: undefined;
}

function mergeUsage(
	target: Record<string, unknown>,
	raw: unknown,
): void {
	if (!isRecord(raw)) {
		return;
	}
	for (const [key, value] of Object.entries(raw)) {
		target[key] = value;
	}
}

/** Parse one SSE frame's `data:` payload; `ping` and comments yield nothing. */
function parseAnthropicSseBlock(block: string): Record<string, unknown> | undefined {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data) {
		return undefined;
	}
	return parseJsonRecord(data);
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
