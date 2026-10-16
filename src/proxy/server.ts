import { randomUUID } from "crypto";
import * as http from "http";
import { Readable } from "stream";
import { USER_AGENT } from "../utils";
import { proxyAnthropicMessages } from "./messages";

export type ProxyWireApi = "responses" | "chat" | "anthropic";

export interface LocalProxyOptions {
	host?: string;
	port: number;
	upstreamBaseUrl: string;
	resolveApiKey: () => Promise<string | undefined>;
	resolveWireApi: (modelId: string) => ProxyWireApi | undefined | Promise<ProxyWireApi | undefined>;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface LocalProxyServer {
	address: string;
	port: number;
	baseUrl: string;
	close: () => Promise<void>;
}

export interface ChatToolMapping {
	chatName: string;
	responseName: string;
	namespace?: string;
	custom: boolean;
}

export interface ChatTransformResult {
	body: Record<string, unknown>;
	toolMappings: Map<string, ChatToolMapping>;
}

interface ProxyRequestContext {
	body: Record<string, unknown>;
	apiKey: string;
	wireApi: ProxyWireApi;
}

interface ToolState {
	index: number;
	itemId: string;
	outputIndex?: number;
	callId: string;
	chatName: string;
	arguments: string;
	added: boolean;
	mapping?: ChatToolMapping;
}

interface OutputTextState {
	itemId: string;
	outputIndex: number;
	text: string;
	closed: boolean;
}

interface ReasoningState {
	itemId: string;
	outputIndex: number;
	text: string;
	closed: boolean;
}

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const PROXY_MANAGED_PLACEHOLDER = "PROXY_MANAGED";
const INLINE_THINK_OPEN = "<" + "think" + ">";
const INLINE_THINK_CLOSE = "<" + "/" + "think" + ">";

/**
 * Starts a loopback-only Responses API bridge.
 *
 * Native Responses models are forwarded unchanged. Chat Completions and
 * Anthropic Messages models are translated in both directions.
 */
export async function startLocalProxy(options: LocalProxyOptions): Promise<LocalProxyServer> {
	const host = options.host ?? "127.0.0.1";
	const server = http.createServer((req, res) => {
		void handleProxyRequest(req, res, options).catch((error) => {
			writeError(res, error);
		});
	});

	server.on("clientError", (_error, socket) => {
		socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(options.port, host);
	});

	const address = server.address();
	const port = typeof address === "object" && address ? address.port : options.port;
	return {
		address: host,
		port,
		baseUrl: `http://${host}:${port}/v1`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

async function handleProxyRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: LocalProxyOptions,
): Promise<void> {
	if (!isLoopbackRequest(req)) {
		res.writeHead(403, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Loopback access only" } }));
		return;
	}

	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: "ok" }));
		return;
	}
	if (req.method === "GET" && (url.pathname === "/models" || url.pathname === "/v1/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [] }));
		return;
	}
	if (req.method !== "POST") {
		res.writeHead(405, { "content-type": "application/json", allow: "POST" });
		res.end(JSON.stringify({ error: { message: "Method not allowed" } }));
		return;
	}

	const endpoint = normalizeResponsesPath(url.pathname);
	if (!endpoint) {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Unknown proxy endpoint" } }));
		return;
	}

	const rawBody = await readRequestBody(req);
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
	} catch {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Invalid JSON request body" } }));
		return;
	}

	const modelId = typeof body.model === "string" ? body.model.trim() : "";
	if (!modelId) {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Missing model" } }));
		return;
	}

	const configuredKey = (await options.resolveApiKey())?.trim();
	const incomingKey = bearerToken(req.headers.authorization);
	if (!isAuthorized(incomingKey, configuredKey)) {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Unauthorized proxy request" } }));
		return;
	}
	const apiKey =
		configuredKey ??
		(incomingKey && incomingKey !== PROXY_MANAGED_PLACEHOLDER ? incomingKey : undefined);
	if (!apiKey) {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "OpenCode Go API key is not configured" } }));
		return;
	}

	const wireApi = (await options.resolveWireApi(modelId)) ?? "chat";

	const context: ProxyRequestContext = { body, apiKey, wireApi };
	if (wireApi !== "responses" && hasCompactionTrigger(body)) {
		res.writeHead(501, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: {
					message: `${wireApi === "anthropic" ? "Anthropic Messages" : "Chat Completions"} remote compaction is not supported`,
				},
			}),
		);
		return;
	}
	if (endpoint === "compact") {
		if (wireApi !== "responses") {
			res.writeHead(501, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					error: {
						message: `${wireApi === "anthropic" ? "Anthropic Messages" : "Chat Completions"} compaction is not supported`,
					},
				}),
			);
			return;
		}
		await proxyNativeResponses(req, res, options, context, "responses/compact");
		return;
	}

	if (wireApi === "responses") {
		await proxyNativeResponses(req, res, options, context, "responses");
		return;
	}

	if (wireApi === "anthropic") {
		await proxyAnthropicMessages(req, res, options, context);
		return;
	}

	await proxyChatCompletions(req, res, options, context);
}

function hasCompactionTrigger(body: Record<string, unknown>): boolean {
	return (
		Array.isArray(body.input) &&
		body.input.some(
			(item) => isRecord(item) && item.type === "compaction_trigger",
		)
	);
}

