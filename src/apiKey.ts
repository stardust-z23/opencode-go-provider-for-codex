/**
 * API key management.
 *
 * The upstream OpenCode Go key lives in VS Code SecretStorage. The ordinary
 * request path does not require a user-level environment variable: the local
 * proxy owns the upstream key, while Codex authenticates to the loopback
 * endpoint with a derived, low-value proxy token written into config.toml.
 *
 * The environment variable remains a one-time migration fallback for existing
 * installations and is copied into SecretStorage when first discovered.
 */

import * as vscode from "vscode";
import { l10n } from "./localize";
import { logger } from "./logger";
import { DEFAULT_ENV_KEY_NAME } from "./codexConfigFile";

export const SECRET_KEY = "codexgo.apiKey";

export interface ApiKeyContext {
	secrets: vscode.SecretStorage;
}

export interface ResolvedApiKey {
	key?: string;
	source: "secret" | "env" | "none";
}

/** Resolve the upstream API key: SecretStorage first, legacy env fallback second. */
export async function resolveApiKey(secrets: vscode.SecretStorage): Promise<ResolvedApiKey> {
	const secret = (await secrets.get(SECRET_KEY))?.trim();
	if (secret) {
		return { key: secret, source: "secret" };
	}
	const env = process.env[DEFAULT_ENV_KEY_NAME]?.trim();
	if (env) {
		return { key: env, source: "env" };
	}
	return { source: "none" };
}

/** Save, update, or clear the upstream OpenCode Go key in SecretStorage. */
export async function setApiKeyCommand(ctx: ApiKeyContext): Promise<void> {
	const existing = (await ctx.secrets.get(SECRET_KEY)) ?? "";
	const entered = await vscode.window.showInputBox({
		title: l10n("OpenCode Go API Key"),
		prompt: existing ? l10n("Update your OpenCode Go API key") : l10n("Enter your OpenCode Go API key"),
		ignoreFocusOut: true,
		password: true,
		value: existing,
	});
	if (entered === undefined) {
		return;
	}
	const trimmed = entered.trim();
	if (!trimmed) {
		await ctx.secrets.delete(SECRET_KEY);
		vscode.window.showInformationMessage(l10n("OpenCode Go API key cleared."));
		return;
	}
	await ctx.secrets.store(SECRET_KEY, trimmed);
	logger.info("apiKey.saved", {});
	vscode.window.showInformationMessage(l10n("OpenCode Go API key saved."));
}

/** Open the OpenCode authorization page to create or copy a key. */
export function getApiKeyLinkCommand(): void {
	void vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai/auth"));
}
