/**
 * API 密钥管理。
 *
 * 有两个使用方、两处存放位置，这是「配置 Codex」类扩展的核心陷阱：
 *
 * 1. 扩展自身用密钥拉取实时模型列表：优先取 VS Code SecretStorage，
 *    密钥不存在时退回 `env_key` 指定的环境变量。
 * 2. CODEX 通过 provider `env_key` 字段指定的环境变量完成认证。只存在
 *    SecretStorage 里的密钥对 Codex 不可见，因此命令流程总会给出两个
 *    选择：(a) 为 VS Code 终端设置该变量，或 (b) 复制一条用户级设置命令。
 */

import * as vscode from "vscode";
import { l10n, l10nFormat } from "./localize";
import { logger } from "./logger";
import { DEFAULT_ENV_KEY_NAME } from "./codexConfigFile";

export const SECRET_KEY = "codexgo.apiKey";

export interface ApiKeyContext {
	secrets: vscode.SecretStorage;
	environmentVariableCollection: vscode.EnvironmentVariableCollection;
}

/** 写入 `env_key` 的环境变量名（设置项 `codexgo.apiKeyEnvVar`）。 */
export function getEnvKeyName(): string {
	const raw = vscode.workspace.getConfiguration("codexgo").get<string>("apiKeyEnvVar", DEFAULT_ENV_KEY_NAME);
	const trimmed = raw?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ENV_KEY_NAME;
}

export interface ResolvedApiKey {
	key?: string;
	source: "secret" | "env" | "none";
}

/** 解析扩展自身请求所用的 API 密钥：优先 SecretStorage，其次环境变量。 */
export async function resolveApiKey(secrets: vscode.SecretStorage): Promise<ResolvedApiKey> {
	const secret = (await secrets.get(SECRET_KEY))?.trim();
	if (secret) {
		return { key: secret, source: "secret" };
	}
	const env = process.env[getEnvKeyName()]?.trim();
	if (env) {
		return { key: env, source: "env" };
	}
	return { source: "none" };
}

/** `codexgo.setApiKey`：保存、更新或清除密钥，再帮用户让 Codex 也能读到它。 */
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
		return; // 用户取消
	}
	const trimmed = entered.trim();
	if (!trimmed) {
		await ctx.secrets.delete(SECRET_KEY);
		vscode.window.showInformationMessage(l10n("OpenCode Go API key cleared."));
		return;
	}
	await ctx.secrets.store(SECRET_KEY, trimmed);
	logger.info("apiKey.saved", {});

	const setForTerminals = l10n("Set for VS Code Terminals");
	const copyCommand = l10n("Copy Environment Setup Command");
	const picked = await vscode.window.showInformationMessage(
		l10n("OpenCode Go API key saved."),
		setForTerminals,
		copyCommand,
	);
	if (picked === setForTerminals) {
		const name = getEnvKeyName();
		ctx.environmentVariableCollection.replace(name, trimmed);
		vscode.window.showInformationMessage(
			l10nFormat(
				"Environment variable {0} set for this workspace's VS Code terminals. Restart terminals to apply it. Note: the Codex extension process reads a user-level environment variable — see the README.",
				name,
			),
		);
	} else if (picked === copyCommand) {
		await copyEnvSetupCommand(ctx.secrets);
	}
}

/** `codexgo.getApiKey`：打开 OpenCode 授权页面以创建或复制密钥。 */
export function getApiKeyLinkCommand(): void {
	void vscode.env.openExternal(vscode.Uri.parse("https://opencode.ai/auth"));
}

/** 复制一条用户级环境变量的设置命令（有已保存的密钥时一并带上）。 */
export async function copyEnvSetupCommand(secrets: vscode.SecretStorage): Promise<void> {
	const name = getEnvKeyName();
	const key = (await secrets.get(SECRET_KEY))?.trim();
	const command = buildEnvSetupCommand(name, key);
	try {
		await vscode.env.clipboard.writeText(command);
		vscode.window.showInformationMessage(
			l10nFormat("Copied. Paste it into a terminal, then restart VS Code so Codex can read {0}.", name),
		);
	} catch (err) {
		logger.warn("apiKey.copy.failed", { error: err instanceof Error ? err.message : String(err) });
	}
}

/**
 * 模态提示：解释这个环境变量为什么重要，并提供一键复制设置命令的入口。
 */
export async function showEnvSetupHelp(ctx: ApiKeyContext): Promise<void> {
	const name = getEnvKeyName();
	const key = (await ctx.secrets.get(SECRET_KEY))?.trim();
	const command = buildEnvSetupCommand(name, key);
	const copySetup = l10n("Copy Setup Command");
	const picked = await vscode.window.showInformationMessage(
		l10n("Codex reads the API key from an environment variable"),
		{
			modal: true,
			detail: l10nFormat(
				"Codex resolves {0} from its own process environment, so a key stored only in VS Code's SecretStorage is not enough. Set a user-level environment variable and restart VS Code:\n\n{1}\n\nAlternatively, use “Set for VS Code Terminals” for terminals started by VS Code (the Codex extension process itself still needs the user-level variable).",
				name,
				command,
			),
		},
		copySetup,
	);
	if (picked === copySetup) {
		try {
			await vscode.env.clipboard.writeText(command);
			vscode.window.showInformationMessage(
				l10nFormat("Copied. Paste it into a terminal, then restart VS Code so Codex can read {0}.", name),
			);
		} catch (err) {
			logger.warn("apiKey.copy.failed", { error: err instanceof Error ? err.message : String(err) });
		}
	}
}

function buildEnvSetupCommand(name: string, key: string | undefined): string {
	const value = key ?? "<YOUR_API_KEY>";
	if (process.platform === "win32") {
		return `setx ${name} "${value}"`;
	}
	return `echo 'export ${name}="${value}"' >> ~/.zshrc   # then restart your shell`;
}