function normalizeResponsesPath(pathname: string): "responses" | "compact" | undefined {
	const normalized = pathname.replace(/\/+/g, "/").replace(/\/$/, "");
	if (
		normalized === "/responses" ||
		normalized === "/v1/responses" ||
		normalized === "/v1/v1/responses"
	) {
		return "responses";
	}
	if (
		normalized === "/responses/compact" ||
		normalized === "/v1/responses/compact" ||
		normalized === "/v1/v1/responses/compact"
	) {
		return "compact";
	}
	return undefined;
}

async function proxyNativeResponses(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: LocalProxyOptions,
	context: ProxyRequestContext,
	endpoint: string,
): Promise<void> {
	const repaired = repairNativeResponsesRequest(context.body);
	if (repaired.changed) {
		options.log?.("responses.reasoning_repaired", {
			endpoint,
			model: typeof context.body.model === "string" ? context.body.model : undefined,
		});
	}
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) {
			controller.abort();
		}
	});

	const upstream = await fetch(joinUrl(options.upstreamBaseUrl, endpoint), {
		method: "POST",
		headers: buildUpstreamHeaders(req.headers, context.apiKey, context.body.stream !== false),
		body: JSON.stringify(repaired.body),
		signal: controller.signal,
	});

	if (!upstream.ok) {
		await relayUpstreamError(res, upstream);
		return;
	}

	res.statusCode = upstream.status;
	copyResponseHeaders(upstream, res);
	if (!upstream.body) {
		res.end();
		return;
	}
	Readable.fromWeb(upstream.body as never).pipe(res);
}

/**
 * OpenCode Go's thinking models require the original `reasoning_text` to be
 * replayed on the next request. Codex keeps the text as a `summary_text` part
 * but sends `content: null`, so restore the Responses input shape here.
 */
export function repairNativeResponsesRequest(
	body: Record<string, unknown>,
): { body: Record<string, unknown>; changed: boolean } {
	if (!Array.isArray(body.input)) {
		return { body, changed: false };
	}
	let changed = false;
	for (const item of body.input) {
		if (!isRecord(item) || item.type !== "reasoning") {
			continue;
		}
		const content = Array.isArray(item.content) ? item.content : undefined;
		let hasReasoningText = false;
		if (content) {
			for (const part of content) {
				if (!isRecord(part)) {
					continue;
				}
				if (part.type === "reasoning_text" && typeof part.text === "string" && part.text) {
					hasReasoningText = true;
					break;
				}
				if (part.type === "summary_text" && typeof part.text === "string" && part.text) {
					part.type = "reasoning_text";
					hasReasoningText = true;
					changed = true;
				}
			}
		}
		if (hasReasoningText) {
			continue;
		}
		const summaryText = reasoningSummaryText(item.summary);
		if (!summaryText) {
			continue;
		}
		item.content = [{ type: "reasoning_text", text: summaryText }];
		changed = true;
	}
	return { body, changed };
}

function reasoningSummaryText(summary: unknown): string {
	if (typeof summary === "string") {
		return summary;
	}
	if (!Array.isArray(summary)) {
		return "";
	}
	return summary
		.map((part) => {
			if (typeof part === "string") {
				return part;
			}
			if (isRecord(part) && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((text) => text.trim().length > 0)
		.join("\n\n");
}

async function proxyChatCompletions(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: LocalProxyOptions,
	context: ProxyRequestContext,
): Promise<void> {
	const transformed = responsesToChatRequest(context.body);
	const stream = transformed.body.stream !== false;
	transformed.body.stream = stream;
	if (stream) {
		transformed.body.stream_options = {
			include_usage: true,
			...(isRecord(transformed.body.stream_options) ? transformed.body.stream_options : {}),
		};
	}

	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) {
			controller.abort();
		}
	});

	const upstream = await fetch(joinUrl(options.upstreamBaseUrl, "chat/completions"), {
		method: "POST",
		headers: buildUpstreamHeaders(req.headers, context.apiKey, stream),
		body: JSON.stringify(transformed.body),
		signal: controller.signal,
	});

	if (!upstream.ok) {
		await relayUpstreamError(res, upstream);
		return;
	}

	if (!stream) {
		const payload = (await upstream.json()) as Record<string, unknown>;
		const response = chatJsonToResponses(
			payload,
			typeof context.body.model === "string" ? context.body.model : "",
			transformed.toolMappings,
		);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(response));
		return;
	}

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});

	const writer = new ChatSseToResponsesWriter(
		res,
		transformed.toolMappings,
		typeof context.body.model === "string" ? context.body.model : "",
	);
	writer.start();
	try {
		await pipeChatSse(upstream, writer);
		writer.finish();
	} catch (error) {
		writer.fail(error instanceof Error ? error.message : String(error));
	}
}

