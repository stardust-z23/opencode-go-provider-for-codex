/**
 * 安全、按行编辑 Codex `config.toml` 的编辑器（纯函数，零 import）。
 *
 * 本模块针对的陷阱（来自真实的配置损坏报告，以及 OpenCode Go Provider for
 * Copilot 项目总结出的模式）：
 *
 * - 绝不把文件丢进 TOML 解析器再序列化：那会毁掉用户的注释、格式和未知键。
 *   Codex 配置是人工维护的，只允许改动我们拥有的那几行。
 * - 保留文件的主导换行符（Windows 上为 CRLF）。
 * - 更新某行时保留其缩进与行尾 `#` 注释。
 * - 保持幂等：同一个选择应用两次必须是空操作，扩展绝不重写已经正确的文件。
 * - 顶层键（`model`、`model_provider` 等）**只**指第一个表头之前出现的那些。
 *   `[profiles.x]` 里的键属于该 profile，绝不能碰。
 * - 处理带引号的表头（`[model_providers."opencode-go"]`）以及 TOML 的两种
 *   字符串写法（"基本"与 '字面量'）。
 *
 * 已知限制（已记录并接受）：多行字符串（`"""..."""`）里看起来像表头的行不会
 * 被跟踪；Codex 配置通常不含这种内容。
 */

export type WireApi = "chat" | "responses" | "anthropic";
/**
 * Codex 在 `[model_providers.*].wire_api` 中接受的线上协议。
 * `chat` 支持已在 Codex 0.162 中彻底移除（openai/codex#7782），
 * `responses` 是仅剩的取值。
 */
export type CodexWireApi = "responses";

/** 默认的 OpenCode Go 推理端点（末尾不带斜杠，Codex 会自行拼接 /responses）。 */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/v1";

/**
 * 写入 Codex `config.toml` 的 provider 块。既然 Codex 只支持 Responses
 * 线上协议，一个块就够了。
 */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** 0.2.0 之前版本写入的旧 provider id；每次应用时都会被清理。 */
export const LEGACY_OPENCODE_GO_RESPONSES_PROVIDER = "opencode-go-responses";

export interface ModelSelection {
	/** OpenCode Go 提供的模型 ID（例如 "deepseek-v4.1-flash"）。 */
	modelId: string;
	/** Codex 线上协议；固定为 `"responses"`，因为 Codex 已移除 chat 支持。 */
	wireApi: CodexWireApi;
	/** Codex 认证时读取的环境变量名（`env_key`）。 */
	envKey: string;
	/** provider 的 base URL；默认为 OpenCode Go 官方端点。 */
	baseUrl?: string;
	/** 写入 `name` 的 provider 显示名。 */
	providerDisplayName?: string;
	/** undefined = 保持原样，null = 删除该键，字符串 = 设为该值。 */
	reasoningEffort?: string | null;
	/**
	 * 写入顶层 `model_catalog_json` 键的值，也就是供给 Codex **自带**模型选择器
	 * 的文件。相对文件名由 Codex 基于 `CODEX_HOME` 解析。
	 * undefined = 保持原样，null = 删除该键。
	 */
	catalogFileName?: string | null;
}

export interface ProviderConfigPatch {
	/** Codex provider base URL. */
	baseUrl: string;
	/** Environment variable Codex uses for authentication. */
	envKey: string;
	/** Provider display name. */
	providerDisplayName?: string;
}

/**
 * 所有 OpenCode Go 模型共用的 provider id。
 *
 * Codex 0.162 彻底移除了 `wire_api = "chat"`（openai/codex#7782），带该值的
 * provider 块会直接让配置加载失败，因此单个 Responses API provider 覆盖所有
 * 模型。
 */
export function providerIdForWireApi(_wireApi?: CodexWireApi): string {
	return OPENCODE_GO_PROVIDER;
}

/** 去掉末尾斜杠，避免 `base_url + "/responses"` 拼出 `//`。 */
export function normalizeBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

