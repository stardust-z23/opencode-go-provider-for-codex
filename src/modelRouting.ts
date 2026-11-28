/**
 * Claude Code model routing (pure functions, no `vscode` import).
 *
 * Claude Code sends whatever the `/model` picker row says, verbatim, plus a
 * local `[1m]` context marker it never expects an upstream to understand.
 * OpenCode Go accepts a single Messages endpoint for every text model, so the
 * proxy only has to answer three questions:
 *
 *   1. is this already an OpenCode Go model id? forward it unchanged;
 *   2. is it a Claude alias the user never mapped (`opus`, `sonnet`, ...)?
 *      rewrite it to the configured role model;
 *   3. otherwise forward it so the gateway reports the real error.
 *
 * Keeping this module free of `vscode` lets `scripts/test-model-routing.mjs`
 * run it in plain Node.
 */

import { PROTOCOL_LABELS } from "./protocolVariants";
import type { WireApi } from "./tomlEdit";

/** Role tiers Claude Code resolves through `ANTHROPIC_DEFAULT_*_MODEL`. */
export type ClaudeModelRole =
	| "opus"
	| "sonnet"
	| "haiku"
	| "fable"
	| "subagent"
	| "default";

/** Configured OpenCode Go model per Claude Code role. Empty strings are unset. */
export interface RoleModelMap {
	opus?: string;
	sonnet?: string;
	haiku?: string;
	fable?: string;
	subagent?: string;
	default?: string;
}

export type MessagesModelSource =
	/** The id is an OpenCode Go model; forwarded unchanged. */
	| "known"
	/** A Claude alias rewritten to the configured role model. */
	| "role"
	/** An unrecognised Claude id rewritten to the configured default model. */
	| "default"
	/** Unknown id forwarded unchanged so the gateway reports it. */
	| "passthrough";

export interface MessagesModelDecision {
	/** Model id sent to OpenCode Go. */
	upstreamModelId: string;
	/** Model id exactly as Claude Code sent it. */
	requestedModelId: string;
	/** Requested id with any `[1m]` marker removed. */
	normalizedModelId: string;
	role?: ClaudeModelRole;
	source: MessagesModelSource;
	/** The client attached a `[1m]` context marker. */
	strippedOneMillion: boolean;
}

/** Tokens Claude Code assumes for a 1M-context model. */
export const ONE_MILLION_TOKENS = 1_000_000;

const ONE_MILLION_SUFFIX = /\s*\[\s*1\s*m\s*\]\s*$/i;

/** Remove Claude Code's local `[1m]`/`[1M]` context marker. */
export function stripOneMillionMarker(modelId: string): {
	id: string;
	stripped: boolean;
} {
	const trimmed = modelId.trim();
	if (!ONE_MILLION_SUFFIX.test(trimmed)) {
		return { id: trimmed, stripped: false };
	}
	return { id: trimmed.replace(ONE_MILLION_SUFFIX, "").trim(), stripped: true };
}

/**
 * Detect the Claude Code role a model id belongs to.
 *
 * Order matters: `fable` is checked before `opus` because an unmapped Fable
 * tier falls back to Opus, and the checks are intentionally substring based so
 * `claude-opus-4-8`, `anthropic/claude-opus-4-8[1m]` and
 * `us.anthropic.claude-3-5-sonnet-v1:0` all match.
 */
export function claudeRoleForModel(modelId: string): ClaudeModelRole | undefined {
	const normalized = modelId.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (normalized === "default" || normalized === "opusplan") {
		return "default";
	}
	if (normalized === "best") {
		return "opus";
	}
	if (normalized.includes("fable")) {
		return "fable";
	}
	if (normalized.includes("haiku")) {
		return "haiku";
	}
	if (normalized.includes("opus")) {
		return "opus";
	}
	if (normalized.includes("sonnet")) {
		return "sonnet";
	}
	return undefined;
}

/** Whether a model id looks like an Anthropic/Claude id rather than a gateway id. */
export function looksLikeClaudeModel(modelId: string): boolean {
	const normalized = modelId.trim().toLowerCase();
	return normalized.startsWith("claude") || normalized.includes("anthropic");
}

/**
 * Normalize a stored model id: drop the local `[1m]` marker and report the id
 * only when the catalog still serves it.
 *
 * Used to heal role keys that point at a model the account no longer has — a
 * takeover of a settings file configured for another provider otherwise leaves
 * `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash[1M]`, which the gateway
 * rejects with "isn't included in OpenCode Go".
 */
