import { randomUUID } from "crypto";
import * as http from "http";
import { USER_AGENT } from "../utils";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_THINKING_PREFIX_V1 = "codexgo-anthropic-thinking-v1:";
const ANTHROPIC_THINKING_PREFIX_V2 = "codexgo-anthropic-thinking-v2:";
const DEFAULT_MAX_TOKENS = 8192;
const CLAUDE_HAIKU_5_5_MAX_TOKENS = 128_000;
const CONTINUE_PROMPT = "Continue.";

export interface AnthropicProxyOptions {
	upstreamBaseUrl: string;
	log?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface AnthropicProxyContext {
	body: Record<string, unknown>;
	apiKey: string;
}

export interface AnthropicToolMapping {
	providerName: string;
	responseName: string;
	namespace?: string;
	custom: boolean;
}

export interface AnthropicTransformResult {
	body: Record<string, unknown>;
	toolMappings: Map<string, AnthropicToolMapping>;
}

interface AnthropicBlockState {
	kind: "text" | "tool" | "thinking";
	outputIndex: number;
	itemId: string;
	text: string;
	callId: string;
	providerName: string;
	mapping?: AnthropicToolMapping;
	sourceBlock: Record<string, unknown>;
	startInput: string;
	visibleSummary: boolean;
	closed: boolean;
}

interface AnthropicThinkingConfig {
	thinking: Record<string, unknown>;
	outputConfig?: Record<string, unknown>;
}

export async function proxyAnthropicMessages(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: AnthropicProxyOptions,
	context: AnthropicProxyContext,
): Promise<void> {
	const transformed = responsesToAnthropicRequest(context.body);
	const stream = transformed.body.stream !== false;
	transformed.body.stream = stream;
	options.log?.("messages.request", {
		model: typeof context.body.model === "string" ? context.body.model : undefined,
		max_tokens: transformed.body.max_tokens,
		stream,
		thinking: isRecord(transformed.body.thinking)
			? transformed.body.thinking.type
			: undefined,
	});

	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) {
			controller.abort();
		}
	});

	const upstream = await fetch(joinUrl(options.upstreamBaseUrl, "messages"), {
		method: "POST",
		headers: buildAnthropicHeaders(
			req.headers,
			context.apiKey,
			stream,
			isAdaptiveThinking(transformed.body.thinking)
				? ["thinking-binding-controls-2026-08-01"]
				: [],
		),
		body: JSON.stringify(transformed.body),
		signal: controller.signal,
	});

	if (!upstream.ok) {
		await relayUpstreamError(res, upstream);
		return;
	}

	const contentType = upstream.headers.get("content-type") ?? "";
	if (!stream || contentType.includes("application/json")) {
		const payload = (await upstream.json()) as Record<string, unknown>;
		const response = anthropicJsonToResponses(
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

	const writer = new AnthropicSseToResponsesWriter(
		res,
		transformed.toolMappings,
		typeof context.body.model === "string" ? context.body.model : "",
	);
	writer.start();
	try {
		await pipeAnthropicSse(upstream, writer);
		writer.finish();
	} catch (error) {
		options.log?.("messages.stream.failed", {
			model: typeof context.body.model === "string" ? context.body.model : undefined,
			error: error instanceof Error ? error.message : String(error),
		});
		writer.fail(error instanceof Error ? error.message : String(error));
	}
}

export function responsesToAnthropicRequest(
	body: Record<string, unknown>,
): AnthropicTransformResult {
	const usedNames = new Set<string>();
	const toolMappings = new Map<string, AnthropicToolMapping>();
	const tools = collectAnthropicTools(body, toolMappings, usedNames);
	const systemParts: string[] = [];
	const messages: Array<Record<string, unknown>> = [];

	if (typeof body.instructions === "string" && body.instructions.trim()) {
		systemParts.push(body.instructions.trim());
	}

	appendResponsesInput(
		messages,
		body.input,
		toolMappings,
		usedNames,
		systemParts,
		typeof body.model === "string" ? body.model : "",
	);
	normalizeMessages(messages);

	if (messages.length === 0) {
		throw new Error("Cannot convert Codex request to Anthropic Messages: empty messages");
	}

	const request: Record<string, unknown> = {
		model: body.model,
		messages,
		stream: body.stream !== false,
	};
	if (systemParts.length > 0) {
		request.system = systemParts.join("\n\n");
	}

	const maxTokens =
		positiveNumber(body.max_output_tokens) ??
		defaultMaxTokensForModel(typeof body.model === "string" ? body.model : "");
	request.max_tokens = maxTokens;

	const thinking = buildThinkingConfig(
		body,
		maxTokens,
		tools.length > 0,
		body.tool_choice,
		typeof body.model === "string" ? body.model : "",
	);
	if (thinking) {
		request.thinking = thinking.thinking;
		if (thinking.outputConfig) {
			request.output_config = thinking.outputConfig;
		}
	} else {
		copyNumber(body, request, "temperature");
		copyNumber(body, request, "top_p");
	}

	if (tools.length > 0) {
		request.tools = tools;
		const toolChoice = convertToolChoice(body.tool_choice, toolMappings);
		if (toolChoice !== undefined) {
			request.tool_choice = toolChoice;
		}
		if (body.parallel_tool_calls === false) {
			if (!isRecord(request.tool_choice)) {
				request.tool_choice = { type: "auto" };
			}
			(request.tool_choice as Record<string, unknown>).disable_parallel_tool_use = true;
		}
	}

	if (Array.isArray(body.stop)) {
		request.stop_sequences = body.stop.filter((value): value is string => typeof value === "string");
	} else if (typeof body.stop === "string" && body.stop) {
		request.stop_sequences = [body.stop];
	}

	return { body: request, toolMappings };
}

export function encodeAnthropicThinkingBlock(
	block: Record<string, unknown>,
	model?: string,
): string | undefined {
	const type = typeof block.type === "string" ? block.type : "";
	if (type === "thinking") {
		if (typeof block.signature !== "string" || !block.signature) {
			return undefined;
		}
	} else if (type === "redacted_thinking") {
		if (typeof block.data !== "string" || !block.data) {
			return undefined;
		}
	} else {
		return undefined;
	}
	const payload = {
		model: model ?? "",
		block,
	};
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${ANTHROPIC_THINKING_PREFIX_V2}${encoded}`;
}

export function decodeAnthropicThinkingBlock(
	encryptedContent: string,
): Record<string, unknown> | undefined {
	return decodeAnthropicThinkingEnvelope(encryptedContent)?.block;
}

function decodeAnthropicThinkingEnvelope(
	encryptedContent: string,
): { model?: string; block: Record<string, unknown> } | undefined {
	try {
		let encoded: string;
		if (encryptedContent.startsWith(ANTHROPIC_THINKING_PREFIX_V2)) {
			encoded = encryptedContent.slice(ANTHROPIC_THINKING_PREFIX_V2.length);
		} else if (encryptedContent.startsWith(ANTHROPIC_THINKING_PREFIX_V1)) {
			encoded = encryptedContent.slice(ANTHROPIC_THINKING_PREFIX_V1.length);
		} else {
			return undefined;
		}
		const decoded = Buffer.from(encoded, "base64url").toString("utf8");
		const parsed = JSON.parse(decoded) as unknown;
		if (!isRecord(parsed)) {
			return undefined;
		}
		if (isRecord(parsed.block) && typeof parsed.model === "string") {
			return encodeAnthropicThinkingBlock(parsed.block, parsed.model)
				? { model: parsed.model || undefined, block: parsed.block }
				: undefined;
		}
		return encodeAnthropicThinkingBlock(parsed) ? { block: parsed } : undefined;
	} catch {
		return undefined;
	}
}

function collectAnthropicTools(
	body: Record<string, unknown>,
	mappings: Map<string, AnthropicToolMapping>,
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

		const custom = type === "custom";
		const source = isRecord(tool.function) ? tool.function : tool;
		const responseName =
			typeof source.name === "string"
				? source.name.trim()
				: type === "tool_search"
					? "tool_search"
					: "";
		if (!responseName || (type !== "function" && type !== "custom" && type !== "tool_search")) {
			return;
		}

		const effectiveNamespace =
			typeof tool.namespace === "string" ? tool.namespace : namespace;
		const providerName = allocateToolName(responseName, effectiveNamespace, usedNames);
		mappings.set(providerName, {
			providerName,
			responseName,
			namespace: effectiveNamespace,
			custom,
		});
		tools.push({
			name: providerName,
			description:
				typeof source.description === "string"
					? source.description
					: custom
						? "Free-form custom tool. Put the complete raw tool input in the `input` string."
						: "",
			input_schema: custom
				? {
						type: "object",
						properties: {
							input: { type: "string", description: "Raw input for the custom tool." },
						},
						required: ["input"],
						additionalProperties: false,
					}
				: isRecord(source.parameters)
					? source.parameters
					: { type: "object", properties: {} },
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
	mappings: Map<string, AnthropicToolMapping>,
	usedNames: Set<string>,
	systemParts: string[],
	currentModel: string,
): void {
	if (typeof input === "string") {
		if (input.trim()) {
			pushBlock(messages, "user", { type: "text", text: input });
		}
		return;
	}
	if (!Array.isArray(input)) {
		return;
	}

	const modelSwitchIndex = input.findIndex(isModelSwitchItem);
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		if (!isRecord(item)) {
			continue;
		}
		const type = typeof item.type === "string" ? item.type : "";
		if (type === "additional_tools") {
			continue;
		}
		if (type === "compaction_trigger") {
			throw new Error(
				"Anthropic Messages remote compaction is not supported by this proxy",
			);
		}
		if (type === "reasoning") {
			const encrypted =
				typeof item.encrypted_content === "string" ? item.encrypted_content : "";
			const envelope = decodeAnthropicThinkingEnvelope(encrypted);
			const allowLegacy =
				modelSwitchIndex < 0 || index > modelSwitchIndex;
			const thinkingBlock =
				envelope &&
				(envelope.model
					? !currentModel || envelope.model === currentModel
					: allowLegacy && !usesAdaptiveThinking(currentModel))
					? envelope.block
					: undefined;
			if (thinkingBlock) {
				pushBlock(messages, "assistant", thinkingBlock);
			}
			continue;
		}
		if (type === "message" || typeof item.role === "string") {
			const role = typeof item.role === "string" ? item.role : "user";
			if (role === "system" || role === "developer") {
				const text = textFromContent(item.content);
				if (text) {
					systemParts.push(text);
				}
				continue;
			}
			const anthRole = role === "assistant" ? "assistant" : "user";
			for (const block of contentBlocks(item.content)) {
				pushBlock(messages, anthRole, block);
			}
			continue;
		}
		if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
			if (item.status === "incomplete") {
				continue;
			}
			const responseName =
				typeof item.name === "string"
					? item.name
					: type === "tool_search_call"
						? "tool_search"
						: "tool";
			const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
			const providerName =
				providerNameForResponseCall(responseName, namespace, mappings) ??
				allocateToolName(responseName, namespace, usedNames);
			const mapping =
				mappings.get(providerName) ??
				({ providerName, responseName, namespace, custom: type === "custom_tool_call" } satisfies AnthropicToolMapping);
			mappings.set(providerName, mapping);
			const input = toolInputFromResponses(item, type);
			pushBlock(messages, "assistant", {
				type: "tool_use",
				id: callId(item),
				name: providerName,
				input,
			});
			continue;
		}
		if (
			type === "function_call_output" ||
			type === "custom_tool_call_output" ||
			type === "tool_search_output"
		) {
			pushBlock(messages, "user", {
				type: "tool_result",
				tool_use_id: callId(item),
				content: stringifyToolOutput(item.output ?? item.result),
				...(isToolError(item) ? { is_error: true } : {}),
			});
			continue;
		}
		if (type === "input_text" || type === "output_text") {
			const text = typeof item.text === "string" ? item.text : "";
			if (text.trim()) {
				pushBlock(messages, "user", { type: "text", text });
			}
			continue;
		}
		if (type === "input_image" || type === "image_url") {
			const image = imageBlockFromPart(item);
			if (image) {
				pushBlock(messages, "user", image);
			}
		}
	}
}

function toolInputFromResponses(
	item: Record<string, unknown>,
	type: string,
): Record<string, unknown> {
	if (type === "custom_tool_call") {
		return { input: typeof item.input === "string" ? item.input : "" };
	}
	if (type === "tool_search_call") {
		return isRecord(item.arguments) ? item.arguments : {};
	}
	const raw = typeof item.arguments === "string" ? item.arguments : "";
	if (!raw.trim()) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function textFromContent(content: unknown): string {
	return contentBlocks(content)
		.filter((block) => block.type === "text")
		.map((block) => String(block.text ?? ""))
		.filter(Boolean)
		.join("\n\n");
}

function isModelSwitchItem(item: unknown): boolean {
	return (
		isRecord(item) &&
		item.type === "message" &&
		textFromContent(item.content).includes("<model_switch>")
	);
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
	if (typeof content === "string") {
		return content.trim() ? [{ type: "text", text: content }] : [];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const blocks: Array<Record<string, unknown>> = [];
	for (const part of content) {
		if (!isRecord(part)) {
			continue;
		}
		const type = typeof part.type === "string" ? part.type : "";
		if (type === "input_text" || type === "output_text" || type === "summary_text" || type === "text") {
			const text = typeof part.text === "string" ? part.text : "";
			if (text.trim()) {
				blocks.push({ type: "text", text });
			}
			continue;
		}
		if (type === "refusal" && typeof part.refusal === "string" && part.refusal.trim()) {
			blocks.push({ type: "text", text: part.refusal });
			continue;
		}
		if (type === "input_image" || type === "image_url") {
			const image = imageBlockFromPart(part);
			if (image) {
				blocks.push(image);
			}
		}
	}
	return blocks;
}

function imageBlockFromPart(part: Record<string, unknown>): Record<string, unknown> | undefined {
	const url = imageUrlFromPart(part);
	if (!url) {
		return undefined;
	}
	const dataUrl = /^data:([^;,]+);base64,(.+)$/i.exec(url);
	if (dataUrl) {
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: dataUrl[1] || "image/png",
				data: dataUrl[2],
			},
		};
	}
	return { type: "image", source: { type: "url", url } };
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

function pushBlock(
	messages: Array<Record<string, unknown>>,
	role: "user" | "assistant",
	block: Record<string, unknown>,
): void {
	const last = messages[messages.length - 1];
	if (last && last.role === role) {
		const content = Array.isArray(last.content) ? last.content : [];
		content.push(block);
		last.content = content;
		return;
	}
	messages.push({ role, content: [block] });
}

function normalizeMessages(messages: Array<Record<string, unknown>>): void {
	let write = 0;
	for (const message of messages) {
		const content = Array.isArray(message.content) ? message.content : [];
		if (content.length === 0) {
			continue;
		}
		const previous = messages[write - 1];
		if (previous && previous.role === message.role) {
			previous.content = [
				...(Array.isArray(previous.content) ? previous.content : []),
				...content,
			];
			continue;
		}
		messages[write++] = { ...message, content };
	}
	messages.length = write;
	if (messages.length === 0 || messages[0].role !== "user") {
		messages.unshift({
			role: "user",
			content: [{ type: "text", text: "(continued conversation)" }],
		});
	}
	if (messages[messages.length - 1]?.role === "assistant") {
		messages.push({
			role: "user",
			content: [{ type: "text", text: CONTINUE_PROMPT }],
		});
	}
}

function buildThinkingConfig(
	body: Record<string, unknown>,
	maxTokens: number,
	hasTools: boolean,
	toolChoice: unknown,
	model: string,
): AnthropicThinkingConfig | undefined {
	const effort =
		isRecord(body.reasoning) && typeof body.reasoning.effort === "string"
			? body.reasoning.effort
			: undefined;
	if (!effort) {
		return undefined;
	}
	if (isReasoningDisabled(effort)) {
		return { thinking: { type: "disabled" } };
	}
	if (usesAdaptiveThinking(model)) {
		if (isForcedToolChoice(toolChoice)) {
			return { thinking: { type: "disabled" } };
		}
		const anthropicEffort = codexEffortToAnthropic(effort);
		if (!anthropicEffort) {
			return undefined;
		}
		return {
			thinking: {
				type: "adaptive",
				block_binding: { prefix_mismatch_behavior: "drop_block" },
			},
			outputConfig: { effort: anthropicEffort },
		};
	}
	const budget = thinkingBudget(effort);
	if (budget === undefined || (!hasTools && isForcedToolChoice(toolChoice))) {
		return undefined;
	}
	const capped = Math.min(budget, Math.floor(maxTokens / 2));
	if (capped < 1024) {
		return undefined;
	}
	if (isForcedToolChoice(toolChoice)) {
		return undefined;
	}
	return { thinking: { type: "enabled", budget_tokens: capped } };
}

function usesAdaptiveThinking(model: string): boolean {
	const normalized = model.trim().toLowerCase().replace(/[._]/g, "-");
	return [
		"haiku-5-5",
		"sonnet-5",
		"opus-5",
		"opus-4-8",
		"opus-4-7",
		"opus-4-6",
		"sonnet-4-6",
		"fable-5",
		"mythos-5",
		"mythos-preview",
	].some((needle) => normalized.includes(needle));
}

function defaultMaxTokensForModel(model: string): number {
	const normalized = model.trim().toLowerCase().replace(/[._]/g, "-");
	if (normalized.includes("claude-haiku-5-5")) {
		return CLAUDE_HAIKU_5_5_MAX_TOKENS;
	}
	return DEFAULT_MAX_TOKENS;
}

function codexEffortToAnthropic(effort: string): string | undefined {
	switch (effort.trim().toLowerCase()) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
		case "max":
		case "ultra":
			return "max";
		default:
			return undefined;
	}
}

function isReasoningDisabled(effort: string): boolean {
	return ["none", "off", "disabled"].includes(effort.trim().toLowerCase());
}

function thinkingBudget(effort: string | undefined): number | undefined {
	switch (effort?.trim().toLowerCase()) {
		case "minimal":
		case "low":
			return 2048;
		case "medium":
			return 8192;
		case "high":
			return 16384;
		case "xhigh":
		case "max":
		case "ultra":
			return 24576;
		default:
			return undefined;
	}
}

function isForcedToolChoice(choice: unknown): boolean {
	if (choice === "required") {
		return true;
	}
	return isRecord(choice) && typeof choice.name === "string";
}

function convertToolChoice(
	choice: unknown,
	mappings: Map<string, AnthropicToolMapping>,
): Record<string, unknown> | undefined {
	if (choice === "auto") {
		return { type: "auto" };
	}
	if (choice === "none") {
		return { type: "none" };
	}
	if (choice === "required") {
		return { type: "any" };
	}
	if (!isRecord(choice) || typeof choice.name !== "string") {
		return undefined;
	}
	const namespace = typeof choice.namespace === "string" ? choice.namespace : undefined;
	const providerName =
		providerNameForResponseCall(choice.name, namespace, mappings) ??
		allocateToolName(choice.name, namespace, new Set());
	return { type: "tool", name: providerName };
}

function providerNameForResponseCall(
	name: string,
	namespace: string | undefined,
	mappings: Map<string, AnthropicToolMapping>,
): string | undefined {
	for (const mapping of mappings.values()) {
		if (mapping.responseName === name && mapping.namespace === namespace) {
			return mapping.providerName;
		}
	}
	return undefined;
}

function allocateToolName(name: string, namespace: string | undefined, used: Set<string>): string {
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

function callId(item: Record<string, unknown>): string {
	return typeof item.call_id === "string" && item.call_id
		? item.call_id
		: typeof item.id === "string" && item.id
			? item.id
			: `call_${randomUUID()}`;
}

function isToolError(item: Record<string, unknown>): boolean {
	return item.is_error === true || item.status === "failed";
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
	return value === undefined ? "" : JSON.stringify(value);
}

function buildAnthropicHeaders(
	headers: http.IncomingHttpHeaders,
	apiKey: string,
	stream: boolean,
	extraBeta: string[] = [],
): Record<string, string> {
	const result: Record<string, string> = {
		"x-api-key": apiKey,
		"anthropic-version": ANTHROPIC_VERSION,
		"content-type": "application/json",
		accept: stream ? "text/event-stream" : "application/json",
		"user-agent": USER_AGENT,
	};
	const passthrough = [
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
	const betaValues = new Set<string>(extraBeta);
	const incomingBeta = headerValue(headers["anthropic-beta"]);
	if (incomingBeta) {
		for (const value of incomingBeta.split(",")) {
			const beta = value.trim();
			if (beta) {
				betaValues.add(beta);
			}
		}
	}
	if (betaValues.size > 0) {
		result["anthropic-beta"] = [...betaValues].join(", ");
	}
	const sessionId =
		result["x-opencode-session"] ??
		result["session-id"] ??
		result["thread-id"];
	if (sessionId) {
		result["x-opencode-session"] = sessionId;
	}
	return result;
}

function isAdaptiveThinking(value: unknown): boolean {
	return isRecord(value) && value.type === "adaptive";
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

function anthropicJsonToResponses(
	payload: Record<string, unknown>,
	model: string,
	mappings: Map<string, AnthropicToolMapping>,
): Record<string, unknown> {
	const output: Array<Record<string, unknown>> = [];
	const responseModel =
		typeof payload.model === "string" && payload.model ? payload.model : model;
	const content = Array.isArray(payload.content) ? payload.content : [];
	for (const block of content) {
		if (!isRecord(block)) {
			continue;
		}
		const type = typeof block.type === "string" ? block.type : "";
		if (type === "text" && typeof block.text === "string" && block.text) {
			pushTextOutput(output, block.text);
		} else if (type === "thinking" || type === "redacted_thinking") {
			const item = responsesReasoningItemFromAnthropicBlock(
				block,
				undefined,
				responseModel,
			);
			if (item) {
				output.push(item);
			}
		} else if (type === "tool_use") {
			output.push(anthropicToolUseToResponseItem(block, mappings));
		}
	}
	const statusInfo = anthropicStopStatus(payload.stop_reason);
	const response = baseResponse(
		typeof payload.id === "string" ? `resp_${payload.id.replace(/^resp_/, "")}` : undefined,
		responseModel,
		statusInfo.status,
		output,
		anthropicUsageToResponsesUsage(payload.usage),
	);
	if (statusInfo.reason) {
		response.incomplete_details = { reason: statusInfo.reason };
	}
	return response;
}

class AnthropicSseToResponsesWriter {
	private readonly output = new Map<number, Record<string, unknown>>();
	private readonly blocks = new Map<number, AnthropicBlockState>();
	private readonly anthropicUsage: Record<string, unknown> = {};
	private responseId = `resp_${randomUUID()}`;
	private nextOutputIndex = 0;
	private stopReason?: string;
	private completed = false;
	private started = false;

	constructor(
		private readonly res: http.ServerResponse,
		private readonly mappings: Map<string, AnthropicToolMapping>,
		private model = "",
	) {}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		const response = this.baseResponse("in_progress", []);
		this.send("response.created", { response });
		this.send("response.in_progress", { response });
	}

	push(event: Record<string, unknown>): void {
		const type = typeof event.type === "string" ? event.type : "";
		if (type === "message_start") {
			this.handleMessageStart(event);
		} else if (type === "content_block_start") {
			this.handleContentBlockStart(event);
		} else if (type === "content_block_delta") {
			this.handleContentBlockDelta(event);
		} else if (type === "content_block_stop") {
			const index = numberValue(event.index);
			this.closeBlock(index);
		} else if (type === "message_delta") {
			this.handleMessageDelta(event);
		} else if (type === "error") {
			throw new Error(anthropicErrorMessage(event));
		}
	}

	finish(): void {
		if (this.completed) {
			return;
		}
		this.start();
		for (const [index, block] of [...this.blocks.entries()].sort(([a], [b]) => a - b)) {
			if (!block.closed) {
				this.closeBlock(index);
			}
		}
		const statusInfo = anthropicStopStatus(this.stopReason);
		const response = this.baseResponse(statusInfo.status, this.sortedOutput());
		if (statusInfo.reason) {
			response.incomplete_details = { reason: statusInfo.reason };
		}
		this.send(statusInfo.status === "incomplete" ? "response.incomplete" : "response.completed", {
			response,
		});
		this.completed = true;
		this.res.end();
	}

	fail(message: string): void {
		if (this.completed || this.res.writableEnded || this.res.destroyed) {
			return;
		}
		this.start();
		for (const [index, block] of [...this.blocks.entries()].sort(([a], [b]) => a - b)) {
			if (!block.closed) {
				this.closeBlock(index);
			}
		}
		const response = this.baseResponse("failed", this.sortedOutput());
		response.error = { code: "proxy_upstream_error", message };
		this.send("response.failed", { response });
		this.completed = true;
		this.res.end();
	}

	private handleMessageStart(event: Record<string, unknown>): void {
		const message = isRecord(event.message) ? event.message : {};
		if (typeof message.id === "string" && message.id) {
			this.responseId = `resp_${message.id.replace(/^resp_/, "")}`;
		}
		if (typeof message.model === "string" && message.model) {
			this.model = message.model;
		}
		this.mergeUsage(message.usage);
		this.start();
	}

	private handleContentBlockStart(event: Record<string, unknown>): void {
		this.start();
		const index = numberValue(event.index);
		const block = isRecord(event.content_block) ? event.content_block : {};
		const type = typeof block.type === "string" ? block.type : "";
		if (type === "text") {
			const outputIndex = this.nextOutputIndex++;
			const itemId = `msg_${randomUUID()}`;
			this.blocks.set(index, {
				kind: "text",
				outputIndex,
				itemId,
				text: typeof block.text === "string" ? block.text : "",
				callId: "",
				providerName: "",
				sourceBlock: block,
				startInput: "",
				visibleSummary: false,
				closed: false,
			});
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
			return;
		}
		if (type === "tool_use") {
			const outputIndex = this.nextOutputIndex++;
			const providerName = typeof block.name === "string" ? block.name : "";
			const mapping = this.mappings.get(providerName);
			const custom = mapping?.custom === true;
			const itemId = `${custom ? "ctc" : "fc"}_${randomUUID()}`;
			const callId = typeof block.id === "string" && block.id ? block.id : `call_${randomUUID()}`;
			const startInput = isRecord(block.input) ? JSON.stringify(block.input) : "";
			this.blocks.set(index, {
				kind: "tool",
				outputIndex,
				itemId,
				text: "",
				callId,
				providerName,
				mapping,
				sourceBlock: block,
				startInput,
				visibleSummary: false,
				closed: false,
			});
			this.send("response.output_item.added", {
				output_index: outputIndex,
				item: {
					id: itemId,
					type: custom ? "custom_tool_call" : "function_call",
					status: "in_progress",
					call_id: callId,
					name: mapping?.responseName ?? providerName,
					...(mapping?.namespace ? { namespace: mapping.namespace } : {}),
					...(custom ? { input: "" } : { arguments: "" }),
				},
			});
			return;
		}
		if (type === "thinking" || type === "redacted_thinking") {
			const outputIndex = this.nextOutputIndex++;
			const itemId = `rs_${randomUUID()}`;
			const visibleSummary = type === "thinking";
			this.blocks.set(index, {
				kind: "thinking",
				outputIndex,
				itemId,
				text: typeof block.thinking === "string" ? block.thinking : "",
				callId: "",
				providerName: "",
				sourceBlock: block,
				startInput: "",
				visibleSummary,
				closed: false,
			});
			this.send("response.output_item.added", {
				output_index: outputIndex,
				item: { id: itemId, type: "reasoning", status: "in_progress", summary: [] },
			});
			if (visibleSummary) {
				this.send("response.reasoning_summary_part.added", {
					item_id: itemId,
					output_index: outputIndex,
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				});
			}
		}
	}

	private handleContentBlockDelta(event: Record<string, unknown>): void {
		const index = numberValue(event.index);
		const block = this.blocks.get(index);
		if (!block) {
			return;
		}
		const delta = isRecord(event.delta) ? event.delta : {};
		const type = typeof delta.type === "string" ? delta.type : "";
		if (type === "text_delta") {
			const text = typeof delta.text === "string" ? delta.text : "";
			block.text += text;
			this.send("response.output_text.delta", {
				item_id: block.itemId,
				output_index: block.outputIndex,
				content_index: 0,
				delta: text,
			});
			return;
		}
		if (type === "input_json_delta") {
			const partial = typeof delta.partial_json === "string" ? delta.partial_json : "";
			block.text += partial;
			if (!block.mapping?.custom && partial) {
				this.send("response.function_call_arguments.delta", {
					item_id: block.itemId,
					output_index: block.outputIndex,
					delta: partial,
				});
			}
			return;
		}
		if (type === "thinking_delta") {
			const text = typeof delta.thinking === "string" ? delta.thinking : "";
			block.text += text;
			block.sourceBlock.thinking = block.text;
			if (block.visibleSummary) {
				this.send("response.reasoning_summary_text.delta", {
					item_id: block.itemId,
					output_index: block.outputIndex,
					summary_index: 0,
					delta: text,
				});
			}
			return;
		}
		if (type === "signature_delta") {
			const signature = typeof delta.signature === "string" ? delta.signature : "";
			const previous =
				typeof block.sourceBlock.signature === "string"
					? block.sourceBlock.signature
					: "";
			block.sourceBlock.signature = previous + signature;
		}
	}

	private handleMessageDelta(event: Record<string, unknown>): void {
		const delta = isRecord(event.delta) ? event.delta : {};
		if (typeof delta.stop_reason === "string") {
			this.stopReason = delta.stop_reason;
		}
		this.mergeUsage(event.usage);
	}

	private mergeUsage(raw: unknown): void {
		if (!isRecord(raw)) {
			return;
		}
		for (const [key, value] of Object.entries(raw)) {
			this.anthropicUsage[key] = value;
		}
	}

	private closeBlock(index: number): void {
		const block = this.blocks.get(index);
		if (!block || block.closed) {
			return;
		}
		block.closed = true;
		if (block.kind === "text") {
			const item = {
				id: block.itemId,
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: block.text, annotations: [] }],
			};
			this.send("response.output_text.done", {
				item_id: block.itemId,
				output_index: block.outputIndex,
				content_index: 0,
				text: block.text,
			});
			this.send("response.content_part.done", {
				item_id: block.itemId,
				output_index: block.outputIndex,
				content_index: 0,
				part: { type: "output_text", text: block.text, annotations: [] },
			});
			this.send("response.output_item.done", {
				output_index: block.outputIndex,
				item,
			});
			this.output.set(block.outputIndex, item);
			return;
		}
		if (block.kind === "thinking") {
			if (block.sourceBlock.type === "thinking") {
				block.sourceBlock.thinking = block.text;
			}
			const item = responsesReasoningItemFromAnthropicBlock(
				block.sourceBlock,
				block.itemId,
				this.model,
			);
			if (!item) {
				return;
			}
			if (block.visibleSummary) {
				this.send("response.reasoning_summary_text.done", {
					item_id: block.itemId,
					output_index: block.outputIndex,
					summary_index: 0,
					text: block.text,
				});
				this.send("response.reasoning_summary_part.done", {
					item_id: block.itemId,
					output_index: block.outputIndex,
					summary_index: 0,
					part: { type: "summary_text", text: block.text },
				});
			}
			this.send("response.output_item.done", {
				output_index: block.outputIndex,
				item,
			});
			this.output.set(block.outputIndex, item);
			return;
		}

		const argumentsText = block.text || block.startInput || "{}";
		const custom = block.mapping?.custom === true;
		const item = toolResponseItem(block, argumentsText);
		if (custom) {
			const input = customInputFromArguments(argumentsText);
			if (input) {
				this.send("response.custom_tool_call_input.delta", {
					item_id: block.itemId,
					output_index: block.outputIndex,
					delta: input,
				});
			}
			this.send("response.custom_tool_call_input.done", {
				item_id: block.itemId,
				output_index: block.outputIndex,
				input,
			});
		} else {
			this.send("response.function_call_arguments.done", {
				item_id: block.itemId,
				output_index: block.outputIndex,
				arguments: argumentsText,
			});
		}
		this.send("response.output_item.done", {
			output_index: block.outputIndex,
			item,
		});
		this.output.set(block.outputIndex, item);
	}

	private sortedOutput(): Array<Record<string, unknown>> {
		return [...this.output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
	}

	private baseResponse(status: string, output: Array<Record<string, unknown>>): Record<string, unknown> {
		return baseResponse(
			this.responseId,
			this.model,
			status,
			output,
			anthropicUsageToResponsesUsage(this.anthropicUsage),
		);
	}

	private send(event: string, data: Record<string, unknown>): void {
		if (this.res.writableEnded) {
			return;
		}
		this.res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	}
}

async function pipeAnthropicSse(
	upstream: Response,
	writer: AnthropicSseToResponsesWriter,
): Promise<void> {
	if (!upstream.body) {
		throw new Error("Upstream returned an empty stream");
	}
	const reader = upstream.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sawMessageStop = false;
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
			const event = parseAnthropicSseBlock(block);
			if (event) {
				if (event.type === "message_stop") {
					sawMessageStop = true;
				}
				writer.push(event);
			}
			boundary = buffer.indexOf("\n\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) {
		const event = parseAnthropicSseBlock(buffer);
		if (event) {
			if (event.type === "message_stop") {
				sawMessageStop = true;
			}
			writer.push(event);
		}
	}
	if (!sawMessageStop) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

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
	try {
		const parsed = JSON.parse(data) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function anthropicErrorMessage(event: Record<string, unknown>): string {
	const error = isRecord(event.error) ? event.error : event;
	if (typeof error.message === "string") {
		return error.message;
	}
	return JSON.stringify(error);
}

function anthropicToolUseToResponseItem(
	block: Record<string, unknown>,
	mappings: Map<string, AnthropicToolMapping>,
): Record<string, unknown> {
	const providerName = typeof block.name === "string" ? block.name : "";
	const mapping = mappings.get(providerName);
	const state: AnthropicBlockState = {
		kind: "tool",
		outputIndex: 0,
		itemId: `${mapping?.custom ? "ctc" : "fc"}_${randomUUID()}`,
		text: "",
		callId: typeof block.id === "string" && block.id ? block.id : `call_${randomUUID()}`,
		providerName,
		mapping,
		sourceBlock: block,
		startInput: "",
		visibleSummary: false,
		closed: false,
	};
	return toolResponseItem(state, JSON.stringify(isRecord(block.input) ? block.input : {}));
}

function toolResponseItem(
	block: AnthropicBlockState,
	argumentsText: string,
): Record<string, unknown> {
	const mapping = block.mapping;
	const custom = mapping?.custom === true;
	const item: Record<string, unknown> = {
		id: block.itemId,
		type: custom ? "custom_tool_call" : "function_call",
		status: "completed",
		call_id: block.callId,
		name: mapping?.responseName ?? block.providerName,
	};
	if (mapping?.namespace) {
		item.namespace = mapping.namespace;
	}
	if (custom) {
		item.input = customInputFromArguments(argumentsText);
	} else {
		item.arguments = argumentsText || "{}";
	}
	return item;
}

function customInputFromArguments(argumentsText: string): string {
	if (!argumentsText) {
		return "";
	}
	try {
		const parsed = JSON.parse(argumentsText) as unknown;
		if (isRecord(parsed) && typeof parsed.input === "string") {
			return parsed.input;
		}
	} catch {
		// Some gateways return raw custom input without JSON wrapping.
	}
	return argumentsText;
}

function responsesReasoningItemFromAnthropicBlock(
	block: Record<string, unknown>,
	id: string = `rs_${randomUUID()}`,
	model?: string,
): Record<string, unknown> | undefined {
	const encryptedContent = encodeAnthropicThinkingBlock(block, model);
	const text = typeof block.thinking === "string" ? block.thinking : "";
	const item: Record<string, unknown> = {
		id,
		type: "reasoning",
		summary: text ? [{ type: "summary_text", text }] : [],
	};
	if (encryptedContent) {
		item.encrypted_content = encryptedContent;
	}
	return item;
}

function anthropicStopStatus(stopReason: unknown): {
	status: string;
	reason?: string;
} {
	if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
		return { status: "incomplete", reason: "max_output_tokens" };
	}
	if (stopReason === "refusal") {
		return { status: "incomplete", reason: "content_filter" };
	}
	return { status: "completed" };
}

function anthropicUsageToResponsesUsage(raw: unknown): Record<string, unknown> {
	const usage = isRecord(raw) ? raw : {};
	const freshInput = numberValue(usage.input_tokens);
	const output = numberValue(usage.output_tokens);
	const cacheRead = numberValue(usage.cache_read_input_tokens);
	const cacheCreation = numberValue(usage.cache_creation_input_tokens);
	const input = freshInput + cacheRead + cacheCreation;
	const reasoning =
		isRecord(usage.output_tokens_details) &&
		typeof usage.output_tokens_details.thinking_tokens === "number"
			? usage.output_tokens_details.thinking_tokens
			: 0;
	return {
		input_tokens: input,
		output_tokens: output,
		total_tokens: input + output,
		input_tokens_details: {
			cached_tokens: cacheRead,
			cache_write_tokens: cacheCreation,
		},
		output_tokens_details: { reasoning_tokens: reasoning },
	};
}

function baseResponse(
	id: string | undefined,
	model: string,
	status: string,
	output: Array<Record<string, unknown>>,
	usage?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		id: id ?? `resp_${randomUUID()}`,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status,
		model,
		output,
		usage: usage ?? null,
	};
}

function pushTextOutput(
	output: Array<Record<string, unknown>>,
	text: string,
): void {
	const last = output[output.length - 1];
	if (last?.type === "message" && Array.isArray(last.content)) {
		last.content.push({ type: "output_text", text, annotations: [] });
		return;
	}
	output.push({
		id: `msg_${randomUUID()}`,
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
	});
}

function joinUrl(baseUrl: string, endpoint: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
