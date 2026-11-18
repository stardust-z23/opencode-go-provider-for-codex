/**
 * Codex `config.toml` 的文件层：位置解析、带时间戳的备份、备份清理、写入，
 * 以及读取当前选择。
 *
 * 刻意不引入 `vscode`，因此可以在纯 Node 下做单元测试（见
 * scripts/test-toml-edit.mjs）。带设置感知的门面位于 `codexConfig.ts`。
 *
 * 这里处理的陷阱：
 * - Codex 配置目录可能尚不存在 → 只在真正需要写入时才按需创建（绝不在启动
 *   时产生副作用）。
 * - `CODEX_HOME` 会改变配置目录位置；显式的扩展设置（作为 `override` 传入）
 *   优先于环境变量。
 * - 每次破坏性写入前都先复制一份带时间戳的旧文件；超出可配置上限的备份按
 *   最旧的先删。
 * - 内容完全相同时绝不重写（`changed: false`），因此重复应用同一选择不会产生
 *   多余的备份。
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { editConfigText, extractTopLevelValue, ModelSelection } from "./tomlEdit";

export {
	OPENCODE_GO_BASE_URL,
	OPENCODE_GO_PROVIDER,
	LEGACY_OPENCODE_GO_RESPONSES_PROVIDER,
	providerIdForWireApi,
} from "./tomlEdit";

/** 写入 provider `env_key` 字段的默认环境变量名。 */
export const DEFAULT_ENV_KEY_NAME = "OPENCODE_GO_API_KEY";

const BACKUP_PREFIX = "config.toml.bak-";

export interface CodexConfigLocation {
	home: string;
	configPath: string;
}

/**
 * 解析 Codex 配置位置，不读取 `vscode` 设置。
 * 顺序：显式 override → `CODEX_HOME` → `~/.codex`。
 */
export function resolveCodexConfigLocationSync(override?: string): CodexConfigLocation {
	const trimmed = override?.trim();
	const envHome = process.env.CODEX_HOME?.trim();
	const home =
		trimmed && trimmed.length > 0
			? trimmed
			: envHome && envHome.length > 0
				? envHome
				: path.join(os.homedir(), ".codex");
	return { home, configPath: path.join(home, "config.toml") };
}

export interface ApplyOptions {
	/** 最多保留的 `config.toml.bak-*` 文件数，默认 5。 */
	maxBackups?: number;
	/** 显式指定的位置（测试用）；默认为 {@link resolveCodexConfigLocationSync}。 */
	location?: CodexConfigLocation;
}

export interface ApplyResult {
	configPath: string;
	/** 配置文件原本不存在、本次新建时为 true。 */
	created: boolean;
	/** 文件已与请求的选择一致时为 false（不写入、不备份）。 */
	changed: boolean;
	/** 覆盖已有文件时，带时间戳备份的路径。 */
	backupPath?: string;
}

/**
 * 把模型选择写入 Codex 配置文件。
 * 缺失时创建配置目录与文件；改动已有文件前先备份；写完后清理旧备份。
 */
export async function applyModelSelection(selection: ModelSelection, options?: ApplyOptions): Promise<ApplyResult> {
	// 纯编辑：选择不合法会在任何磁盘操作之前抛错。
	return updateConfigText((text) => editConfigText(text, selection), options);
}

/**
 * 应用任意纯文本编辑，安全措施与写入选择时相同：内容没变就什么都不做，否则
 * 先做带时间戳的备份。
 */
export async function updateConfigText(
	mutate: (text: string) => string,
	options?: ApplyOptions,
): Promise<ApplyResult> {
	const location = options?.location ?? resolveCodexConfigLocationSync();

	const existing = await readConfigTextOrUndefined(location.configPath);
	const nextText = mutate(existing ?? "");

	if (existing !== undefined && nextText === existing) {
		return { configPath: location.configPath, created: false, changed: false };
	}

	await fs.mkdir(location.home, { recursive: true });

	let backupPath: string | undefined;
	if (existing !== undefined) {
		backupPath = await backupConfigFile(location.configPath);
	}
	await fs.writeFile(location.configPath, nextText, "utf8");
	await pruneBackups(location.home, options?.maxBackups ?? 5);
	return { configPath: location.configPath, created: existing === undefined, changed: true, backupPath };
}

async function readConfigTextOrUndefined(configPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(configPath, "utf8");
	} catch (err) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}
}

/** 读取当前配置文本（文件不存在时为 undefined）。 */
export async function readConfigText(location?: CodexConfigLocation): Promise<string | undefined> {
	const loc = location ?? resolveCodexConfigLocationSync();
	return readConfigTextOrUndefined(loc.configPath);
}

/** 还原此前读取的配置文本（用于回滚写坏的配置）。 */
export async function restoreConfigText(text: string, location?: CodexConfigLocation): Promise<void> {
	const loc = location ?? resolveCodexConfigLocationSync();
	await fs.mkdir(loc.home, { recursive: true });
	await fs.writeFile(loc.configPath, text, "utf8");
}

/** 把当前配置复制为 `config.toml.bak-<时间戳>` 并返回备份路径。 */
export async function backupConfigFile(configPath: string): Promise<string> {
	const stamp = formatTimestamp(new Date());
	let target = `${configPath}.bak-${stamp}`;
	let counter = 1;
	while (await pathExists(target)) {
		target = `${configPath}.bak-${stamp}-${counter++}`;
	}
	await fs.copyFile(configPath, target);
	return target;
}

/** 删除超出 `keep` 数量的最旧 `config.toml.bak-*` 文件，返回删除个数。 */
export async function pruneBackups(home: string, keep: number): Promise<number> {
	let removed = 0;
	try {
		const entries = await fs.readdir(home);
		const backups = entries
			.filter((name) => name.startsWith(BACKUP_PREFIX))
			// 时间戳命名字典序即时间序；反转后即为最新优先。
			.sort()
			.reverse();
		for (const name of backups.slice(Math.max(keep, 1))) {
			try {
				await fs.unlink(path.join(home, name));
				removed++;
			} catch {
				// 备份被占用或已不存在：继续处理下一个。
			}
		}
	} catch {
		// 目录不可读：没有可清理的内容。
	}
	return removed;
}

export interface CurrentSelection {
	modelId?: string;
	providerId?: string;
	reasoningEffort?: string;
}

/** 从配置文件读取顶层模型选择（尽力而为）。 */
export async function readCurrentSelection(location?: CodexConfigLocation): Promise<CurrentSelection> {
	const loc = location ?? resolveCodexConfigLocationSync();
	const text = await readConfigTextOrUndefined(loc.configPath);
	if (text === undefined) {
		return {};
	}
	return {
		modelId: extractTopLevelValue(text, "model"),
		providerId: extractTopLevelValue(text, "model_provider"),
		reasoningEffort: extractTopLevelValue(text, "model_reasoning_effort"),
	};
}

function formatTimestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

function isEnoent(err: unknown): boolean {
	return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}