export function normalizeClaudeModelId(
	modelId: string | undefined,
	knownModelIds: Iterable<string>,
): string | undefined {
	const stripped = stripOneMillionMarker(modelId ?? "").id;
	if (!stripped) {
		return undefined;
	}
	for (const known of knownModelIds) {
		if (known === stripped) {
			return stripped;
		}
	}
	return undefined;
}

function configuredRoleModel(
	role: ClaudeModelRole,
	roles: RoleModelMap,
): string | undefined {
	const value = (model: string | undefined): string | undefined => {
		const trimmed = model?.trim();
		return trimmed ? trimmed : undefined;
	};
	switch (role) {
		case "fable":
			return value(roles.fable) ?? value(roles.opus) ?? value(roles.default);
		case "subagent":
			return value(roles.subagent) ?? value(roles.default);
		case "opus":
			return value(roles.opus) ?? value(roles.default);
		case "sonnet":
			return value(roles.sonnet) ?? value(roles.default);
		case "haiku":
			return value(roles.haiku) ?? value(roles.default);
		case "default":
			return value(roles.default);
		default:
			return undefined;
	}
}

export interface ResolveMessagesModelInput {
	requestedModelId: string;
	/** OpenCode Go model ids the account currently offers. */
	knownModelIds: Iterable<string>;
	roles: RoleModelMap;
}

/**
 * Decide which upstream model id a Claude Code request should use.
 *
 * A configured role model is always forwarded with its own `[1m]` marker
 * removed, so an operator may keep the marker in the setting for readability.
 */
export function resolveMessagesModel(
	input: ResolveMessagesModelInput,
): MessagesModelDecision {
	const requestedModelId = input.requestedModelId.trim();
	const stripped = stripOneMillionMarker(requestedModelId);
	const known = new Set(input.knownModelIds);

	if (stripped.id && known.has(stripped.id)) {
		return {
			upstreamModelId: stripped.id,
			requestedModelId,
			normalizedModelId: stripped.id,
			source: "known",
			strippedOneMillion: stripped.stripped,
		};
	}

	const role = claudeRoleForModel(stripped.id);
	if (role) {
		const mapped = configuredRoleModel(role, input.roles);
		if (mapped) {
			return {
				upstreamModelId: stripOneMillionMarker(mapped).id,
				requestedModelId,
				normalizedModelId: stripped.id,
				role,
				source: "role",
				strippedOneMillion: stripped.stripped,
			};
		}
		return {
			upstreamModelId: stripped.id,
			requestedModelId,
			normalizedModelId: stripped.id,
			role,
			source: "passthrough",
			strippedOneMillion: stripped.stripped,
		};
	}

	if (looksLikeClaudeModel(stripped.id)) {
		const fallback = configuredRoleModel("default", input.roles);
		if (fallback) {
			return {
				upstreamModelId: stripOneMillionMarker(fallback).id,
				requestedModelId,
				normalizedModelId: stripped.id,
				source: "default",
				strippedOneMillion: stripped.stripped,
			};
		}
	}

	return {
		upstreamModelId: stripped.id,
		requestedModelId,
		normalizedModelId: stripped.id,
		source: "passthrough",
		strippedOneMillion: stripped.stripped,
	};
}

/** Anthropic behaviour profile that best matches an OpenCode Go model. */
export type ClaudeProfileId =
	| "claude-opus-4-8"
	| "claude-sonnet-5-5";

/**
 * Pick the `behavesAs` profile for a model when the user opts in.
 *
 * This is a heuristic on purpose: `behavesAs` makes Claude Code apply a known
 * Claude model's capabilities and effort defaults, including its price display,
 * so it is never written unless the user asks for it (see
 * `codexgo.claudeCode.behavesAs`).
 */
export function suggestClaudeProfile(model: {
	efforts?: string[];
}): ClaudeProfileId {
	const efforts = model.efforts ?? [];
	return efforts.includes("max") || efforts.includes("xhigh")
		? "claude-opus-4-8"
		: "claude-sonnet-5-5";
}