export function responsesToChatRequest(body: Record<string, unknown>): ChatTransformResult {
	const toolMappings = new Map<string, ChatToolMapping>();
	const usedNames = new Set<string>();
	const tools = collectChatTools(body, toolMappings, usedNames);
	const messages: Array<Record<string, unknown>> = [];

	if (typeof body.instructions === "string" && body.instructions.trim()) {
		messages.push({ role: "system", content: body.instructions });
	}
	appendResponsesInput(messages, body.input, toolMappings, usedNames);

	const request: Record<string, unknown> = {
		model: body.model,
		messages,
		stream: body.stream !== false,
	};
	if (tools.length > 0) {
		request.tools = tools;
	}
	if (body.parallel_tool_calls !== undefined && tools.length > 0) {
		request.parallel_tool_calls = body.parallel_tool_calls;
	}
	if (body.tool_choice !== undefined && tools.length > 0) {
		request.tool_choice = convertToolChoice(body.tool_choice, toolMappings);
	}

	copyNumber(body, request, "temperature");
	copyNumber(body, request, "top_p");
	if (typeof body.max_output_tokens === "number") {
		request.max_tokens = body.max_output_tokens;
	}
	if (isRecord(body.reasoning) && typeof body.reasoning.effort === "string") {
		request.reasoning_effort = body.reasoning.effort;
	}
	if (isRecord(body.text) && isRecord(body.text.format)) {
		const format = body.text.format;
		if (format.type === "json_schema" && isRecord(format.schema)) {
			request.response_format = {
				type: "json_schema",
				json_schema: {
					name: typeof format.name === "string" ? format.name : "response",
					schema: format.schema,
					strict: format.strict === true,
				},
			};
		} else if (format.type === "json_object") {
			request.response_format = { type: "json_object" };
		}
	}

	return { body: request, toolMappings };
}

function collectChatTools(
	body: Record<string, unknown>,
	mappings: Map<string, ChatToolMapping>,
	usedNames: Set<string>,
): Array<Record<string, unknown>> {
	const tools: Array<Record<string, unknown>> = [];
	const visit = (tool: unknown, namespace?: string): void => {
		if (!isRecord(tool)) {
			return;
		}
		const type = typeof tool.type === "string" ? tool.type : "";
		if (type === "namespace") {
			const childNamespace = typeof tool.name === "string" ? tool.name : namespace;
			const children = Array.isArray(tool.tools) ? tool.tools : [];
			for (const child of children) {
				visit(child, childNamespace);
			}
			return;
		}
		if (type === "custom") {
			const name = typeof tool.name === "string" ? tool.name.trim() : "";
			if (!name) {
				return;
			}
			const chatName = allocateChatName(name, namespace, usedNames);
			mappings.set(chatName, { chatName, responseName: name, namespace, custom: true });
			tools.push({
				type: "function",
				function: {
					name: chatName,
					description: customToolDescription(tool),
					parameters: {
						type: "object",
						properties: {
							input: { type: "string", description: "Raw input for the custom tool." },
						},
						required: ["input"],
						additionalProperties: false,
					},
				},
			});
			return;
		}
		if (type !== "function" && type !== "tool_search") {
			return;
		}
		const name =
			typeof tool.name === "string"
				? tool.name.trim()
				: isRecord(tool.function) && typeof tool.function.name === "string"
					? tool.function.name.trim()
					: type === "tool_search"
						? "tool_search"
						: "";
		if (!name) {
			return;
		}
		const chatName = allocateChatName(name, namespace, usedNames);
		mappings.set(chatName, { chatName, responseName: name, namespace, custom: false });
		const source = isRecord(tool.function) ? tool.function : tool;
		tools.push({
			type: "function",
			function: {
				name: chatName,
				description: typeof source.description === "string" ? source.description : "",
				parameters: isRecord(source.parameters)
					? source.parameters
					: { type: "object", properties: {} },
			},
		});
	};

	if (Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			visit(tool);
		}
	}
	if (Array.isArray(body.input)) {
		for (const item of body.input) {
			if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
				for (const tool of item.tools) {
					visit(tool);
				}
			}
		}
	}
	return tools;
}

