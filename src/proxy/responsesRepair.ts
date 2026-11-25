import { createHash } from "crypto";

export interface NamespaceRestoreEntry {
	namespace: string;
	name: string;
}

export type NamespaceRestoreMap = Map<string, NamespaceRestoreEntry>;

export interface NativeSseBlock {
	raw: string;
	event?: Record<string, unknown>;
}

const MAX_TOOL_NAME_LENGTH = 64;

/**
 * Codex 0.142+ can send private Responses `namespace` tool declarations.
 * Strict third-party Responses gateways reject that shape, so lift each child
 * to a deterministic top-level function and restore the original identity in
 * the response. Requests without namespaces remain byte-for-byte unchanged.
 */
export function flattenNativeNamespaces(
	body: Record<string, unknown>,
): NamespaceRestoreMap {
	const restoreMap: NamespaceRestoreMap = new Map();
	const tools = Array.isArray(body.tools) ? body.tools : [];
	if (!tools.some((tool) => isRecord(tool) && tool.type === "namespace")) {
		return restoreMap;
	}

	const topLevelNames = new Set<string>();
	for (const tool of tools) {
		if (!isRecord(tool) || (tool.type !== "function" && tool.type !== "custom")) {
			continue;
		}
		const name = responseToolName(tool);
		if (name) {
			topLevelNames.add(name);
		}
	}

	const owners = new Map<string, NamespaceRestoreEntry>();
	for (const tool of tools) {
		if (!isRecord(tool) || tool.type !== "namespace") {
			continue;
		}
		if (typeof tool.name !== "string" || !tool.name.trim()) {
			continue;
		}
		const namespace = tool.name.trim();
		for (const child of namespaceChildren(tool)) {
			if (!isRecord(child) || child.type !== "function") {
				continue;
			}
			const name = responseToolName(child);
			if (!name) {
				continue;
			}
			const flat = flattenNamespaceToolName(namespace, name);
			const entry = { namespace, name };
			if (topLevelNames.has(flat)) {
				throw new Error(
					`namespace tool ${namespace}/${name} flattens to ${flat}, which collides with a top-level tool`,
				);
			}
			const previous = owners.get(flat);
			if (
				previous &&
				(previous.namespace !== namespace || previous.name !== name)
			) {
				throw new Error(
					`namespace tools ${previous.namespace}/${previous.name} and ${namespace}/${name} both flatten to ${flat}`,
				);
			}
			owners.set(flat, entry);
		}
	}

	const flattened: unknown[] = [];
	const emitted = new Set<string>();
	for (const tool of tools) {
		if (!isRecord(tool) || tool.type !== "namespace") {
			flattened.push(tool);
			continue;
		}
		if (typeof tool.name !== "string" || !tool.name.trim()) {
			continue;
		}
		const namespace = tool.name.trim();
		for (const child of namespaceChildren(tool)) {
			if (!isRecord(child) || child.type !== "function") {
				continue;
			}
			const name = responseToolName(child);
			if (!name) {
				continue;
			}
			const flat = flattenNamespaceToolName(namespace, name);
			if (emitted.has(flat)) {
				continue;
			}
			emitted.add(flat);
			flattened.push({ ...cloneRecord(child), name: flat });
			restoreMap.set(flat, { namespace, name });
		}
	}
	body.tools = flattened;

	rewriteQualifiedCalls(body.input, owners);
	if (isRecord(body.tool_choice)) {
		if (body.tool_choice.type === "namespace") {
			body.tool_choice = "auto";
		} else {
			rewriteQualifiedCall(body.tool_choice, owners);
		}
	}
	return restoreMap;
}

export function restoreResponseNamespaces(
	value: unknown,
	restoreMap: NamespaceRestoreMap,
): boolean {
	if (restoreMap.size === 0) {
		return false;
	}
	return restoreNamespaceValue(value, restoreMap);
}

/**
 * Strict Responses gateways can reject duplicate keys inside historical
 * `function_call.arguments`. Merge duplicates with last-value-wins semantics
 * and leave every well-formed argument string untouched.
 */
