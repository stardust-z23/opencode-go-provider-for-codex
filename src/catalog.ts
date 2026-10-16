/**
 * Codex 模型目录的生成。
 *
 * Codex 的**自带**模型选择器（CLI 的 `/model`、VS Code Codex 界面）由
 * app-server 的 `model/list` RPC 提供，而该 RPC 的数据来自内置目录或顶层
 * `model_catalog_json` 指向的文件。因此，写出这样一个文件就是把 OpenCode Go
 * 模型放进 Codex 选择器的方式。
 *
 * 结构说明（按 codex 0.162.0-alpha 实测）：
 * - 顶层是 `{"models": [...]}`；文件必须是 **无 BOM** 的 UTF-8（带 BOM 会以
 *   `expected value at line 1 column 1` 解析失败）。
 * - 一条目录条目约有 40 个字段，缺一个 Codex 就会拒绝整个配置（例如
 *   `missing field `shell_type``、`missing both `base_instructions` and
 *   `model_messages.instructions_template``）。因此我们克隆本机 Codex
 *   （`codex debug models`）里一条已知可用的条目，只覆盖模型相关字段。
 * - 模板是**第一方**条目（Codex 0.162 中第一条可用条目是 GPT-6 条目），
 *   而第一方条目会打开 OpenAI 专属传输方式。这些字段必须为第三方网关剥离，
 *   见 {@link applyThirdPartyTransport}。
 * - `model_catalog_json` 是**替换**内置列表而非追加，因此目录只用可用模型
 *   构建。
 *
 * 不引入 `vscode`：这里的一切都能在纯 Node 下做单元测试。
 */

import * as fs from "fs/promises";
import * as path from "path";

export const CATALOG_FILE_NAME = "opencode-go-models.json";

/**
 * Codex 接受的推理强度（含 `none`/`ultra`/`max`/`xhigh`；选择器界面只展示
 * 经典的四档）。
 */
export const CODEX_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const EFFORT_DESCRIPTIONS: Record<string, string> = {
	minimal: "Fastest responses with the least thinking.",
	low: "Fast responses with lighter reasoning.",
	medium: "Balances speed and reasoning depth for everyday tasks.",
	high: "Greater reasoning depth for complex problems.",
	xhigh: "Extra high reasoning depth for complex problems.",
	max: "Maximum reasoning depth for the hardest problems.",
	ultra: "Maximum reasoning with automatic task delegation.",
};

export interface CatalogReasoningLevel {
	effort: string;
	description: string;
}

/** 目录需要的 `ModelInfo` 子集（让本模块保持零依赖）。 */
export interface CatalogSourceModel {
	id: string;
	name: string;
	description?: string;
	contextLength?: number;
	vision?: boolean;
	efforts?: string[];
}

export type CatalogEntry = Record<string, unknown>;

/**
 * 只有 OpenAI 自家后端才认识的目录字段。
 *
 * `tool_mode: "code_mode_only"` 会把真实工具集换成单个自由格式的 JavaScript
 * `exec` 工具，而 `multi_agent_*` / `node_repl_*` 则用于开启第三方网关并不
 * 提供的工具能力。删掉它们就回到经典 Responses 传输，也就是 OpenCode Go
 * 能听懂的那套。
 */
const FIRST_PARTY_ONLY_FIELDS = [
	"tool_mode",
	"multi_agent_version",
	"multi_agent_reasoning_effort",
	"node_repl_auto_review_required",
	"node_repl_disabled",
] as const;

/**
 * 把克隆来的模板条目改造成第三方 Responses 网关真正能用的样子。
 *
 * 在 Codex 0.162 上实测：`use_responses_lite: true` 时工具定义**不会**出现在
 * 请求顶层的 `tools` 数组里，而是被搬进 `additional_tools` 输入项，只有
 * OpenAI 自家后端会读它。OpenCode Go 会直接忽略，于是模型一个工具都收不到，
 * 只能输出纯文本（DeepSeek 甚至会把原始的 `<|tool_calls|>` 标记泄漏进正文）。
 * 把该标志置为 `false` 就能让工具回到网关期望的位置。清空
 * `experimental_supported_tools` 是同样的道理：它会声明
 * `send_user_message_async` 这类第一方专属工具。
 *
 * 只有模板里存在这些键时才会改动，因此早于这些字段的 Codex 版本生成的条目
 * 会保持原样。
 */
