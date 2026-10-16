/**
 * 带设置感知的 `codexConfigFile` 门面（后者保持不依赖 `vscode` 以便单测）。
 * 所有 VS Code 配置读取都集中在这里。
 */

import * as vscode from "vscode";
import { l10n, l10nFormat } from "./localize";
import { getEnvKeyName } from "./apiKey";
import {
	applyModelSelection,
	ApplyResult,
	CodexConfigLocation,
	CurrentSelection,
	readCurrentSelection,
	resolveCodexConfigLocationSync,
	updateConfigText,
} from "./codexConfigFile";
import { editProviderConfigText, ModelSelection } from "./tomlEdit";

/** 解析 Codex 配置位置：设置项 → `CODEX_HOME` → `~/.codex`。 */
export function getConfigLocation(): CodexConfigLocation {
	const override = vscode.workspace.getConfiguration("codexgo").get<string>("codexHome", "");
	return resolveCodexConfigLocationSync(override);
}

/** 备份保留上限（设置项 `codexgo.maxBackups`，限制在 1–50 之间）。 */
export function getMaxBackups(): number {
	const raw = vscode.workspace.getConfiguration("codexgo").get<number>("maxBackups", 5);
	return Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.trunc(raw))) : 5;
}

/** 把模型选择写入 Codex 配置（先备份，再精确编辑）。 */
export async function applySelection(selection: ModelSelection): Promise<ApplyResult> {
	return applyModelSelection(selection, {
		maxBackups: getMaxBackups(),
		location: getConfigLocation(),
	});
}

/** 只更新 OpenCode Go provider 的 base URL（本地代理开关使用）。 */
export async function applyProviderEndpoint(baseUrl: string): Promise<ApplyResult> {
	return updateConfigText(
		(text) =>
			editProviderConfigText(text, {
				baseUrl,
				envKey: getEnvKeyName(),
			}),
		{
			maxBackups: getMaxBackups(),
			location: getConfigLocation(),
		},
	);
}

/** 读取当前配置的顶层模型选择。 */
export async function readCurrent(): Promise<CurrentSelection> {
	return readCurrentSelection(getConfigLocation());
}

/**
 * 在编辑器中打开 Codex 配置文件。
 * 省略 `configPath`（命令方式调用）且文件尚不存在时，给出「请先选择模型」
 * 的友好提示。
 */
export async function openCodexConfigFile(configPath?: string): Promise<void> {
	const target = configPath ?? getConfigLocation().configPath;
	if (!(await fileExists(target))) {
		if (configPath === undefined) {
			vscode.window.showInformationMessage(
				l10n("Codex config file not found. Select a model first — the file is created when you apply one."),
			);
		} else {
			vscode.window.showInformationMessage(l10nFormat("Codex config file not found: {0}", target));
		}
		return;
	}
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
	await vscode.window.showTextDocument(document);
}

async function fileExists(target: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(target));
		return true;
	} catch {
		return false;
	}
}
