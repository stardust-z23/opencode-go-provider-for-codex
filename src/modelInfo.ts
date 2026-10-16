/**
 * 纯函数的模型列表构建与解析工具。
 *
 * 刻意不引入 `vscode`，因此合并逻辑可以直接在纯 Node 下做单元测试
 * （见 scripts/test-model-merge.mjs）。
 *
 * 数据流（沿用 OpenCode Go Provider for Copilot 的两层设计，按 Codex 的
 * 需要做了裁剪）：
 *
 *   1. 有实时 API 列表时以它为准（反映账号套餐实际提供的模型），否则用
 *      models.dev 目录，再否则用内置快照。
 *   2. 每个模型的元数据（协议、上下文、价格、推理、视觉、弃用状态）按字段
 *      合并：内置表 → 目录。
 */

import { HARDCODED_GO_MODELS } from "./hardcodedModels";
import type { WireApi } from "./tomlEdit";

export interface ModelCost {
	input?: number;
	output?: number;
	cacheRead?: number;
}

/** 列表中的模型 ID 来自哪里。 */
export type ModelListSource = "api" | "catalog" | "hardcoded";

export interface ModelInfo {
	/** OpenCode Go 实际提供的模型 ID。 */
	id: string;
	/** 可读名称（目录名称 → 内置名称 → ID）。 */
	name: string;
	/** 上游协议。 */
	wireApi: WireApi;
	/** Codex 兼容的协议（除 Anthropic Messages 之外的都算）。 */
	supported: boolean;
	/** 协议只能靠推测时（未知模型）为 false。 */
	protocolKnown: boolean;
	free: boolean;
	deprecated: boolean;
	vision?: boolean;
	reasoning?: boolean;
	/** 目录声明的推理强度取值（如果有）。 */
	efforts?: string[];
	contextLength?: number;
	cost?: ModelCost;
	source: ModelListSource;
}

/** 从目录解析出的单模型元数据（已按 provider → 全局合并）。 */
export interface CatalogFacts {
	name?: string;
	contextLength?: number;
	reasoning?: boolean;
	efforts?: string[];
	vision?: boolean;
	deprecated?: boolean;
	cost?: ModelCost;
	/** 由目录的适配器包 / 家族启发式推导出的协议。 */
	wireApi?: WireApi;
	/** 目录明确识别出适配器包时为 true。 */
	protocolKnown?: boolean;
}

/**
 * 从未知的 `/models` 响应载荷中提取模型 ID。
 * 刻意写得宽容（OpenAI 列表结构、裸数组、`models` 键、纯字符串），上游
 * 改了结构也绝不能把扩展搞崩。
 */
export function extractModelIds(data: unknown): string[] {
	const out: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string") {
			const id = value.trim();
			if (id) {
				out.push(id);
			}
		} else if (value !== null && typeof value === "object") {
			const id = (value as { id?: unknown }).id;
			if (typeof id === "string" && id.trim()) {
				out.push(id.trim());
			}
		}
	};
	if (Array.isArray(data)) {
		data.forEach(push);
	} else if (data !== null && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		const array = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : undefined;
		if (array) {
			array.forEach(push);
		}
	}
	return [...new Set(out)];
}

/**
 * 构建最终模型列表。
 *
 * @param apiIds 实时 API 的模型 ID；不可用时为 undefined。空数组同样按
 *               不可用处理（与参考实现一致：空列表说明拉取失败，而不是
 *               「该套餐没有模型」）。
 * @param catalogFacts 单模型目录元数据的查询函数。
 * @param catalogIds `opencode-go` 目录 provider 提供的模型 ID。
 */
export function buildModelList(
	apiIds: string[] | undefined,
	catalogFacts: (id: string) => CatalogFacts | undefined,
	catalogIds: readonly string[],
): ModelInfo[] {
	const hardcodedById = new Map(HARDCODED_GO_MODELS.map((m) => [m.id, m]));

	let ids: string[];
	let source: ModelListSource;
	if (apiIds && apiIds.length > 0) {
		ids = apiIds;
		source = "api";
	} else if (catalogIds.length > 0) {
		ids = [...catalogIds];
		source = "catalog";
	} else {
		ids = HARDCODED_GO_MODELS.map((m) => m.id);
		source = "hardcoded";
	}

	const seen = new Set<string>();
	const out: ModelInfo[] = [];
	for (const rawId of ids) {
		const id = rawId.trim();
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);

		const hard = hardcodedById.get(id);
		const facts = catalogFacts(id) ?? {};
		const wireApi: WireApi = hard?.wireApi ?? facts.wireApi ?? "chat";
		const zeroCost =
			facts.cost !== undefined && (facts.cost.input ?? 0) === 0 && (facts.cost.output ?? 0) === 0;

		out.push({
			id,
			name: facts.name ?? hard?.name ?? id,
			wireApi,
			supported: true,
			protocolKnown: hard !== undefined || facts.protocolKnown === true,
			free: hard?.free ?? zeroCost,
			deprecated: facts.deprecated === true,
			vision: facts.vision,
			reasoning: facts.reasoning,
			efforts: facts.efforts,
			contextLength: facts.contextLength,
			cost: facts.cost,
			source,
		});
	}
	return out;
}

/** 128000 → "128K"，1000000 → "1M"。 */
export function formatTokenCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) {
		return "0";
	}
	if (n >= 1_000_000) {
		return `${trimTrailingZero(Math.round((n / 1_000_000) * 10) / 10)}M`;
	}
	if (n >= 1_000) {
		return `${trimTrailingZero(Math.round((n / 1_000) * 10) / 10)}K`;
	}
	return String(n);
}

function trimTrailingZero(value: number): string {
	return value.toString().replace(/\.0$/, "");
}

/** 0.15 → "$0.15"。 */
export function formatPrice(n: number | undefined): string {
	return `$${(n ?? 0).toFixed(2)}`;
}