export function dedupeDuplicateArgumentKeys(body: Record<string, unknown>): number {
	if (!Array.isArray(body.input)) {
		return 0;
	}
	let repaired = 0;
	for (const item of body.input) {
		if (!isRecord(item) || item.type !== "function_call") {
			continue;
		}
		if (typeof item.arguments !== "string" || !item.arguments.trim()) {
			continue;
		}
		const deduped = dedupeArguments(item.arguments);
		if (!deduped) {
			continue;
		}
		item.arguments = deduped;
		repaired++;
	}
	return repaired;
}

/**
 * Some providers emit empty `function_call_arguments.done` and
 * `output_item.done` events before the real argument deltas. Hold only those
 * empty terminal events until the arguments arrive or the response completes.
 */
export class NativeResponsesSseTransformer {
	private readonly arguments = new Map<string, string>();
	private held: Array<{ itemId: string; block: ParsedSseBlock }> = [];

	constructor(private readonly restoreMap: NamespaceRestoreMap = new Map()) {}

	push(raw: string): NativeSseBlock[] {
		const block = parseSseBlock(raw);
		if (!block) {
			return [{ raw }];
		}
		if (block.event) {
			restoreResponseNamespaces(block.event, this.restoreMap);
		}

		const delta = argumentsDelta(block.event);
		if (delta) {
			const previous = this.arguments.get(delta.itemId) ?? "";
			this.arguments.set(delta.itemId, previous + delta.value);
			return [{ raw: serializeSseBlock(block), event: block.event }];
		}

		const emptyItemId = emptyFunctionCallEnd(block.event);
		if (emptyItemId) {
			const accumulated = this.arguments.get(emptyItemId);
			if (accumulated) {
				setFunctionCallArguments(block.event, accumulated);
				return [{ raw: serializeSseBlock(block), event: block.event }];
			}
			this.held.push({ itemId: emptyItemId, block });
			return [];
		}

		const terminal = terminalResponseEvent(block.event);
		const flushed = this.flush(terminal ? block.event : undefined);
		flushed.push({ raw: serializeSseBlock(block), event: block.event });
		return flushed;
	}

	finish(): NativeSseBlock[] {
		return this.flush();
	}

	private flush(completed?: Record<string, unknown>): NativeSseBlock[] {
		const output: NativeSseBlock[] = [];
		for (const held of this.held.splice(0)) {
			const argumentsText =
				this.arguments.get(held.itemId) ??
				completedArguments(completed, held.itemId);
			if (argumentsText) {
				setFunctionCallArguments(held.block.event, argumentsText);
			}
			output.push({
				raw: serializeSseBlock(held.block),
				event: held.block.event,
			});
		}
		return output;
	}
}

export function flattenNamespaceToolName(namespace: string, name: string): string {
	const fullName = `${namespace}__${name}`;
	if (Buffer.byteLength(fullName, "utf8") <= MAX_TOOL_NAME_LENGTH) {
		return fullName;
	}
	const hash = createHash("sha256").update(fullName).digest("hex").slice(0, 16);
	const suffix = `__${hash}`;
	let prefix = "";
	for (const character of fullName) {
		if (Buffer.byteLength(prefix + character, "utf8") + suffix.length > MAX_TOOL_NAME_LENGTH) {
			break;
		}
		prefix += character;
	}
	return `${prefix}${suffix}`;
}

function namespaceChildren(tool: Record<string, unknown>): unknown[] {
	if (Array.isArray(tool.tools)) {
		return tool.tools;
	}
	return Array.isArray(tool.children) ? tool.children : [];
}

function responseToolName(tool: Record<string, unknown>): string {
	const source = isRecord(tool.function) ? tool.function : tool;
	return typeof source.name === "string" ? source.name.trim() : "";
}

function rewriteQualifiedCalls(
	value: unknown,
	owners: Map<string, NamespaceRestoreEntry>,
): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			rewriteQualifiedCalls(item, owners);
		}
		return;
	}
	if (!isRecord(value)) {
		return;
	}
	if (
		(value.type === "function_call" || value.type === "custom_tool_call") &&
		rewriteQualifiedCall(value, owners)
	) {
		return;
	}
	for (const child of Object.values(value)) {
		rewriteQualifiedCalls(child, owners);
	}
}

