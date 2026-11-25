export interface ExtractedChatToolOutput {
	text: string;
	media: Array<Record<string, unknown>>;
}

export interface AnthropicToolResult {
	content: string | Array<Record<string, unknown>>;
}

export function responsesInputFileToChatPart(
	part: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (part.type !== "input_file") {
		return undefined;
	}
	const file: Record<string, unknown> = {};
	for (const key of ["file_id", "file_data", "filename", "file_url"]) {
		if (typeof part[key] === "string" && part[key]) {
			file[key] = part[key];
		}
	}
	if (!file.file_id && !file.file_data && !file.file_url) {
		return undefined;
	}
	return { type: "file", file };
}

export function responsesInputAudioToChatPart(
	part: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (part.type !== "input_audio" || !isRecord(part.input_audio)) {
		return undefined;
	}
	return { type: "input_audio", input_audio: part.input_audio };
}

export function responsesInputFileToAnthropicBlock(
	part: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (part.type !== "input_file") {
		return undefined;
	}
	const filename =
		typeof part.filename === "string" && part.filename.trim()
			? part.filename.trim()
			: undefined;
	let block: Record<string, unknown> | undefined;

	if (typeof part.file_url === "string" && /^https?:\/\//i.test(part.file_url)) {
		block = {
			type: "document",
			source: { type: "url", url: part.file_url },
		};
	} else if (typeof part.file_data === "string") {
		const dataUrl = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/i.exec(part.file_data);
		if (dataUrl?.[2]) {
			block = {
				type: "document",
				source: {
					type: "base64",
					media_type: dataUrl[1] || "application/pdf",
					data: dataUrl[2],
				},
			};
		}
	}

	if (block && filename) {
		block.title = filename;
	}
	return block;
}

/**
 * Chat tool messages are commonly string-only. Move rich parts into a user
 * message immediately after the tool-output batch while retaining a compact
 * text result in the tool message itself.
 */
export function extractChatToolOutput(value: unknown): ExtractedChatToolOutput {
	const media: Array<Record<string, unknown>> = [];
	const text = extractChatToolValue(value, media, 0);
	return {
		text: text || (media.length > 0 ? "[tool result media is attached below]" : ""),
		media,
	};
}

/**
 * Anthropic tool_result content supports text, image and document blocks
 * directly, so keep rich tool output attached to the originating call.
 */
export function extractAnthropicToolResult(value: unknown): AnthropicToolResult {
	const blocks: Array<Record<string, unknown>> = [];
	extractAnthropicToolBlocks(value, blocks, 0);
	if (blocks.length > 0 && blocks.every((block) => block.type === "text")) {
		return {
			content: blocks.map((block) => String(block.text ?? "")).filter(Boolean).join("\n"),
		};
	}
	return {
		content:
			blocks.length > 0
				? blocks
				: [{ type: "text", text: stringifyUnknown(value) }],
	};
}

function extractChatToolValue(
	value: unknown,
	media: Array<Record<string, unknown>>,
	depth: number,
): string {
	if (depth > 16) {
		return stringifyUnknown(value);
	}
	if (typeof value === "string") {
		const image = imagePartFromDataUrl(value);
		if (image) {
			media.push(image);
			return "";
		}
		const parsed = parseJsonContainer(value);
		if (parsed !== undefined) {
			const nested = extractChatToolValue(parsed, media, depth + 1);
			return nested === stringifyUnknown(parsed) ? value : nested;
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => extractChatToolValue(item, media, depth + 1))
			.filter((text) => text.length > 0)
			.join("\n");
	}
	if (!isRecord(value)) {
		return value === undefined ? "" : stringifyUnknown(value);
	}

	const mediaPart = chatMediaPartFromResponsesPart(value);
	if (mediaPart) {
		media.push(mediaPart);
		return "";
	}
	if (
		value.type === "input_text" ||
		value.type === "output_text" ||
		value.type === "text" ||
		value.type === "summary_text"
	) {
		return typeof value.text === "string" ? value.text : "";
	}
	if (Array.isArray(value.content)) {
		return extractChatToolValue(value.content, media, depth + 1);
	}
	if (typeof value.content === "string") {
		return value.content;
	}
	return stringifyUnknown(value);
}

function chatMediaPartFromResponsesPart(
	part: Record<string, unknown>,
): Record<string, unknown> | undefined {
	if (part.type === "input_image" || part.type === "image_url") {
		const url = imageUrlFromPart(part);
		if (url) {
			return {
				type: "image_url",
				image_url: {
					url,
					...(typeof part.detail === "string" ? { detail: part.detail } : {}),
				},
			};
		}
	}
	return (
		responsesInputFileToChatPart(part) ??
		responsesInputAudioToChatPart(part)
	);
}

function extractAnthropicToolBlocks(
	value: unknown,
	blocks: Array<Record<string, unknown>>,
	depth: number,
): void {
	if (depth > 16) {
		blocks.push({ type: "text", text: stringifyUnknown(value) });
		return;
	}
	if (typeof value === "string") {
		const image = imageBlockFromDataUrl(value);
		if (image) {
			blocks.push(image);
			return;
		}
		const parsed = parseJsonContainer(value);
		if (parsed !== undefined) {
			extractAnthropicToolBlocks(parsed, blocks, depth + 1);
			return;
		}
		if (value) {
			blocks.push({ type: "text", text: value });
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			extractAnthropicToolBlocks(item, blocks, depth + 1);
		}
		return;
	}
	if (!isRecord(value)) {
		if (value !== undefined) {
			blocks.push({ type: "text", text: stringifyUnknown(value) });
		}
		return;
	}

	const type = typeof value.type === "string" ? value.type : "";
	if (
		type === "input_text" ||
		type === "output_text" ||
		type === "text" ||
		type === "summary_text"
	) {
		if (typeof value.text === "string" && value.text) {
			blocks.push({ type: "text", text: value.text });
		}
		return;
	}
	if (type === "input_image" || type === "image_url") {
		const url = imageUrlFromPart(value);
		if (url) {
			const image = imageBlockFromDataUrl(url);
			if (image) {
				blocks.push(image);
			} else {
				blocks.push({
					type: "image",
					source: { type: "url", url },
				});
			}
			return;
		}
	}
	if (type === "input_file") {
		const document = responsesInputFileToAnthropicBlock(value);
		if (document) {
			blocks.push(document);
			return;
		}
	}
	if (Array.isArray(value.content)) {
		extractAnthropicToolBlocks(value.content, blocks, depth + 1);
		return;
	}
	blocks.push({ type: "text", text: stringifyUnknown(value) });
}

function imageBlockFromDataUrl(value: string): Record<string, unknown> | undefined {
	const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
	if (!match?.[2] || !match[1].startsWith("image/")) {
		return undefined;
	}
	return {
		type: "image",
		source: {
			type: "base64",
			media_type: match[1],
			data: match[2],
		},
	};
}

function imagePartFromDataUrl(value: string): Record<string, unknown> | undefined {
	const match = /^data:(image\/[^;,]+);base64,(.+)$/i.exec(value.trim());
	if (!match) {
		return undefined;
	}
	return {
		type: "image_url",
		image_url: { url: value.trim() },
	};
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

function parseJsonContainer(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value === undefined) {
		return "";
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
