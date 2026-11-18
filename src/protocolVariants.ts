import type { WireApi } from "./tomlEdit";

/**
 * Protocol aliases for models that OpenCode Go accepts on more than one
 * endpoint. The base model ID stays unchanged for backward compatibility;
 * aliases are additional catalog entries that the proxy maps back to the
 * base upstream model ID.
 */
export interface ProtocolAliasDefinition {
	baseId: string;
	wireApi: WireApi;
}

export interface ProtocolAlias extends ProtocolAliasDefinition {
	/** Model ID exposed to Codex. */
	id: string;
	/** Human-readable protocol label used in the picker. */
	label: string;
}

export const PROTOCOL_LABELS: Record<WireApi, string> = {
	responses: "Responses",
	chat: "Chat Completions",
	anthropic: "Anthropic Messages",
};

const DEEPSEEK_ALIASES: readonly ProtocolAliasDefinition[] = [
	{ baseId: "deepseek-v4.1-flash", wireApi: "responses" },
	{ baseId: "deepseek-v4.1-flash", wireApi: "anthropic" },
	{ baseId: "deepseek-v4-pro", wireApi: "responses" },
	{ baseId: "deepseek-v4-pro", wireApi: "anthropic" },
];

export const PROTOCOL_ALIASES: readonly ProtocolAlias[] = DEEPSEEK_ALIASES.map(
	(definition) => ({
		...definition,
		id: protocolAliasId(definition.baseId, definition.wireApi),
		label: protocolLabel(definition.wireApi),
	}),
);

/** Add the protocol suffix to a base model ID. */
export function protocolAliasId(baseId: string, wireApi: WireApi): string {
	return `${baseId}-${wireApi}`;
}

/** Look up all aliases defined for one upstream model. */
export function protocolAliasesForBase(baseId: string): readonly ProtocolAlias[] {
	return PROTOCOL_ALIASES.filter((alias) => alias.baseId === baseId);
}

/** Resolve a model ID exposed to Codex back to its upstream model and route. */
export function protocolAliasForId(id: string): ProtocolAlias | undefined {
	return PROTOCOL_ALIASES.find((alias) => alias.id === id);
}

export function protocolLabel(wireApi: WireApi): string {
	return PROTOCOL_LABELS[wireApi];
}