export function applyThirdPartyTransport(entry: CatalogEntry): void {
	if ("use_responses_lite" in entry) {
		entry.use_responses_lite = false;
	}
	if ("experimental_supported_tools" in entry) {
		entry.experimental_supported_tools = [];
	}
	for (const key of FIRST_PARTY_ONLY_FIELDS) {
		delete entry[key];
	}
}

/**
 * 克隆 `template`（本机 Codex 的真实条目）并覆盖具体模型相关字段，生成目录条目。
 */
export function buildCatalogEntries(
	models: readonly CatalogSourceModel[],
	template: CatalogEntry,
): CatalogEntry[] {
	return models.map((model, index) => {
		const entry: CatalogEntry = JSON.parse(JSON.stringify(template)) as CatalogEntry;
		const levels = resolveReasoningLevels(model, template);
		applyThirdPartyTransport(entry);

		entry.slug = model.id;
		entry.display_name = model.name;
		entry.description = model.description?.trim() || `${model.name} (OpenCode Go)`;
		entry.supported_reasoning_levels = levels;
		entry.default_reasoning_level = resolveDefaultLevel(template, levels);
		entry.priority = index + 1;
		entry.visibility = "list";
		entry.supported_in_api = true;
		entry.input_modalities = model.vision ? ["text", "image"] : ["text"];
		if (model.vision === false) {
			entry.supports_image_detail_original = false;
		}
		if (typeof model.contextLength === "number" && model.contextLength > 0) {
			entry.context_window = model.contextLength;
			entry.max_context_window = model.contextLength;
		}
		return entry;
	});
}

/** 声明过的推理强度，过滤到 Codex 接受的范围；模型未声明时用模板的列表。 */
export function resolveReasoningLevels(
	model: CatalogSourceModel,
	template: CatalogEntry,
): CatalogReasoningLevel[] {
	const templateLevels = template.supported_reasoning_levels;
	const templateDescriptions = new Map<string, string>();
	if (Array.isArray(templateLevels)) {
		for (const level of templateLevels as Array<Record<string, unknown>>) {
			const effort = level?.effort;
			const description = level?.description;
			if (typeof effort === "string" && typeof description === "string") {
				templateDescriptions.set(effort, description);
			}
		}
	}

	const declared = (model.efforts ?? []).filter((effort) => CODEX_EFFORT_VALUES.includes(effort));
	const ordered = CODEX_EFFORT_VALUES.filter((effort) => declared.includes(effort));
	if (ordered.length === 0) {
		return Array.isArray(templateLevels) ? (templateLevels as CatalogReasoningLevel[]) : [];
	}
	return ordered.map((effort) => ({
		effort,
		description: templateDescriptions.get(effort) ?? EFFORT_DESCRIPTIONS[effort] ?? effort,
	}));
}

function resolveDefaultLevel(template: CatalogEntry, levels: CatalogReasoningLevel[]): string {
	const templateDefault = template.default_reasoning_level;
	if (typeof templateDefault === "string" && levels.some((l) => l.effort === templateDefault)) {
		return templateDefault;
	}
	return levels[0]?.effort ?? (typeof templateDefault === "string" ? templateDefault : "medium");
}

/** 按 Codex 期望的格式序列化目录（2 空格缩进 JSON，末尾换行）。 */
export function serializeCatalog(entries: readonly CatalogEntry[]): string {
	return `${JSON.stringify({ models: entries }, null, 2)}\n`;
}

/**
 * 写入目录文件（UTF-8、无 BOM、原子替换）。
 * 内容完全相同时返回 false，这样重复同步不会碰文件，也不会白白要求重启
 * Codex。
 */
export async function writeCatalogFile(filePath: string, text: string): Promise<boolean> {
	const existing = await readCatalogFile(filePath);
	if (existing === text) {
		return false;
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.tmp`;
	await fs.writeFile(temp, text, "utf8");
	await fs.rename(temp, filePath);
	return true;
}

export async function readCatalogFile(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}
}

/** 删除目录文件；文件不存在不算错误。 */
export async function removeCatalogFile(filePath: string): Promise<boolean> {
	try {
		await fs.unlink(filePath);
		return true;
	} catch (err) {
		if (isEnoent(err)) {
			return false;
		}
		throw err;
	}
}

/** 还原此前读取的目录内容（回滚）；`undefined` 表示删除文件。 */
export async function restoreCatalogFile(filePath: string, text: string | undefined): Promise<void> {
	if (text === undefined) {
		await removeCatalogFile(filePath);
		return;
	}
	await writeCatalogFile(filePath, text);
}

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}