/** `env` keys that carry Claude Code's model tiers, in display order. */
export const CLAUDE_TIER_ENV_KEYS = [
	{ key: "ANTHROPIC_MODEL", role: "default", label: "Default model" },
	{ key: "ANTHROPIC_DEFAULT_OPUS_MODEL", role: "opus", label: "Opus tier" },
	{ key: "ANTHROPIC_DEFAULT_SONNET_MODEL", role: "sonnet", label: "Sonnet tier" },
	{ key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", role: "haiku", label: "Haiku tier" },
	{ key: "ANTHROPIC_DEFAULT_FABLE_MODEL", role: "fable", label: "Fable tier" },
	{ key: "CLAUDE_CODE_SUBAGENT_MODEL", role: "subagent", label: "Subagent model" },
] as const satisfies ReadonlyArray<{
	key: string;
	role: ClaudeModelRole;
	label: string;
}>;

export interface ClaudeTierResolution {
	/** `env` key in `~/.claude/settings.json`. */
	key: string;
	role: ClaudeModelRole;
	label: string;
	/** Value written in the settings file, if any. */
	value?: string;
	/** Model the loopback proxy forwards upstream for this value. */
	upstreamModelId?: string;
	source: MessagesModelSource | "unset";
	/** A value is present but nothing in the catalog can serve it. */
	invalid: boolean;
}

/**
 * Resolve every Claude Code tier the way the proxy will at request time, so a
 * leftover value from another provider can be reported before it fails a
 * request with `isn't included in OpenCode Go`.
 *
 * An unset tier is not a problem: Claude Code then sends a Claude alias and the
 * proxy maps it through {@link resolveMessagesModel}.
 */
export function describeClaudeTiers(
	env: Record<string, unknown>,
	knownModelIds: Iterable<string>,
	roles: RoleModelMap,
): ClaudeTierResolution[] {
	const known = new Set(knownModelIds);
	return CLAUDE_TIER_ENV_KEYS.map(({ key, role, label }) => {
		const raw = typeof env[key] === "string" ? (env[key] as string).trim() : "";
		if (!raw) {
			return { key, role, label, source: "unset" as const, invalid: false };
		}
		const decision = resolveMessagesModel({
			requestedModelId: raw,
			knownModelIds: known,
			roles,
		});
		return {
			key,
			role,
			label,
			value: raw,
			upstreamModelId: decision.upstreamModelId || undefined,
			source: decision.source,
			invalid: decision.source === "passthrough",
		};
	});
}

/** Minimal model facts needed to build a Claude Code picker row. */
export interface PickerModelInput {
	id: string;
	name: string;
	contextLength?: number;
	wireApi?: WireApi;
	deprecated?: boolean;
}

export interface MessagesPickerRow {
	/** Model id Claude Code sends; 1M rows keep the local `[1m]` marker. */
	model: string;
	label: string;
	description: string;
}

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(2)}M`;
	}
	if (tokens >= 1000) {
		return `${Math.round(tokens / 1000)}K`;
	}
	return String(tokens);
}

/**
 * Build `/model` picker rows for Claude Code.
 *
 * 1M-context models carry the `[1m]` marker so Claude Code assumes the window
 * the catalog declares instead of overwriting it with the global
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` floor. Everything else stays a bare id and
 * is therefore capped by that floor.
 */
export function buildMessagesPickerRows(
	models: Iterable<PickerModelInput>,
): MessagesPickerRow[] {
	const rows: MessagesPickerRow[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		const id = model.id.trim();
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const oneMillion =
			typeof model.contextLength === "number" &&
			model.contextLength >= ONE_MILLION_TOKENS;
		const details: string[] = ["OpenCode Go"];
		if (typeof model.contextLength === "number" && model.contextLength > 0) {
			details.push(`${formatTokenCount(model.contextLength)} context`);
		}
		if (model.wireApi) {
			details.push(PROTOCOL_LABELS[model.wireApi]);
		}
		if (model.deprecated) {
			details.push("deprecated");
		}
		rows.push({
			model: oneMillion ? `${id}[1m]` : id,
			label: model.name.trim() || id,
			description: details.join(" · "),
		});
	}
	return rows;
}

/**
 * Smallest sub-1M context window across the exposed models, which is what
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` must be so those rows compact in time.
 * Returns undefined when every model is 1M or larger (nothing to cap).
 */
export function messagesContextFloor(
	models: Iterable<PickerModelInput>,
): number | undefined {
	let floor: number | undefined;
	for (const model of models) {
		const context = model.contextLength;
		if (typeof context !== "number" || context <= 0) {
			continue;
		}
		if (context >= ONE_MILLION_TOKENS) {
			continue;
		}
		if (floor === undefined || context < floor) {
			floor = context;
		}
	}
	return floor;
}