function appendResponsesInput(
	messages: Array<Record<string, unknown>>,
	input: unknown,
	mappings: Map<string, ChatToolMapping>,
	usedNames: Set<string>,
): void {
	if (typeof input === "string") {
		messages.push({ role: "user", content: input });
		return;
	}
	if (!Array.isArray(input)) {
		return;
	}

	const pendingToolCalls: Array<Record<string, unknown>> = [];
	let pendingReasoning = "";
	const flushToolCalls = (): void => {
		if (pendingToolCalls.length === 0) {
			return;
		}
		const message: Record<string, unknown> = {
			role: "assistant",
			content: null,
			tool_calls: pendingToolCalls.splice(0),
		};
		if (pendingReasoning) {
			message.reasoning_content = pendingReasoning;
			pendingReasoning = "";
		}
		messages.push(message);
	};

	for (const item of input) {
		if (!isRecord(item)) {
			continue;
		}
		const type = typeof item.type === "string" ? item.type : "";
		if (type === "reasoning") {
			const reasoning = reasoningInputText(item);
			if (reasoning) {
				pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${reasoning}` : reasoning;
			}
			continue;
		}
		if (type === "message") {
			flushToolCalls();
			const role = item.role === "developer" ? "system" : String(item.role ?? "user");
			const message: Record<string, unknown> = {
				role,
				content: convertMessageContent(item.content),
			};
			if (role === "assistant" && pendingReasoning) {
				message.reasoning_content = pendingReasoning;
				pendingReasoning = "";
			}
			messages.push(message);
			continue;
		}
		if (type === "function_call" || type === "custom_tool_call") {
			const responseName = typeof item.name === "string" ? item.name : "tool";
			const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
			const chatName =
				chatNameForResponseCall(responseName, namespace, mappings) ??
				allocateChatName(responseName, namespace, usedNames);
			const custom = type === "custom_tool_call";
			if (!mappings.has(chatName)) {
				mappings.set(chatName, { chatName, responseName, namespace, custom });
			}
			const callId =
				typeof item.call_id === "string" && item.call_id ? item.call_id : `call_${randomUUID()}`;
			pendingToolCalls.push({
				id: callId,
				type: "function",
				function: {
					name: chatName,
					arguments: custom
						? JSON.stringify({ input: typeof item.input === "string" ? item.input : "" })
						: typeof item.arguments === "string"
							? item.arguments
							: "{}",
				},
			});
			continue;
		}
		if (type === "function_call_output" || type === "custom_tool_call_output") {
			flushToolCalls();
			const callId =
				typeof item.call_id === "string" && item.call_id ? item.call_id : `call_${randomUUID()}`;
			messages.push({
				role: "tool",
				tool_call_id: callId,
				content: stringifyToolOutput(item.output ?? item.result),
			});
		}
	}
	flushToolCalls();
}

function reasoningInputText(item: Record<string, unknown>): string {
	const fromContent = reasoningPartsText(item.content);
	if (fromContent) {
		return fromContent;
	}
	return reasoningPartsText(item.summary);
}

function reasoningPartsText(value: unknown): string {
	if (typeof value === "string") {
		return value.trim();
	}
	if (!Array.isArray(value)) {
		return "";
	}
	return value
		.map((part) => {
			if (typeof part === "string") {
				return part;
			}
			if (isRecord(part) && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter((text) => text.trim().length > 0)
		.join("\n\n");
}

function convertMessageContent(content: unknown): string | Array<Record<string, unknown>> {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: Array<Record<string, unknown>> = [];
	for (const part of content) {
		if (!isRecord(part)) {
			continue;
		}
		const type = typeof part.type === "string" ? part.type : "";
		if (type === "input_text" || type === "output_text" || type === "summary_text") {
			parts.push({ type: "text", text: typeof part.text === "string" ? part.text : "" });
			continue;
		}
		if (type === "input_image" || type === "image_url") {
			const url = imageUrlFromPart(part);
			if (url) {
				parts.push({
					type: "image_url",
					image_url: {
						url,
						...(typeof part.detail === "string" ? { detail: part.detail } : {}),
					},
				});
			}
		}
	}
	if (parts.every((part) => part.type === "text")) {
		return parts.map((part) => String(part.text ?? "")).join("");
	}
	return parts;
}

function imageUrlFromPart(part: Record<string, unknown>): string | undefined {
	if (typeof part.image_url === "string") {
		return part.image_url;
	}
	if (isRecord(part.image_url) && typeof part.image_url.url === "string") {
		return part.image_url.url;
	}
	if (typeof part.url === "string") {
		return part.url;
	}
	if (typeof part.data === "string") {
		const mediaType = typeof part.media_type === "string" ? part.media_type : "image/png";
		return `data:${mediaType};base64,${part.data}`;
	}
	return undefined;
}

function stringifyToolOutput(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		const text = value
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}
				if (isRecord(part) && typeof part.text === "string") {
					return part.text;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
		return text || JSON.stringify(value);
	}
	if (value === undefined) {
		return "";
	}
	return JSON.stringify(value);
}

function convertToolChoice(
	choice: unknown,
	mappings: Map<string, ChatToolMapping>,
): unknown {
	if (choice === "auto" || choice === "none" || choice === "required") {
		return choice;
	}
	if (!isRecord(choice)) {
		return "auto";
	}
	const name = typeof choice.name === "string" ? choice.name : "";
	const namespace = typeof choice.namespace === "string" ? choice.namespace : undefined;
	const chatName = name ? chatNameForResponseCall(name, namespace, mappings) : undefined;
	if (chatName) {
		return { type: "function", function: { name: chatName } };
	}
	return "auto";
}

function chatNameForResponseCall(
	name: string,
	namespace: string | undefined,
	mappings: Map<string, ChatToolMapping>,
): string | undefined {
	for (const mapping of mappings.values()) {
		if (mapping.responseName === name && mapping.namespace === namespace) {
			return mapping.chatName;
		}
	}
	return undefined;
}

function allocateChatName(name: string, namespace: string | undefined, used: Set<string>): string {
	const source = [namespace, name].filter(Boolean).join("__");
	const base = sanitizeToolName(source) || "tool";
	let candidate = base.slice(0, 64);
	let suffix = 2;
	while (used.has(candidate)) {
		const marker = `_${suffix++}`;
		candidate = `${base.slice(0, Math.max(1, 64 - marker.length))}${marker}`;
	}
	used.add(candidate);
	return candidate;
}

function sanitizeToolName(name: string): string {
	return name.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
}

function customToolDescription(tool: Record<string, unknown>): string {
	const description = typeof tool.description === "string" ? tool.description.trim() : "";
	if (description) {
		return description;
	}
	return "Free-form custom tool. Put the complete raw tool input in the `input` string.";
}

function chatJsonToResponses(
	payload: Record<string, unknown>,
	model: string,
	mappings: Map<string, ChatToolMapping>,
): Record<string, unknown> {
	const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0])
		? (payload.choices[0] as Record<string, unknown>)
		: {};
	const message = isRecord(choice.message) ? choice.message : {};
	const output: Array<Record<string, unknown>> = [];

	const rawContent = typeof message.content === "string" ? message.content : "";
	const inlineThinking = splitInlineThinking(rawContent);
	const reasoning = [extractReasoningText(message), inlineThinking.reasoning]
		.filter((text): text is string => Boolean(text && text.trim()))
		.join("\n\n");
	if (reasoning) {
		output.push({
			id: `rs_${randomUUID()}`,
			type: "reasoning",
			summary: [{ type: "summary_text", text: reasoning }],
		});
	}
	if (inlineThinking.text) {
		output.push({
			id: `msg_${randomUUID()}`,
			type: "message",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: inlineThinking.text, annotations: [] }],
		});
	}
	if (Array.isArray(message.tool_calls)) {
		for (const toolCall of message.tool_calls) {
			if (!isRecord(toolCall)) {
				continue;
			}
			const fn = isRecord(toolCall.function) ? toolCall.function : {};
			const chatName = typeof fn.name === "string" ? fn.name : "";
			const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
			output.push(responseToolItem(toolCall, chatName, args, mappings));
		}
	}

	const response = baseResponse(model, "completed", output);
	response.id = responseIdFromChat(payload);
	response.usage = chatUsageToResponsesUsage(payload.usage);
	return response;
}

class ChatSseToResponsesWriter {
	private readonly output: Array<Record<string, unknown>> = [];
	private readonly tools = new Map<number, ToolState>();
	private readonly usage: Record<string, unknown> = chatUsageToResponsesUsage(undefined);
	private nextOutputIndex = 0;
	private message?: OutputTextState;
	private reasoning?: ReasoningState;
	private finishReason?: string;
	private completed = false;
	private inlineThinkOpen = false;
	private inlineThinkBuffer = "";

	constructor(
		private readonly res: http.ServerResponse,
		private readonly mappings: Map<string, ChatToolMapping>,
		private model = "",
	) {}

	start(): void {
		const response = this.baseResponse("in_progress", []);
		this.send("response.created", { response });
		this.send("response.in_progress", { response });
	}

	push(chunk: Record<string, unknown>): void {
		if (typeof chunk.model === "string" && chunk.model) {
			this.model = chunk.model;
		}
		if (isRecord(chunk.usage)) {
			Object.assign(this.usage, chatUsageToResponsesUsage(chunk.usage));
		}
		const choice =
			Array.isArray(chunk.choices) && isRecord(chunk.choices[0])
				? (chunk.choices[0] as Record<string, unknown>)
				: undefined;
		if (!choice) {
			return;
		}
		if (typeof choice.finish_reason === "string") {
			this.finishReason = choice.finish_reason;
		}
		const delta = isRecord(choice.delta) ? choice.delta : {};
		const reasoning = extractReasoningText(delta);
		if (reasoning) {
			this.pushReasoning(reasoning);
		}
		if (typeof delta.content === "string" && delta.content) {
			this.pushInlineThinkingContent(delta.content);
		}
		if (Array.isArray(delta.tool_calls)) {
			this.flushInlineThinking();
			for (const toolCall of delta.tool_calls) {
				if (isRecord(toolCall)) {
					this.pushToolCall(toolCall);
				}
			}
		}
	}

	finish(): void {
		if (this.completed) {
			return;
		}
		this.flushInlineThinking();
		this.closeReasoning();
		this.closeMessage();
		this.finishTools();
		const status = this.finishReason === "length" ? "incomplete" : "completed";
		const response = this.baseResponse(status, this.output);
		response.usage = this.usage;
		if (status === "incomplete") {
			response.incomplete_details = { reason: "max_output_tokens" };
		}
		this.send(status === "incomplete" ? "response.incomplete" : "response.completed", { response });
		this.completed = true;
		this.res.end();
	}

	fail(message: string): void {
		if (this.completed || this.res.writableEnded || this.res.destroyed) {
			return;
		}
		this.flushInlineThinking();
		this.closeReasoning();
		this.closeMessage();
		this.finishTools(false);
		const response = this.baseResponse("failed", this.output);
		response.error = { code: "proxy_upstream_error", message };
		this.send("response.failed", { response });
		this.completed = true;
		this.res.end();
	}

	private pushReasoning(delta: string): void {
		if (!this.reasoning) {
			const itemId = `rs_${randomUUID()}`;
			const outputIndex = this.nextOutputIndex++;
			this.reasoning = { itemId, outputIndex, text: "", closed: false };
			this.send("response.output_item.added", {
				output_index: outputIndex,
				item: { id: itemId, type: "reasoning", status: "in_progress", summary: [] },
			});
			this.send("response.reasoning_summary_part.added", {
				item_id: itemId,
				output_index: outputIndex,
				summary_index: 0,
				part: { type: "summary_text", text: "" },
			});
		}
		this.reasoning.text += delta;
		this.send("response.reasoning_summary_text.delta", {
			item_id: this.reasoning.itemId,
			output_index: this.reasoning.outputIndex,
			summary_index: 0,
			delta,
		});
	}

	private pushInlineThinkingContent(content: string): void {
		let text = this.inlineThinkBuffer + content;
		this.inlineThinkBuffer = "";
		while (text) {
			if (this.inlineThinkOpen) {
				const end = text.indexOf(INLINE_THINK_CLOSE);
				if (end >= 0) {
					const reasoning = text.slice(0, end);
					if (reasoning) {
						this.pushReasoning(reasoning);
					}
					this.inlineThinkOpen = false;
					text = text.slice(end + INLINE_THINK_CLOSE.length);
					continue;
				}
				const keep = partialTagSuffix(text, INLINE_THINK_CLOSE);
				const reasoning = keep > 0 ? text.slice(0, -keep) : text;
				if (reasoning) {
					this.pushReasoning(reasoning);
				}
				this.inlineThinkBuffer = keep > 0 ? text.slice(-keep) : "";
				return;
			}

			const open = text.indexOf(INLINE_THINK_OPEN);
			const orphanClose = text.indexOf(INLINE_THINK_CLOSE);
			if (orphanClose >= 0 && (open < 0 || orphanClose < open)) {
				const visible = text.slice(0, orphanClose);
				if (visible) {
					this.pushText(visible);
				}
				text = text.slice(orphanClose + INLINE_THINK_CLOSE.length);
				continue;
			}
			if (open >= 0) {
				const visible = text.slice(0, open);
				if (visible) {
					this.pushText(visible);
				}
				this.inlineThinkOpen = true;
				text = text.slice(open + INLINE_THINK_OPEN.length);
				continue;
			}
			const keep = Math.max(
				partialTagSuffix(text, INLINE_THINK_OPEN),
				partialTagSuffix(text, INLINE_THINK_CLOSE),
			);
			const visible = keep > 0 ? text.slice(0, -keep) : text;
			if (visible) {
				this.pushText(visible);
			}
			this.inlineThinkBuffer = keep > 0 ? text.slice(-keep) : "";
			return;
		}
	}

	private flushInlineThinking(): void {
		const pending = this.inlineThinkBuffer;
		this.inlineThinkBuffer = "";
		if (!pending) {
			return;
		}
		if (this.inlineThinkOpen) {
			this.pushReasoning(pending);
		} else {
			this.pushText(pending);
		}
	}

	private closeReasoning(): void {
		if (!this.reasoning || this.reasoning.closed) {
			return;
		}
		const state = this.reasoning;
		state.closed = true;
		const item = {
			id: state.itemId,
			type: "reasoning",
			summary: [{ type: "summary_text", text: state.text }],
		};
		this.send("response.reasoning_summary_text.done", {
			item_id: state.itemId,
			output_index: state.outputIndex,
			summary_index: 0,
			text: state.text,
		});
		this.send("response.reasoning_summary_part.done", {
			item_id: state.itemId,
			output_index: state.outputIndex,
			summary_index: 0,
			part: { type: "summary_text", text: state.text },
		});
		this.send("response.output_item.done", { output_index: state.outputIndex, item });
		this.output.push(item);
	}

	private pushText(delta: string): void {
		this.closeReasoning();
		if (!this.message) {
			const itemId = `msg_${randomUUID()}`;
			const outputIndex = this.nextOutputIndex++;
			this.message = { itemId, outputIndex, text: "", closed: false };
			this.send("response.output_item.added", {
				output_index: outputIndex,
				item: {
					id: itemId,
					type: "message",
					status: "in_progress",
					role: "assistant",
					content: [],
				},
			});
			this.send("response.content_part.added", {
				item_id: itemId,
				output_index: outputIndex,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			});
		}
		this.message.text += delta;
		this.send("response.output_text.delta", {
			item_id: this.message.itemId,
			output_index: this.message.outputIndex,
			content_index: 0,
			delta,
		});
	}

	private closeMessage(): void {
		if (!this.message || this.message.closed) {
			return;
		}
		const state = this.message;
		state.closed = true;
		const item = {
			id: state.itemId,
			type: "message",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: state.text, annotations: [] }],
		};
		this.send("response.output_text.done", {
			item_id: state.itemId,
			output_index: state.outputIndex,
			content_index: 0,
			text: state.text,
		});
		this.send("response.content_part.done", {
			item_id: state.itemId,
			output_index: state.outputIndex,
			content_index: 0,
			part: { type: "output_text", text: state.text, annotations: [] },
		});
		this.send("response.output_item.done", { output_index: state.outputIndex, item });
		this.output.push(item);
	}

	private pushToolCall(toolCall: Record<string, unknown>): void {
		const index = typeof toolCall.index === "number" ? toolCall.index : this.tools.size;
		let state = this.tools.get(index);
		if (!state) {
			state = {
				index,
				itemId: `fc_${randomUUID()}`,
				callId: "",
				chatName: "",
				arguments: "",
				added: false,
			};
			this.tools.set(index, state);
		}
		if (typeof toolCall.id === "string" && toolCall.id) {
			state.callId = toolCall.id;
		}
		const fn = isRecord(toolCall.function) ? toolCall.function : {};
		if (typeof fn.name === "string" && fn.name) {
			state.chatName = fn.name;
		}
		const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
		this.ensureToolAdded(state);
		if (argumentsDelta && !this.isCustomTool(state)) {
			state.arguments += argumentsDelta;
			this.send("response.function_call_arguments.delta", {
				item_id: state.itemId,
				output_index: state.outputIndex ?? 0,
				delta: argumentsDelta,
			});
		} else if (argumentsDelta) {
			state.arguments += argumentsDelta;
		}
	}

	private ensureToolAdded(state: ToolState): void {
		if (state.added || !state.chatName) {
			return;
		}
		this.closeReasoning();
		this.closeMessage();
		state.mapping = this.mappings.get(state.chatName);
		state.callId ||= `call_${randomUUID()}`;
		state.outputIndex = this.nextOutputIndex++;
		state.added = true;
		this.send("response.output_item.added", {
			output_index: state.outputIndex,
			item: this.toolItem(state, "in_progress"),
		});
	}

	private finishTools(success = true): void {
		for (const state of [...this.tools.values()].sort((a, b) => a.index - b.index)) {
			this.ensureToolAdded(state);
			if (!state.added) {
				continue;
			}
			const custom = this.isCustomTool(state);
			const outputIndex = state.outputIndex ?? 0;
			if (custom) {
				const input = customInputFromArguments(state.arguments);
				if (input) {
					this.send("response.custom_tool_call_input.delta", {
						item_id: state.itemId,
						output_index: outputIndex,
						delta: input,
					});
				}
				this.send("response.custom_tool_call_input.done", {
					item_id: state.itemId,
					output_index: outputIndex,
					input,
				});
			} else {
				this.send("response.function_call_arguments.done", {
					item_id: state.itemId,
					output_index: outputIndex,
					arguments: state.arguments,
				});
			}
			const item = this.toolItem(state, success ? "completed" : "incomplete");
			this.send("response.output_item.done", { output_index: outputIndex, item });
			this.output.push(item);
		}
	}

	private toolItem(state: ToolState, status: string): Record<string, unknown> {
		const mapping = state.mapping;
		const custom = this.isCustomTool(state);
		const item: Record<string, unknown> = {
			id: state.itemId,
			type: custom ? "custom_tool_call" : "function_call",
			status,
			call_id: state.callId,
			name: mapping?.responseName ?? state.chatName,
		};
		if (mapping?.namespace) {
			item.namespace = mapping.namespace;
		}
		if (custom) {
			item.input = customInputFromArguments(state.arguments);
		} else {
			item.arguments = state.arguments;
		}
		return item;
	}

	private isCustomTool(state: ToolState): boolean {
		return this.mappings.get(state.chatName)?.custom === true;
	}

	private send(event: string, data: Record<string, unknown>): void {
		if (this.res.writableEnded) {
			return;
		}
		this.res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	}

	private baseResponse(status: string, output: Array<Record<string, unknown>>): Record<string, unknown> {
		return baseResponse(this.model, status, output, this.usage);
	}
}

async function pipeChatSse(
	upstream: Response,
	writer: ChatSseToResponsesWriter,
): Promise<void> {
	if (!upstream.body) {
		throw new Error("Upstream returned an empty stream");
	}
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		buffer = buffer.replace(/\r\n/g, "\n");
		let boundary = buffer.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			handleSseBlock(block, writer);
			boundary = buffer.indexOf("\n\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) {
		handleSseBlock(buffer, writer);
	}
}

function handleSseBlock(block: string, writer: ChatSseToResponsesWriter): void {
	const data = block
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data || data === "[DONE]") {
		return;
	}
	try {
		const payload = JSON.parse(data) as Record<string, unknown>;
		if (isRecord(payload.error)) {
			throw new Error(
				typeof payload.error.message === "string" ? payload.error.message : JSON.stringify(payload.error),
			);
		}
		writer.push(payload);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return;
		}
		throw error;
	}
}

function responseToolItem(
	toolCall: Record<string, unknown>,
	chatName: string,
	argumentsText: string,
	mappings: Map<string, ChatToolMapping>,
): Record<string, unknown> {
	const mapping = mappings.get(chatName);
	const custom = mapping?.custom === true;
	const item: Record<string, unknown> = {
		id: `fc_${randomUUID()}`,
		type: custom ? "custom_tool_call" : "function_call",
		status: "completed",
		call_id: typeof toolCall.id === "string" ? toolCall.id : `call_${randomUUID()}`,
		name: mapping?.responseName ?? chatName,
	};
	if (mapping?.namespace) {
		item.namespace = mapping.namespace;
	}
	if (custom) {
		item.input = customInputFromArguments(argumentsText);
	} else {
		item.arguments = argumentsText;
	}
	return item;
}

function customInputFromArguments(argumentsText: string): string {
	if (!argumentsText) {
		return "";
	}
	try {
		const parsed = JSON.parse(argumentsText);
		if (isRecord(parsed) && typeof parsed.input === "string") {
			return parsed.input;
		}
	} catch {
		// Some gateways return the raw custom input without JSON wrapping.
	}
	return argumentsText;
}

function extractReasoningText(value: Record<string, unknown> | undefined): string | undefined {
	if (!value) {
		return undefined;
	}
	for (const key of ["reasoning_content", "reasoning"]) {
		const raw = value[key];
		if (typeof raw === "string" && raw) {
			return raw;
		}
		if (isRecord(raw)) {
			for (const nested of ["content", "text", "summary"]) {
				if (typeof raw[nested] === "string" && raw[nested]) {
					return raw[nested] as string;
				}
			}
		}
	}
	const details = value.reasoning_details;
	if (typeof details === "string" && details) {
		return details;
	}
	if (Array.isArray(details)) {
		const text = details
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}
				if (isRecord(part)) {
					return typeof part.text === "string" ? part.text : "";
				}
				return "";
			})
			.filter(Boolean)
			.join("\n\n");
		return text || undefined;
	}
	return undefined;
}

function chatUsageToResponsesUsage(raw: unknown): Record<string, unknown> {
	const usage = isRecord(raw) ? raw : {};
	const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
	const completionDetails = isRecord(usage.completion_tokens_details)
		? usage.completion_tokens_details
		: {};
	const inputTokens = numberValue(usage.prompt_tokens ?? usage.input_tokens);
	const outputTokens = numberValue(usage.completion_tokens ?? usage.output_tokens);
	return {
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: numberValue(usage.total_tokens) || inputTokens + outputTokens,
		input_tokens_details: {
			cached_tokens: numberValue(details.cached_tokens),
		},
		output_tokens_details: {
			reasoning_tokens: numberValue(completionDetails.reasoning_tokens),
		},
	};
}

function splitInlineThinking(text: string): { text: string; reasoning: string } {
	let visible = "";
	let reasoning = "";
	let remaining = text;
	let insideThinking = false;
	while (remaining) {
		if (insideThinking) {
			const end = remaining.indexOf(INLINE_THINK_CLOSE);
			if (end >= 0) {
				reasoning += remaining.slice(0, end);
				remaining = remaining.slice(end + INLINE_THINK_CLOSE.length);
				insideThinking = false;
				continue;
			}
			reasoning += remaining;
			break;
		}
		const open = remaining.indexOf(INLINE_THINK_OPEN);
		const orphanClose = remaining.indexOf(INLINE_THINK_CLOSE);
		if (orphanClose >= 0 && (open < 0 || orphanClose < open)) {
			visible += remaining.slice(0, orphanClose);
			remaining = remaining.slice(orphanClose + INLINE_THINK_CLOSE.length);
			continue;
		}
		if (open >= 0) {
			visible += remaining.slice(0, open);
			remaining = remaining.slice(open + INLINE_THINK_OPEN.length);
			insideThinking = true;
			continue;
		}
		visible += remaining;
		break;
	}
	return { text: visible.trim(), reasoning: reasoning.trim() };
}

function partialTagSuffix(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let length = max; length > 0; length--) {
		if (tag.startsWith(text.slice(-length))) {
			return length;
		}
	}
	return 0;
}

function baseResponse(
	model: string,
	status: string,
	output: Array<Record<string, unknown>>,
	usage?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		id: `resp_${randomUUID()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status,
		model,
		output,
		usage: usage ?? null,
	};
}

function responseIdFromChat(payload: Record<string, unknown>): string {
	if (typeof payload.id === "string" && payload.id) {
		return payload.id.startsWith("resp_") ? payload.id : `resp_${payload.id}`;
	}
	return `resp_${randomUUID()}`;
}

function buildUpstreamHeaders(
	headers: http.IncomingHttpHeaders,
	apiKey: string,
	stream: boolean,
): Record<string, string> {
	const result: Record<string, string> = {
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
		accept: stream ? "text/event-stream" : "application/json",
		"user-agent": USER_AGENT,
	};
	const passthrough = [
		"openai-beta",
		"x-request-id",
		"x-client-request-id",
		"session-id",
		"thread-id",
		"originator",
	];
	for (const name of passthrough) {
		const value = headerValue(headers[name]);
		if (value) {
			result[name] = value;
		}
	}
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (!(lower.startsWith("x-codex-") || lower.startsWith("x-opencode-")) || !value) {
			continue;
		}
		const text = headerValue(value);
		if (text) {
			result[lower] = text;
		}
	}
	return result;
}

function copyResponseHeaders(upstream: Response, res: http.ServerResponse): void {
	for (const name of ["content-type", "cache-control", "x-request-id"]) {
		const value = upstream.headers.get(name);
		if (value) {
			res.setHeader(name, value);
		}
	}
}

async function relayUpstreamError(res: http.ServerResponse, upstream: Response): Promise<void> {
	const text = await upstream.text();
	res.statusCode = upstream.status;
	res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
	res.end(
		text ||
			JSON.stringify({
				error: { message: `Upstream returned HTTP ${upstream.status}`, code: upstream.status },
			}),
	);
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) {
			throw new Error("Request body is too large");
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

function isAuthorized(incoming: string | undefined, configured: string | undefined): boolean {
	if (!incoming) {
		return false;
	}
	if (incoming === PROXY_MANAGED_PLACEHOLDER) {
		return Boolean(configured);
	}
	return Boolean(configured && incoming === configured);
}

function bearerToken(value: string | undefined): string | undefined {
	const match = value?.match(/^Bearer\s+(.+)$/i);
	return match?.[1]?.trim() || undefined;
}

function isLoopbackRequest(req: http.IncomingMessage): boolean {
	const address = req.socket.remoteAddress;
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function joinUrl(baseUrl: string, endpoint: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function copyNumber(
	source: Record<string, unknown>,
	target: Record<string, unknown>,
	key: string,
): void {
	if (typeof source[key] === "number") {
		target[key] = source[key];
	}
}

function writeError(res: http.ServerResponse, error: unknown): void {
	if (res.writableEnded || res.destroyed) {
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (res.headersSent) {
		res.write(`event: response.failed\ndata: ${JSON.stringify({
			type: "response.failed",
			response: { status: "failed", error: { code: "proxy_error", message } },
		})}\n\n`);
		res.end();
		return;
	}
	res.writeHead(500, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: { message } }));
}