/** 按 TOML 基本字符串加引号，转义反斜杠与双引号。 */
export function quoteValue(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── 行工具 ──

/**
 * 把 `"key = value # comment"` 拆成代码与注释两部分；会正确识别引号，
 * 因此字符串值里的 `#` 不会被当成注释。
 */
function stripComment(line: string): { code: string; comment: string } {
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && inDouble) {
			escaped = true;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === "#" && !inSingle && !inDouble) {
			return { code: line.slice(0, i), comment: line.slice(i) };
		}
	}
	return { code: line, comment: "" };
}

/** 表头：`[name]` 或 `[[name]]`，后面可以跟注释。 */
const TABLE_NAME_RE = /^\s*\[\[?\s*([^\[\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function parseTableName(line: string): string | undefined {
	const match = line.match(TABLE_NAME_RE);
	if (!match) {
		return undefined;
	}
	// 去掉引号，让 `model_providers."opencode-go"` 也能匹配 `model_providers.opencode-go`。
	return match[1].replace(/["']/g, "").trim();
}

function isTableHeader(line: string): boolean {
	return TABLE_NAME_RE.test(line);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 匹配行首的 `key =`（键可以带引号）。 */
function keyLineRegex(key: string): RegExp {
	return new RegExp(`^\\s*"?${escapeRegExp(key)}"?\\s*=`);
}

interface TableRange {
	name: string;
	headerIndex: number;
	/** 区块正文的起始行号（不含表头本身）。 */
	start: number;
	/** 区块正文的结束位置（不含），等于下一个表头行号或总行数。 */
	end: number;
}

function findTableRanges(lines: string[]): TableRange[] {
	const ranges: TableRange[] = [];
	for (let i = 0; i < lines.length; i++) {
		const name = parseTableName(lines[i]);
		if (name === undefined) {
			continue;
		}
		ranges.push({ name, headerIndex: i, start: i + 1, end: lines.length });
	}
	for (let k = 0; k + 1 < ranges.length; k++) {
		ranges[k].end = ranges[k + 1].headerIndex;
	}
	return ranges;
}

/** 第一个表头的行号（即顶层键区域的结束位置）。 */
function firstTableIndex(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		if (isTableHeader(lines[i])) {
			return i;
		}
	}
	return lines.length;
}

/**
 * 替换已有的键行，保留其缩进与行尾注释；`key = "value"` 部分使用规范间距。
 */
function formatKeyLine(originalLine: string, key: string, value: string): string {
	const indent = originalLine.match(/^\s*/)?.[0] ?? "";
	const { comment } = stripComment(originalLine);
	const base = `${indent}${key} = ${quoteValue(value)}`;
	return comment ? `${base} ${comment}` : base;
}

/**
 * 设置（传 `null` 则删除）一个顶层键。只考虑第一个表头之前的区域，因此
 * `[profiles.x]` 等区块里的同名键绝不会被改动。
 */
function setTopLevelKey(lines: string[], key: string, value: string | null): string[] {
	const copy = [...lines];
	const limit = firstTableIndex(copy);
	const regex = keyLineRegex(key);
	let found = -1;
	for (let i = 0; i < limit; i++) {
		if (regex.test(copy[i])) {
			found = i;
			break;
		}
	}
	if (found >= 0) {
		if (value === null) {
			copy.splice(found, 1);
		} else {
			copy[found] = formatKeyLine(copy[found], key, value);
		}
		return copy;
	}
	if (value === null) {
		return copy; // 没有可删除的内容
	}
	// 插入到顶层区域的末尾（第一个表头之前）。
	let insertAt = limit;
	while (insertAt > 0 && copy[insertAt - 1].trim() === "") {
		insertAt--;
	}
	const newLine = `${key} = ${quoteValue(value)}`;
	if (insertAt < copy.length && copy[insertAt].trim() !== "") {
		// 在插入的键与后续表之间保留一个空行。
		copy.splice(insertAt, 0, newLine, "");
	} else {
		copy.splice(insertAt, 0, newLine);
	}
	return copy;
}

/** 在已有区块正文中设置（或新增）一个键。 */
function setKeyInTable(lines: string[], tableName: string, key: string, value: string): string[] {
	const range = findTableRanges(lines).find((r) => r.name === tableName);
	if (!range) {
		return lines;
	}
	const copy = [...lines];
	const regex = keyLineRegex(key);
	for (let i = range.start; i < range.end; i++) {
		if (regex.test(copy[i])) {
			copy[i] = formatKeyLine(copy[i], key, value);
			return copy;
		}
	}
	let insertAt = range.end;
	while (insertAt > range.start && copy[insertAt - 1].trim() === "") {
		insertAt--;
	}
	copy.splice(insertAt, 0, `${key} = ${quoteValue(value)}`);
	return copy;
}

/**
 * 确保 `[model_providers.<name>]` 存在且带有期望的键值对。
 * 已有键就地更新（保留注释）；未知键原样保留；缺少的区块追加到文件末尾。
 */
function ensureProviderSection(lines: string[], sectionName: string, entries: Array<[string, string]>): string[] {
	const fullName = `model_providers.${sectionName}`;
	const exists = findTableRanges(lines).some((r) => r.name === fullName);
	if (!exists) {
		const copy = [...lines];
		if (copy.length > 0 && copy[copy.length - 1].trim() !== "") {
			copy.push("");
		}
		copy.push(`[${fullName}]`);
		for (const [key, value] of entries) {
			copy.push(`${key} = ${quoteValue(value)}`);
		}
		return copy;
	}
	let copy = lines;
	for (const [key, value] of entries) {
		copy = setKeyInTable(copy, fullName, key, value);
	}
	return copy;
}

// ── 解析 / 序列化 ──

interface ParsedToml {
	lines: string[];
	eol: string;
}

function parseTomlText(text: string): ParsedToml {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	// 丢弃末尾换行产生的那个多余空行。
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return { lines, eol };
}

function serializeTomlText(lines: string[], eol: string): string {
	return lines.length === 0 ? "" : lines.join(eol) + eol;
}

// ── 公开 API ──

/**
 * 把模型选择应用到配置文本并返回新文本。
 * 纯函数：同样的输入 → 同样的输出（对同一选择幂等）。
 */
export function editConfigText(text: string, selection: ModelSelection): string {
	const parsed = parseTomlText(text);
	let lines = parsed.lines;

	if (!selection.modelId.trim()) {
		throw new Error("modelId must not be empty");
	}
	// 故意放宽类型：这道校验同样保护纯 JS 调用方（见单元测试），避免写入
	// Codex 已不再接受的协议。
	const wireApi: string = selection.wireApi;
	if (wireApi !== "responses") {
		throw new Error(`Unsupported wire API for Codex config: ${String(selection.wireApi)}`);
	}

	// 先写顶层键，再写 provider 表。
	lines = setTopLevelKey(lines, "model", selection.modelId.trim());
	lines = setTopLevelKey(lines, "model_provider", OPENCODE_GO_PROVIDER);
	if (selection.reasoningEffort !== undefined) {
		lines = setTopLevelKey(lines, "model_reasoning_effort", selection.reasoningEffort);
	}
	if (selection.catalogFileName !== undefined) {
		lines = setTopLevelKey(lines, "model_catalog_json", selection.catalogFileName);
	}
	lines = setProviderSection(lines, {
		baseUrl: normalizeBaseUrl(selection.baseUrl ?? OPENCODE_GO_BASE_URL),
		envKey: selection.envKey,
		providerDisplayName: selection.providerDisplayName,
	});
	// 0.2.0 之前的版本会额外写一个 Responses API provider；现在已是累赘
	// （残留的 `wire_api = "chat"` 块还会让 Codex 报错）。
	lines = removeTableLines(lines, `model_providers.${LEGACY_OPENCODE_GO_RESPONSES_PROVIDER}`);
	lines = removeTableLines(lines, "model_providers.opencode-go-chat");

	return serializeTomlText(lines, parsed.eol);
}

/**
 * Updates only the OpenCode Go provider block, leaving the top-level model and
 * model_provider untouched. The proxy toggle uses this so unrelated Codex
 * configuration is never rewritten.
 */
export function editProviderConfigText(text: string, patch: ProviderConfigPatch): string {
	const parsed = parseTomlText(text);
	const lines = setProviderSection(parsed.lines, patch);
	return serializeTomlText(lines, parsed.eol);
}

function setProviderSection(lines: string[], patch: ProviderConfigPatch): string[] {
	return ensureProviderSection(lines, OPENCODE_GO_PROVIDER, [
		["name", patch.providerDisplayName ?? "OpenCode Go"],
		["base_url", normalizeBaseUrl(patch.baseUrl)],
		["env_key", patch.envKey],
		["wire_api", "responses"],
	]);
}

/** 与 {@link removeTable} 相同，但直接操作已解析的行数组。 */
function removeTableLines(lines: string[], tableName: string): string[] {
	const range = findTableRanges(lines).find((r) => r.name === tableName);
	if (!range) {
		return lines;
	}
	const copy = [...lines];
	copy.splice(range.headerIndex, range.end - range.headerIndex);
	const before = range.headerIndex - 1;
	if (
		before >= 0 &&
		copy[before] !== undefined &&
		copy[before].trim() === "" &&
		(copy[before + 1] === undefined || copy[before + 1].trim() === "")
	) {
		copy.splice(before, 1);
	}
	return copy;
}

/**
 * 删除一个顶层键行（第一个表头之前的区域）。
 * 区块内的同名键绝不会被改动。键不存在时原样返回文本。
 */
export function removeTopLevelKey(text: string, key: string): string {
	const parsed = parseTomlText(text);
	const lines = [...parsed.lines];
	const limit = firstTableIndex(lines);
	const regex = keyLineRegex(key);
	for (let i = 0; i < limit; i++) {
		if (regex.test(lines[i])) {
			lines.splice(i, 1);
			return serializeTomlText(lines, parsed.eol);
		}
	}
	return text;
}

/**
 * 删除整个表区块（`[name]` 表头 + 正文），直到下一个表头（或文件末尾）。
 * 接缝处留下的连续空行会被合并，避免删完出现明显的空隙。
 * 区块不存在时原样返回文本。
 */
export function removeTable(text: string, tableName: string): string {
	const parsed = parseTomlText(text);
	const lines = [...parsed.lines];
	const range = findTableRanges(lines).find((r) => r.name === tableName);
	if (!range) {
		return text;
	}
	lines.splice(range.headerIndex, range.end - range.headerIndex);
	const before = range.headerIndex - 1;
	if (
		before >= 0 &&
		lines[before] !== undefined &&
		lines[before].trim() === "" &&
		(lines[before + 1] === undefined || lines[before + 1].trim() === "")
	) {
		lines.splice(before, 1);
	}
	return serializeTomlText(lines, parsed.eol);
}

/**
 * 读取一个顶层字符串键（只查第一个表头之前的区域）。返回去掉引号的值，
 * 不存在时返回 undefined。
 */
export function extractTopLevelValue(text: string, key: string): string | undefined {
	const { lines } = parseTomlText(text);
	const limit = firstTableIndex(lines);
	const regex = keyLineRegex(key);
	for (let i = 0; i < limit; i++) {
		if (!regex.test(lines[i])) {
			continue;
		}
		const { code } = stripComment(lines[i]);
		const eq = code.indexOf("=");
		if (eq < 0) {
			continue;
		}
		return unquoteTomlValue(code.slice(eq + 1).trim());
	}
	return undefined;
}

function unquoteTomlValue(raw: string): string | undefined {
	if (raw.startsWith('"')) {
		const match = raw.match(/^"((?:[^"\\]|\\.)*)"/);
		if (!match) {
			return undefined;
		}
		return match[1].replace(/\\(["\\])/g, "$1");
	}
	if (raw.startsWith("'")) {
		const match = raw.match(/^'([^']*)'/);
		return match ? match[1] : undefined;
	}
	const bare = raw.split(/\s/)[0];
	return bare.length > 0 ? bare : undefined;
}