function rewriteQualifiedCall(
	item: Record<string, unknown>,
	owners: Map<string, NamespaceRestoreEntry>,
): boolean {
	if (typeof item.namespace !== "string" || typeof item.name !== "string") {
		return false;
	}
	const namespace = item.namespace.trim();
	const name = item.name.trim();
	if (!namespace || !name) {
		return false;
	}
	const flat = flattenNamespaceToolName(namespace, name);
	const entry = owners.get(flat);
	if (!entry || entry.namespace !== namespace || entry.name !== name) {
		return false;
	}
	item.name = flat;
	delete item.namespace;
	if (item.type === "namespace") {
		item.type = "function";
	}
	return true;
}

function restoreNamespaceValue(
	value: unknown,
	restoreMap: NamespaceRestoreMap,
): boolean {
	if (Array.isArray(value)) {
		let changed = false;
		for (const item of value) {
			changed = restoreNamespaceValue(item, restoreMap) || changed;
		}
		return changed;
	}
	if (!isRecord(value)) {
		return false;
	}

	let changed = false;
	if (
		(value.type === "function_call" || value.type === "custom_tool_call") &&
		typeof value.name === "string"
	) {
		const entry = restoreMap.get(value.name);
		if (entry) {
			value.name = entry.name;
			value.namespace = entry.namespace;
			changed = true;
		}
	}
	for (const child of Object.values(value)) {
		changed = restoreNamespaceValue(child, restoreMap) || changed;
	}
	return changed;
}

interface ParsedSseBlock {
	raw: string;
	eventName?: string;
	event?: Record<string, unknown>;
}

function parseSseBlock(raw: string): ParsedSseBlock | undefined {
	let eventName: string | undefined;
	const data: string[] = [];
	for (const line of raw.split("\n")) {
		if (line.startsWith("event:")) {
			eventName = line.slice(6).trim();
		} else if (line.startsWith("data:")) {
			data.push(line.slice(5).trimStart());
		}
	}
	if (data.length === 0) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(data.join("\n")) as unknown;
		return {
			raw,
			eventName,
			event: isRecord(parsed) ? parsed : undefined,
		};
	} catch {
		return undefined;
	}
}

function serializeSseBlock(block: ParsedSseBlock): string {
	if (!block.event) {
		return block.raw;
	}
	const eventName =
		block.eventName ??
		(typeof block.event.type === "string" ? block.event.type : undefined);
	const prefix = eventName ? `event: ${eventName}\n` : "";
	return `${prefix}data: ${JSON.stringify(block.event)}`;
}

function argumentsDelta(
	event: Record<string, unknown> | undefined,
): { itemId: string; value: string } | undefined {
	if (!event || event.type !== "response.function_call_arguments.delta") {
		return undefined;
	}
	if (typeof event.item_id !== "string" || typeof event.delta !== "string") {
		return undefined;
	}
	return { itemId: event.item_id, value: event.delta };
}

function emptyFunctionCallEnd(
	event: Record<string, unknown> | undefined,
): string | undefined {
	if (!event) {
		return undefined;
	}
	if (event.type === "response.function_call_arguments.done") {
		return typeof event.item_id === "string" &&
			(typeof event.arguments !== "string" || event.arguments.length === 0)
			? event.item_id
			: undefined;
	}
	if (event.type !== "response.output_item.done" || !isRecord(event.item)) {
		return undefined;
	}
	if (
		event.item.type === "function_call" &&
		typeof event.item.id === "string" &&
		(typeof event.item.arguments !== "string" || event.item.arguments.length === 0)
	) {
		return event.item.id;
	}
	return undefined;
}

function setFunctionCallArguments(
	event: Record<string, unknown> | undefined,
	argumentsText: string,
): void {
	if (!event) {
		return;
	}
	if (event.type === "response.output_item.done" && isRecord(event.item)) {
		if (event.item.type === "function_call") {
			event.item.arguments = argumentsText;
		}
		return;
	}
	if (event.type === "response.function_call_arguments.done") {
		event.arguments = argumentsText;
	}
}

function terminalResponseEvent(event: Record<string, unknown> | undefined): boolean {
	return (
		event?.type === "response.completed" ||
		event?.type === "response.incomplete" ||
		event?.type === "response.failed"
	);
}

