/**
 * Built-in snapshot of the OpenCode Go model endpoint table.
 *
 * This mirrors the official mapping at https://opencode.ai/docs/go/#endpoints.
 * Models that the official table serves over /chat/completions are marked as
 * "chat"; the extension's local proxy bridges them to Codex's Responses API.
 */

import type { WireApi } from "./tomlEdit";

export interface HardcodedModel {
	id: string;
	name: string;
	wireApi: WireApi;
	/** Free for a limited time. */
	free?: boolean;
}

export const HARDCODED_GO_MODELS: readonly HardcodedModel[] = [
	// Responses API (official: @ai-sdk/openai)
	{ id: "grok-4.7", name: "Grok 4.7", wireApi: "responses" },
	{ id: "grok-4.6", name: "Grok 4.6", wireApi: "responses" },
	{ id: "gpt-6-luna", name: "GPT 6 Luna", wireApi: "responses" },
	{ id: "gpt-5.6-luna", name: "GPT 5.6 Luna", wireApi: "responses" },
	{ id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor", wireApi: "responses" },
	{ id: "muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor", wireApi: "responses" },

	// Anthropic Messages (official: @ai-sdk/anthropic)
	{ id: "claude-haiku-5-5", name: "Claude Haiku 5.5", wireApi: "anthropic" },
	{ id: "minimax-m3", name: "MiniMax M3", wireApi: "anthropic" },
	{ id: "minimax-m2.7", name: "MiniMax M2.7", wireApi: "anthropic" },
	{ id: "qwen3.8-max", name: "Qwen3.8 Max", wireApi: "anthropic" },
	{ id: "qwen3.8-flash", name: "Qwen3.8 Flash", wireApi: "anthropic" },
	{ id: "qwen3.7-plus", name: "Qwen3.7 Plus", wireApi: "anthropic" },

	// Chat Completions (official: @ai-sdk/openai-compatible)
	{ id: "glm-5.3-flash", name: "GLM-5.3-Flash", wireApi: "chat" },
	{ id: "glm-5.3", name: "GLM-5.3", wireApi: "chat" },
	{ id: "glm-5.2", name: "GLM-5.2", wireApi: "chat" },
	{ id: "kimi-k3", name: "Kimi K3", wireApi: "chat" },
	{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code", wireApi: "chat" },
	{ id: "kimi-k2.6", name: "Kimi K2.6", wireApi: "chat" },
	{ id: "longcat-2.0", name: "LongCat-2.0", wireApi: "chat" },
	{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", wireApi: "chat" },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", wireApi: "chat" },
	{ id: "mimo-v2.6-flash", name: "MiMo-V2.6-Flash", wireApi: "chat" },
	{ id: "mimo-v2.6-pro", name: "MiMo-V2.6-Pro", wireApi: "chat" },
	{ id: "mimo-v2.5", name: "MiMo-V2.5", wireApi: "chat" },
	{ id: "mimo-v2.5-pro", name: "MiMo-V2.5-Pro", wireApi: "chat" },
	{ id: "hy4-preview", name: "Hy4 preview", wireApi: "chat" },
	{ id: "hy3", name: "Hy3", wireApi: "chat" },
	{ id: "space-bunny", name: "Space Bunny", wireApi: "chat" },
	{ id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free", wireApi: "chat", free: true },
	{ id: "step-5-preview-free", name: "Step 5 Preview Free", wireApi: "chat", free: true },
	{ id: "cat-jam-free", name: "Cat Jam Free", wireApi: "chat", free: true },

	// Legacy aliases kept for cached model lists and older sessions.
	{ id: "deepseek-flash", name: "DeepSeek Flash", wireApi: "chat" },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", wireApi: "chat" },
	{ id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", wireApi: "chat" },
];