function completedArguments(
	completed: Record<string, unknown> | undefined,
	itemId: string,
): string | undefined {
	const response = isRecord(completed?.response) ? completed.response : undefined;
	const output = Array.isArray(response?.output) ? response.output : [];
	for (const item of output) {
		if (
			isRecord(item) &&
			item.id === itemId &&
			typeof item.arguments === "string" &&
			item.arguments
		) {
			return item.arguments;
		}
	}
	return undefined;
}

function dedupeArguments(argumentsText: string): string | undefined {
	try {
		const parser = new DuplicateKeyJsonParser(argumentsText);
		const result = parser.parse();
		return result.duplicateKeys > 0 ? JSON.stringify(result.value) : undefined;
	} catch {
		return undefined;
	}
}

class DuplicateKeyJsonParser {
	private index = 0;
	private duplicateKeys = 0;

	constructor(private readonly source: string) {}

	parse(): { value: unknown; duplicateKeys: number } {
		this.skipWhitespace();
		const value = this.parseValue();
		this.skipWhitespace();
		if (this.index !== this.source.length) {
			throw new Error("Trailing JSON content");
		}
		return { value, duplicateKeys: this.duplicateKeys };
	}

	private parseValue(): unknown {
		this.skipWhitespace();
		const character = this.source[this.index];
		if (character === "{") {
			return this.parseObject();
		}
		if (character === "[") {
			return this.parseArray();
		}
		if (character === '"') {
			return JSON.parse(this.parseStringToken());
		}
		if (character === "-" || (character >= "0" && character <= "9")) {
			return this.parseNumber();
		}
		if (this.source.startsWith("true", this.index)) {
			this.index += 4;
			return true;
		}
		if (this.source.startsWith("false", this.index)) {
			this.index += 5;
			return false;
		}
		if (this.source.startsWith("null", this.index)) {
			this.index += 4;
			return null;
		}
		throw new Error("Invalid JSON value");
	}

	private parseObject(): Record<string, unknown> {
		const result: Record<string, unknown> = Object.create(null) as Record<
			string,
			unknown
		>;
		this.expect("{");
		this.skipWhitespace();
		if (this.source[this.index] === "}") {
			this.index++;
			return result;
		}
		while (true) {
			this.skipWhitespace();
			const key = JSON.parse(this.parseStringToken()) as string;
			this.skipWhitespace();
			this.expect(":");
			const value = this.parseValue();
			if (Object.prototype.hasOwnProperty.call(result, key)) {
				this.duplicateKeys++;
			}
			result[key] = value;
			this.skipWhitespace();
			if (this.source[this.index] === "}") {
				this.index++;
				return result;
			}
			this.expect(",");
		}
	}

	private parseArray(): unknown[] {
		const result: unknown[] = [];
		this.expect("[");
		this.skipWhitespace();
		if (this.source[this.index] === "]") {
			this.index++;
			return result;
		}
		while (true) {
			result.push(this.parseValue());
			this.skipWhitespace();
			if (this.source[this.index] === "]") {
				this.index++;
				return result;
			}
			this.expect(",");
		}
	}

	private parseStringToken(): string {
		const start = this.index;
		this.expect('"');
		let escaped = false;
		while (this.index < this.source.length) {
			const character = this.source[this.index++];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (character === '"') {
				return this.source.slice(start, this.index);
			}
		}
		throw new Error("Unterminated JSON string");
	}

	private parseNumber(): number {
		const match = this.source
			.slice(this.index)
			.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
		if (!match) {
			throw new Error("Invalid JSON number");
		}
		this.index += match[0].length;
		const value = JSON.parse(match[0]) as unknown;
		if (typeof value !== "number") {
			throw new Error("Invalid JSON number");
		}
		return value;
	}

	private skipWhitespace(): void {
		while (
			this.source[this.index] === " " ||
			this.source[this.index] === "\t" ||
			this.source[this.index] === "\n" ||
			this.source[this.index] === "\r"
		) {
			this.index++;
		}
	}

	private expect(character: string): void {
		if (this.source[this.index] !== character) {
			throw new Error(`Expected ${character}`);
		}
		this.index++;
	}
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
